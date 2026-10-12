import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./workbench-init.js";
import { cloudflareScaffold } from "./workbench-init-cloudflare.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const coreUrl = pathToFileURL(resolve("dist/core/pipeline.js")).href;
const projectUrl = pathToFileURL(resolve("dist/project/project.js")).href;

function projectSource(withSchema: boolean, exportClause = "export default"): string {
  return `
    import { createSteps, definePipeline } from ${JSON.stringify(coreUrl)};
    import { defineProject } from ${JSON.stringify(projectUrl)};
    const schema = { "~standard": { vendor: "t", version: 1, validate: (value) => ({ value }),
      jsonSchema: { input: () => ({ type: "object", properties: {} }) } } };
    const { step } = ${withSchema ? "createSteps(schema)" : "createSteps()"};
    const only = step("only", { run: () => 1 });
    ${exportClause} defineProject("init-test", [definePipeline({ id: "only", steps: [only], finalize: only })]);
  `;
}

function workspace(source: string | null = projectSource(true)) {
  const cwd = mkdtempSync(join(tmpdir(), "My App_"));
  roots.push(cwd);
  if (source !== null) writeFileSync(join(cwd, "tubeless.project.mjs"), source);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd,
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
  };
  return { cwd, out, err, io };
}
const init = (io: ReturnType<typeof workspace>["io"], target = "cloudflare") =>
  runInit([target, "--project", "tubeless.project.mjs"], io);

describe("tubeless init", () => {
  it("writes the Cloudflare files and next steps", async () => {
    const { cwd, io, out } = workspace();
    expect(await init(io)).toBe(0);
    const worker = readFileSync(join(cwd, "cloudflare/worker.ts"), "utf8");
    expect(worker).toContain('import project from "../tubeless.project.mjs";');
    expect(worker).toContain('import { createCloudflareApp } from "tubeless/cloudflare";');
    const config = readFileSync(join(cwd, "cloudflare.config.ts"), "utf8");
    expect(config).toMatch(/name: "my-app-[a-z0-9-]+"/);
    expect(config).toContain('storage: "sqlite"');
    expect(out.join("")).toContain("npx cf deploy");
  });

  it("imports a project selected from a named export", async () => {
    const { cwd, io } = workspace(projectSource(true, "export const initProject ="));
    expect(await init(io)).toBe(0);
    const worker = readFileSync(join(cwd, "cloudflare/worker.ts"), "utf8");
    expect(worker).toContain('import { initProject as project } from "../tubeless.project.mjs";');
    expect(worker).toContain("const app = createCloudflareApp(project);");
  });

  it("imports a named export called project without an alias", async () => {
    const { cwd, io } = workspace(projectSource(true, "export const project ="));
    expect(await init(io)).toBe(0);
    expect(readFileSync(join(cwd, "cloudflare/worker.ts"), "utf8")).toContain(
      'import { project } from "../tubeless.project.mjs";'
    );
  });

  it("refuses a project export that is not an identifier before writing", async () => {
    const { cwd, io, err } = workspace(
      projectSource(true, "const named =") + '\nexport { named as "init-project" };\n'
    );
    expect(await init(io)).not.toBe(0);
    expect(err.join("")).toContain('"init-project"');
    expect(existsSync(join(cwd, "cloudflare/worker.ts"))).toBe(false);
    expect(existsSync(join(cwd, "cloudflare.config.ts"))).toBe(false);
  });

  it("never overwrites existing files", async () => {
    const { cwd, io, err } = workspace();
    writeFileSync(join(cwd, "cloudflare.config.ts"), "keep");
    expect(await init(io)).not.toBe(0);
    expect(readFileSync(join(cwd, "cloudflare.config.ts"), "utf8")).toBe("keep");
    expect(existsSync(join(cwd, "cloudflare/worker.ts"))).toBe(false);
    expect(err.join("")).toContain("cloudflare.config.ts");
  });

  it("validates the project before writing anything", async () => {
    const schemaless = workspace(projectSource(false));
    expect(await init(schemaless.io)).not.toBe(0);
    expect(schemaless.err.join("")).toMatch(/Standard JSON Schema/);
    expect(existsSync(join(schemaless.cwd, "cloudflare.config.ts"))).toBe(false);
    const missing = workspace(null);
    expect(await init(missing.io)).not.toBe(0);
  });

  it("rejects unknown targets", async () => {
    const { io, err } = workspace();
    expect(await init(io, "aws")).not.toBe(0);
    expect(err.join("")).toContain("Available: cloudflare");
  });

  it("keeps the checked-in example identical to the scaffold output", () => {
    const root = resolve("examples/cloudflare");
    for (const file of cloudflareScaffold.files({
      cwd: root,
      projectFile: join(root, "tubeless.project.ts"),
      projectExport: "default",
    })) {
      expect(readFileSync(join(root, file.path), "utf8"), file.path).toBe(file.contents);
    }
  });

  it("reports write failures without a stack trace and lists what was created", async () => {
    const { cwd, io, err } = workspace();
    // A file where the cloudflare/ directory belongs makes the worker.ts target unwritable (ENOTDIR).
    writeFileSync(join(cwd, "cloudflare"), "not a directory");
    expect(await init(io)).not.toBe(0);
    expect(err.join("")).toContain("cloudflare/worker.ts");
    expect(err.join("")).not.toMatch(/\n\s+at /);
    expect(existsSync(join(cwd, "cloudflare.config.ts"))).toBe(false);
  });

  it("reports files already created when a later write fails", async () => {
    const { cwd, io, err } = workspace();
    // A dangling symlink is not "occupied" for stat but still refuses an exclusive create.
    symlinkSync(join(cwd, "nowhere"), join(cwd, "cloudflare.config.ts"));
    expect(await init(io)).not.toBe(0);
    expect(err.join("")).toContain("Could not write cloudflare.config.ts");
    expect(err.join("")).toContain("Already created: cloudflare/worker.ts");
  });
});

