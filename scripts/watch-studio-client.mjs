import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateStudioClient } from "./generate-studio-client.mjs";

// `tsc --watch` never emits the Studio browser bundle. tsconfig excludes the
// browser entry so a compile cannot overwrite the generator's output. Rebuild
// when a file in that bundle's runtime import closure changes.

const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDebounceMs = 50;
const clientEntry = "src/studio/run-store-ui-client-browser.ts";
const browserBundle = "dist/studio/run-store-ui-client-browser.js";
const cloudflareBundle = "dist/cloudflare/cloudflare-studio-client.js";

/** Files Bun bundles into the Studio client, following relative value imports. */
export function studioClientSources(packageRoot = defaultPackageRoot) {
  const srcRoot = `${resolve(packageRoot, "src")}${sep}`;
  const sources = new Set();
  const visited = new Set();
  const queue = [resolve(packageRoot, clientEntry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file) || !file.startsWith(srcRoot)) continue;
    visited.add(file);
    if (isTestFile(file) || !existsSync(file)) continue;
    sources.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const next = resolveRuntimeSpecifier(file, specifier);
      if (next) queue.push(next);
    }
  }
  return sources;
}

/** Rebuild the Studio client when one of its sources changes. */
export function startStudioClientWatch({
  packageRoot = defaultPackageRoot,
  generate = generateStudioClient,
  debounceMs = defaultDebounceMs,
} = {}) {
  let sources = studioClientSources(packageRoot);
  let timer;
  let running = false;
  let queued = false;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void rebuild();
    }, debounceMs);
  };

  const rebuild = async () => {
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await generate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    } finally {
      running = false;
      if (queued && !closed) {
        queued = false;
        void rebuild();
      }
    }
  };

  const onChange = (file) => {
    if (closed) return;
    const previous = sources;
    try {
      sources = studioClientSources(packageRoot);
    } catch {
      // The file can disappear between the existence check and the read.
      schedule();
      return;
    }
    if (file !== undefined && !previous.has(file) && !sources.has(file)) return;
    schedule();
  };

  const stop = openWatch(resolve(packageRoot, "src"), onChange);
  if (
    !existsSync(resolve(packageRoot, browserBundle)) ||
    !existsSync(resolve(packageRoot, cloudflareBundle))
  ) {
    schedule();
  }

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      stop();
    },
  };
}

function isTestFile(file) {
  return /\.test\.tsx?$/.test(file);
}

function resolveRuntimeSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(fromFile), specifier);
  const stem = target.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  const candidates = [`${stem}.ts`, `${stem}.tsx`];
  if (stem === target) candidates.push(join(target, "index.ts"), join(target, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate));
}

function runtimeSpecifiers(source) {
  const cleaned = stripComments(source);
  const specifiers = [];
  for (const match of cleaned.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)) {
    const fromIndex = match.index ?? 0;
    const head = cleaned.slice(cleaned.lastIndexOf(";", fromIndex) + 1, fromIndex);
    if (isRuntimeEdge(head)) specifiers.push(match[1]);
  }
  for (const match of cleaned.matchAll(/(?:^|[;\n])\s*import\s+["'](\.[^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  for (const match of cleaned.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** `import type` and `{ type X }` are erased and are not bundle edges. */
function isRuntimeEdge(head) {
  const trimmed = head.trim();
  if (!/^(?:import|export)\b/.test(trimmed)) return false;
  if (/^(?:import|export)\s+type\b/.test(trimmed)) return false;
  const braces = /\{([\s\S]*)\}/.exec(trimmed);
  const withoutBraces = trimmed.replace(/\{[\s\S]*\}/, "");
  if (/^(?:import|export)\s+(?:\*\s+as\s+[\w$]+|[\w$]+)/.test(withoutBraces)) return true;
  if (!braces) return true;
  return braces[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => !/^type\b/.test(part));
}

function stripComments(source) {
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char !== '"' && char !== "'" && char !== "`") {
      out += char;
      continue;
    }
    out += char;
    index += 1;
    while (index < source.length) {
      const current = source[index];
      out += current;
      if (current === "\\") {
        index += 1;
        if (index < source.length) out += source[index];
      } else if (current === char) break;
      index += 1;
    }
  }
  return out;
}

function openWatch(root, onChange) {
  const watchers = [];
  const watchedDirs = new Set();
  let recursive = true;

  const deliver = (dir, filename) => {
    if (!filename) {
      onChange(undefined);
      return;
    }
    const changed = resolve(dir, filename);
    if (!recursive) watchNewDirectory(changed);
    onChange(changed);
  };

  try {
    watchers.push(arm(root, { recursive: true }, (filename) => deliver(root, filename)));
  } catch (error) {
    // Node's recursive fs.watch is missing on some Linux builds.
    if (error?.code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw error;
    recursive = false;
    watchDirectory(root);
  }

  return () => {
    for (const watcher of watchers) watcher.close();
  };

  function watchNewDirectory(path) {
    try {
      if (statSync(path).isDirectory()) watchDirectory(path);
    } catch {
      // The path can disappear between the event and the stat.
    }
  }

  function watchDirectory(dir) {
    if (watchedDirs.has(dir)) return;
    watchedDirs.add(dir);
    watchers.push(arm(dir, {}, (filename) => deliver(dir, filename)));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        watchDirectory(join(dir, entry.name));
      }
    }
  }
}

function arm(dir, options, onFilename) {
  const watcher = watch(dir, options, (_event, filename) => {
    onFilename(filename ?? undefined);
  });
  watcher.on("error", (error) => {
    process.stderr.write(`Studio client watch: ${error.message}\n`);
  });
  return watcher;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.stdout.write("Watching Studio client sources\n");
  startStudioClientWatch();
}
