import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startStudioClientWatch, studioClientSources } from "./watch-studio-client.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCount(calls: readonly unknown[], count: number) {
  const start = Date.now();
  while (calls.length < count) {
    if (Date.now() - start > 2000) {
      throw new Error(`expected ${count} generates, saw ${calls.length}`);
    }
    await delay(10);
  }
}

describe("studioClientSources", () => {
  it("follows the bundle's runtime imports and skips tests and type-only modules", () => {
    const sources = [...studioClientSources(packageRoot)].map((file) =>
      relative(packageRoot, file)
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        "src/studio/run-store-ui-client-browser.ts",
        "src/studio/run-store-ui-runs.tsx",
        "src/studio/run-store-ui-graph.tsx",
        "src/run-store/definition-diff.ts",
        "src/utilities/canonical-json.ts",
        "src/run-store/cache-artifact.ts",
      ])
    );
    expect(sources).not.toContain("src/cli/cli-parser.ts");
    expect(sources.some((file) => file.includes(".test."))).toBe(false);
  });
});

describe("startStudioClientWatch", () => {
  it("rebuilds once for a burst, then once more for a change during that rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio"), { recursive: true });
    mkdirSync(join(root, "src/cli"), { recursive: true });
    mkdirSync(join(root, "dist/studio"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    writeFileSync(join(root, "src/studio/leaf.ts"), 'export const label = "Studio";\n');
    writeFileSync(join(root, "src/studio/types-only.ts"), "export interface T { n: number }\n");
    writeFileSync(join(root, "src/studio/skip.ts"), "export const skip = true;\n");
    writeFileSync(join(root, "src/cli/cli-parser.ts"), "export const n = 1;\n");
    writeFileSync(
      join(root, "src/studio/run-store-ui-client-browser.ts"),
      [
        '// import { skip } from "./skip.js";',
        '/* import { skip } from "./skip.js"; */',
        'import type { T } from "./types-only.js";',
        'import { label } from "./leaf.js";',
        "export const text = label;",
        "",
      ].join("\n")
    );
    writeFileSync(join(root, "dist/studio/run-store-ui-client-browser.js"), "ok\n");
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");

    const relativeSources = [...studioClientSources(root)]
      .map((file) => relative(root, file))
      .sort();
    expect(relativeSources).toEqual([
      "src/studio/leaf.ts",
      "src/studio/run-store-ui-client-browser.ts",
    ]);

    const pending: Array<() => void> = [];
    let warmup = true;
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 40,
      generate: () =>
        new Promise<void>((resolve) => {
          if (warmup) resolve();
          else pending.push(resolve);
        }),
    });
    try {
      // A watch started just after the fixture writes can still observe them.
      await delay(400);
      warmup = false;
      await delay(80);
      expect(pending).toHaveLength(0);

      writeFileSync(
        join(root, "src/studio/types-only.ts"),
        "export interface T { n: number; extra: boolean }\n"
      );
      writeFileSync(join(root, "src/cli/cli-parser.ts"), "export const n = 2;\n");
      await delay(250);
      expect(pending).toHaveLength(0);

      const leaf = join(root, "src/studio/leaf.ts");
      writeFileSync(leaf, 'export const label = "Studio 2";\n');
      await delay(15);
      writeFileSync(leaf, 'export const label = "Studio 3";\n');
      await waitForCount(pending, 1);
      await delay(80);
      expect(pending).toHaveLength(1);

      writeFileSync(leaf, 'export const label = "Studio 4";\n');
      await delay(120);
      expect(pending).toHaveLength(1);
      pending[0]?.();
      await waitForCount(pending, 2);
      pending[1]?.();
      await delay(150);
      expect(pending).toHaveLength(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates at startup when a bundle is missing and keeps watching after a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    writeFileSync(
      join(root, "src/studio/run-store-ui-client-browser.ts"),
      'export const text = "Studio";\n'
    );
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");

    const calls: string[] = [];
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 20,
      generate: async () => {
        calls.push("run");
        if (calls.length === 1) throw new Error("Studio client bundle failed.");
      },
    });
    try {
      await waitForCount(calls, 1);
      writeFileSync(
        join(root, "src/studio/run-store-ui-client-browser.ts"),
        'export const text = "Studio 2";\n'
      );
      await waitForCount(calls, 2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows a literal dynamic import and rebuilds when that module changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio"), { recursive: true });
    mkdirSync(join(root, "dist/studio"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    writeFileSync(join(root, "src/studio/panel.ts"), 'export const panel = "panel";\n');
    writeFileSync(join(root, "src/studio/comment-panel.ts"), "export const hidden = true;\n");
    writeFileSync(
      join(root, "src/studio/run-store-ui-client-browser.ts"),
      [
        '// import("./comment-panel.js");',
        '/* import("./comment-panel.js"); */',
        'import("node:net");',
        'const load = () => import("./panel.js");',
        "export const text = load;",
        "",
      ].join("\n")
    );
    writeFileSync(join(root, "dist/studio/run-store-ui-client-browser.js"), "ok\n");
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");

    const relativeSources = [...studioClientSources(root)].map((file) => relative(root, file));
    expect(relativeSources).toContain("src/studio/panel.ts");
    expect(relativeSources).not.toContain("src/studio/comment-panel.ts");

    const pending: Array<() => void> = [];
    let warmup = true;
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 40,
      generate: () =>
        new Promise<void>((resolve) => {
          if (warmup) resolve();
          else pending.push(resolve);
        }),
    });
    try {
      await delay(400);
      warmup = false;
      await delay(80);
      expect(pending).toHaveLength(0);

      writeFileSync(join(root, "src/studio/panel.ts"), 'export const panel = "panel 2";\n');
      await waitForCount(pending, 1);
      await delay(80);
      expect(pending).toHaveLength(1);
      pending[0]?.();
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps watching when a source scan throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio"), { recursive: true });
    mkdirSync(join(root, "dist/studio"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    const entry = join(root, "src/studio/run-store-ui-client-browser.ts");
    const leaf = join(root, "src/studio/leaf.ts");
    writeFileSync(leaf, 'export const label = "Studio";\n');
    writeFileSync(entry, 'import { label } from "./leaf.js";\nexport const text = label;\n');
    writeFileSync(join(root, "dist/studio/run-store-ui-client-browser.js"), "ok\n");
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");

    const pending: Array<() => void> = [];
    let warmup = true;
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 40,
      generate: () =>
        new Promise<void>((resolve) => {
          if (warmup) resolve();
          else pending.push(resolve);
        }),
    });
    try {
      await delay(400);
      warmup = false;
      await delay(80);
      expect(pending).toHaveLength(0);

      // A directory where the entry file was makes readFileSync throw EISDIR.
      // Linux does not report that replacement, so edit a bundled file to deliver
      // the event. The scan throws, and the watcher must still rebuild.
      rmSync(entry);
      mkdirSync(entry);
      writeFileSync(leaf, 'export const label = "Studio 2";\n');
      await waitForCount(pending, 1);
      let resolved = 0;
      const start = Date.now();
      while (true) {
        while (resolved < pending.length) {
          pending[resolved]?.();
          resolved += 1;
        }
        await delay(150);
        if (resolved === pending.length) break;
        if (Date.now() - start > 2000) {
          throw new Error(`watch did not settle, saw ${pending.length} generates`);
        }
      }
      const afterError = pending.length;

      writeFileSync(leaf, 'export const label = "Studio 3";\n');
      await waitForCount(pending, afterError + 1);
      await delay(150);
      expect(pending).toHaveLength(afterError + 1);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