describe("cloudflare scaffold naming and imports", () => {
  const generate = (base: string, projectFile?: string) => {
    const cwd = join(tmpdir(), base);
    const files = cloudflareScaffold.files({
      cwd,
      projectFile: projectFile ?? join(cwd, "tubeless.project.ts"),
      projectExport: "default",
    });
    const config = files.find((file) => file.path === "cloudflare.config.ts")!.contents;
    return {
      worker: /name: "([^"]*)"/.exec(config)![1]!,
      bucket: /bindings\.r2\(\{ name: "([^"]*)" \}\)/.exec(config)![1]!,
    };
  };

  it("keeps worker and bucket names within Cloudflare limits for long names", () => {
    const { worker, bucket } = generate("a".repeat(100));
    expect(worker.length).toBeLessThanOrEqual(53);
    expect(bucket.length).toBeLessThanOrEqual(63);
    expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(bucket).not.toContain("--");
  });

  it("does not leave a trailing dash when the cut lands on a separator", () => {
    // 52 letters, a separator at the 53rd character, then more text.
    const { worker, bucket } = generate(`${"a".repeat(52)} tail`);
    expect(worker).toBe("a".repeat(52));
    expect(bucket).toBe(`${"a".repeat(52)}-artifacts`);
    expect(bucket.length).toBeLessThanOrEqual(63);
  });

  it("falls back to tubeless for names without letters or digits", () => {
    expect(generate("!!!").worker).toBe("tubeless");
    expect(generate("!!!").bucket).toBe("tubeless-artifacts");
  });

  it("allows digit-leading names", () => {
    expect(generate("2024 Reports").worker).toBe("2024-reports");
    expect(generate("2024 Reports").bucket).toBe("2024-reports-artifacts");
  });

  const workerImportFor = (projectFile: string) => {
    const cwd = join(tmpdir(), "app");
    const files = cloudflareScaffold.files({
      cwd,
      projectFile: join(cwd, projectFile),
      projectExport: "default",
    });
    return files[0]!.contents;
  };

  it("imports a project file from a subdirectory", () => {
    expect(workerImportFor("src/tubeless.project.ts")).toContain(
      'import project from "../src/tubeless.project.ts";'
    );
  });

  it("imports a project file from a parent directory", () => {
    expect(workerImportFor("../tubeless.project.ts")).toContain(
      'import project from "../../tubeless.project.ts";'
    );
  });

  it("prefixes dot-directories beside the worker with ./", () => {
    expect(workerImportFor("cloudflare/.hidden/tubeless.project.ts")).toContain(
      'import project from "./.hidden/tubeless.project.ts";'
    );
  });

  it("escapes the project specifier", () => {
    expect(workerImportFor('we"ird/tubeless.project.ts')).toContain(
      'import project from "../we\\"ird/tubeless.project.ts";'
    );
  });
});
