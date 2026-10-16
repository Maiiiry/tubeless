import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

// Inspect emitted JavaScript so type-only contracts do not create runtime edges.
// Include re-exports, side-effect imports and lazy imports in the graph.
function dependencies(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier));
}

function externalSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1]!)
    .filter((specifier) => !specifier.startsWith("."));
}

const allowedDependencies: Record<string, readonly string[]> = {
  agent: ["core", "tracing", "utilities"],
  core: ["tracing", "utilities"],
  tracing: [],
  utilities: [],
  node: [],
  reporter: ["core", "utilities"],
  render: ["core"],
  "run-store": ["core", "tracing", "utilities"],
  studio: ["run-store", "tracing"],
  cli: ["core", "node", "reporter", "utilities"],
  testing: ["core", "utilities"],
  project: ["core", "utilities"],
  hosting: ["cli", "core", "project", "render", "studio", "tracing", "utilities"],
  cloudflare: ["cli", "core", "hosting", "project", "run-store", "studio", "tracing", "utilities"],
  workbench: [
    "agent",
    "cli",
    "core",
    "hosting",
    "project",
    "render",
    "reporter",
    "run-store",
    "studio",
    "tracing",
    "utilities",
  ],
};

function moduleName(file: string): string {
  return relative(dist, file).split(sep)[0];
}

