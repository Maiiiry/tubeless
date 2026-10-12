import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This script is the only writer of the browser bundle. `tsconfig.json` excludes
// `src/studio/run-store-ui-client-browser.ts` so `tsc` never emits a competing
// module over that path — an unfiltered compile would overwrite the bundle with
// an importing stub and break the served Studio client.

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

const clientEntryPath = resolve(packageRoot, "src/studio/run-store-ui-client-browser.ts");
const browserBundlePath = resolve(packageRoot, "dist/studio/run-store-ui-client-browser.js");
const cloudflareClientPath = resolve(packageRoot, "dist/cloudflare/cloudflare-studio-client.js");
const cloudflareClientTypesPath = resolve(
  packageRoot,
  "dist/cloudflare/cloudflare-studio-client.d.ts"
);

/** The Workers entry cannot read files, so ship the same bundle as a string module. */
export function cloudflareClientModule(source) {
  return `export const PIPELINE_RUN_STUDIO_CLIENT = ${JSON.stringify(source)};\n`;
}

/** Keep compiled ESM intact for the inline module script. */
export function compiledClientSource(js) {
  const withoutMaps = js.replace(/^\uFEFF?\/\/# sourceMappingURL=.*\r?\n?/gm, "");
  if (/\bimport\s*(?:type\s+)?["'{*]/.test(withoutMaps) || /\bimport\s*\(/.test(withoutMaps)) {
    throw new Error("Compiled studio client still contains import; cannot inline.");
  }
  return `${withoutMaps.replace(/\s+$/u, "")}\n`;
}

async function bundledClientSource() {
  if (typeof Bun === "undefined") {
    throw new Error("Generate the Studio client with Bun: bun scripts/generate-studio-client.mjs");
  }
  const result = await Bun.build({
    entrypoints: [clientEntryPath],
    format: "esm",
    minify: true,
    target: "browser",
  });
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Studio client bundle failed.${details ? `\n${details}` : ""}`);
  }
  return compiledClientSource(await result.outputs[0].text());
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const source = await bundledClientSource();

  const outputs = [
    [browserBundlePath, source],
    [cloudflareClientPath, cloudflareClientModule(source)],
  ];

  if (check) {
    for (const [path, expected] of outputs) {
      const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (actual !== expected) {
        throw new Error(`Generated ${relative(packageRoot, path)} is stale. Run: bun run build`);
      }
    }
  } else {
    for (const [path, contents] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    writeFileSync(
      cloudflareClientTypesPath,
      "export declare const PIPELINE_RUN_STUDIO_CLIENT: string;\n"
    );
    rmSync(`${browserBundlePath}.map`, { force: true });
    process.stdout.write(`Generated ${relative(packageRoot, browserBundlePath)}\n`);
  }
}