describe("module runtime boundaries", () => {
  it("keeps provider adapters out of the generic agent import graph", () => {
    const pending = [resolve(dist, "agent/agent.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(relative(dist, file)).not.toMatch(/openai|anthropic|provider-/);
      pending.push(...dependencies(file));
    }
    expect(visited.has(resolve(dist, "agent/model-agent.js"))).toBe(true);
    expect(visited.has(resolve(dist, "agent/compile-agent.js"))).toBe(true);
  });

  it("keeps ticker workers independent of reporter orchestration and worker creation", () => {
    const allowed = new Set([
      "reporter/live-ticker-worker.js",
      "reporter/live-ticker-frame.js",
      "reporter/live-ticker-protocol.js",
      "reporter/reporter.js",
      "reporter/terminal-text.js",
      "core/progress.js",
    ]);
    const pending = [resolve(dist, "reporter/live-ticker-worker.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Ticker worker reaches ${name}`).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBe(allowed.size);
  });

  it("keeps project registry validation independent of pipeline construction", () => {
    const allowed = new Set(["project/project-registry.js", "project/project-document.js"]);
    const pending = [resolve(dist, "project/project-registry.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Project registry validation reaches ${name}`).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBe(allowed.size);
  });

  it("keeps the Studio request pipeline, page and API free of Node built-ins", () => {
    const pending = [
      resolve(dist, "studio/run-store-ui-handler.js"),
      resolve(dist, "studio/run-store-ui-page.js"),
      resolve(dist, "studio/run-store-ui-api.js"),
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(externalSpecifiers(file), `${relative(dist, file)} imports a platform module`).toEqual(
        []
      );
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(3);
  });

  it("keeps history projection and Studio API routes free of execution, adapters and page assets", () => {
    const allowed = new Set([
      "core/pipeline-ids.js",
      "core/progress.js",
      "run-store/run-store.js",
      "run-store/run-projection.js",
      "run-store/agent-projection.js",
      "run-store/agent-history.js",
      "run-store/definition-projection.js",
      "run-store/run-store-reader.js",
      "run-store/run-history.js",
      "run-store/run-store-schema.js",
      "studio/run-store-ui-api.js",
      "studio/run-store-ui-http.js",
      "studio/run-store-ui-protocol.js",
      "studio/run-store-ui-state.js",
      "studio/run-store-ui-schema.js",
      "tracing/artifact-metadata.js",
      "tracing/graph-metadata.js",
      "tracing/tracing-schema.js",
      "tracing/tracing-constants.js",
      "tracing/wire-schema.js",
    ]);
    const pending = [
      resolve(dist, "studio/run-store-ui-api.js"),
      resolve(dist, "run-store/run-store.js"),
      resolve(dist, "run-store/agent-history.js"),
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `History/API boundary reaches ${name}`).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("keeps runtime dependencies acyclic, including lazy imports and re-exports", () => {
    const visited = new Set<string>();
    const active: string[] = [];
    const visit = (file: string): void => {
      const cycleStart = active.indexOf(file);
      if (cycleStart !== -1) {
        throw new Error(
          `Runtime import cycle: ${[...active.slice(cycleStart), file]
            .map((entry) => relative(dist, entry))
            .join(" -> ")}`
        );
      }
      if (visited.has(file)) return;
      visited.add(file);
      active.push(file);
      for (const dependency of dependencies(file)) visit(dependency);
      active.pop();
    };
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (name.endsWith(".js")) visit(resolve(dist, name));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("encapsulates execution errors and lifecycle emission below orchestration", () => {
    const contracts: Record<string, readonly string[]> = {
      "core/pipeline-execution-error.js": [
        "core/pipeline-diagnostics.js",
        "core/pipeline-step-metadata.js",
        "core/pipeline-validation.js",
        "utilities/abort.js",
        "utilities/tubeless-error.js",
      ],
      "core/lifecycle.js": ["core/step-log-scope.js", "tracing/tracing-internal.js"],
    };
    for (const [entry, allowed] of Object.entries(contracts)) {
      for (const dependency of dependencies(resolve(dist, entry))) {
        expect(allowed, `${entry} reaches ${relative(dist, dependency)}`).toContain(
          relative(dist, dependency).split(sep).join("/")
        );
      }
    }
    for (const name of readdirSync(resolve(dist, "core"))) {
      if (!name.endsWith(".js") || name === "lifecycle.js") continue;
      expect(
        dependencies(resolve(dist, "core", name)),
        `${name} bypasses lifecycle trace ownership`
      ).not.toContain(resolve(dist, "tracing/tracing-internal.js"));
    }
  });

  it("keeps project declarations independent of executable integrations", () => {
    const pending = [resolve(dist, "project/project.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(
        ["project", "core", "tracing", "utilities"].includes(moduleName(file)),
        `Project entrypoint reaches executable integration: ${relative(dist, file)}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("keeps Studio launch execution independent of command entrypoints and concrete adapters", () => {
    const pending = [resolve(dist, "workbench/workbench-studio-launcher.js")];
    const visited = new Set<string>();
    const workbenchInternals = new Set([
      "workbench/workbench-studio-launcher.js",
      "workbench/workbench-launch-session.js",
      "workbench/workbench-command-execution.js",
      "workbench/workbench-shared.js",
      "workbench/pipeline-module.js",
    ]);
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(
        ["cli", "core", "hosting", "node", "reporter", "render", "tracing", "utilities"].includes(
          moduleName(file)
        ) || workbenchInternals.has(name),
        `Studio launch execution reaches an entrypoint or concrete adapter: ${name}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("keeps the hosting kit free of workbench, storage adapters and the HTTP listener", () => {
    const pending = [resolve(dist, "hosting/hosting-commands.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(moduleName(file), `Hosting reaches ${name}`).not.toBe("workbench");
      expect(name).not.toMatch(
        /^run-store\/run-store-(sqlite|ndjson)\.js$|^studio\/run-store-ui(-node|-page-node)?\.js$/
      );
      for (const specifier of externalSpecifiers(file)) {
        if (moduleName(file) === "hosting") {
          expect(specifier, `${name} imports ${specifier}`).not.toMatch(/^node:/);
        }
      }
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("confines cloudflare:workers to the Cloudflare entrypoint", () => {
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (!name.endsWith(".js")) continue;
      const specifiers = externalSpecifiers(resolve(dist, name));
      if (specifiers.some((specifier) => specifier.startsWith("cloudflare:"))) {
        expect(name.split(sep).join("/"), `${name} imports a Cloudflare platform module`).toBe(
          "cloudflare/cloudflare.js"
        );
      }
    }
    expect(readFileSync(resolve(dist, "cloudflare/cloudflare.d.ts"), "utf8")).not.toMatch(
      /cloudflare:|@cloudflare\//
    );
  });

  it("keeps the Cloudflare cache entrypoint loadable outside workerd", () => {
    const pending = [resolve(dist, "cloudflare/cloudflare-cache.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const specifier of externalSpecifiers(file)) {
        expect(specifier, `${relative(dist, file)} imports ${specifier}`).not.toMatch(
          /^cloudflare:/
        );
      }
      pending.push(...dependencies(file));
    }
    expect(readFileSync(resolve(dist, "cloudflare/cloudflare-cache.d.ts"), "utf8")).not.toMatch(
      /cloudflare:|@cloudflare\//
    );
  });

  it("keeps CLI authoring independent of workbench, storage and Studio", () => {
    const pending = [resolve(dist, "cli/cli.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(
        ["cli", "core", "node", "reporter", "tracing", "utilities"].includes(moduleName(file)),
        `CLI entrypoint reaches operational module: ${relative(dist, file)}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("keeps cross-module imports within the declared dependency direction", () => {
    const violations: string[] = [];
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (!name.endsWith(".js")) continue;
      const file = resolve(dist, name);
      const owner = moduleName(file);
      expect(allowedDependencies, `Unclassified module: ${name}`).toHaveProperty(owner);
      for (const dependency of dependencies(file)) {
        expect(existsSync(dependency), `Missing dependency: ${dependency}`).toBe(true);
        const target = moduleName(dependency);
        // The Node entrypoint exposes the same standalone cache utility used lazily by core.
        const cacheExport =
          name === "node/node.js" &&
          relative(dist, dependency).split(sep).join("/") === "utilities/cache-storage.js";
        if (owner !== target && !allowedDependencies[owner].includes(target) && !cacheExport) {
          violations.push(`${name} -> ${relative(dist, dependency)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the entire root import graph free of presentation, storage and exporters", () => {
    const pending = [resolve(dist, "core/pipeline.js")];
    const visited = new Set<string>();
    const tracingInternals = new Set([
      "tracing/tracing.js",
      "tracing/artifact-metadata.js",
      "tracing/graph-metadata.js",
      "tracing/tracing-codec.js",
      "tracing/tracing-constants.js",
      "tracing/tracing-internal.js",
      "tracing/tracing-schema.js",
      "tracing/trace-exporter-error.js",
      "tracing/wire-schema.js",
    ]);
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(
        ["core", "utilities"].includes(moduleName(file)) || tracingInternals.has(name),
        `Root entrypoint reaches optional module: ${name}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });
});
