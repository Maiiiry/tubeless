import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCommand } from "./cli.js";

describe("defineCommand: built-in --dry-run", () => {
  it("is available without being declared in params, and defaults to false", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { dryRun: false } });
  });

  it("a bare --dry-run sets true; --no-dry-run sets false", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse(["--dry-run"])).toMatchObject({
      kind: "values",
      values: { dryRun: true },
    });
    expect(command.parse(["--no-dry-run"])).toMatchObject({
      kind: "values",
      values: { dryRun: false },
    });
  });

  it("is listed in generated --help output", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("--dry-run");
  });

  it("composes with a command's own params", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (v) => v,
    });
    expect(command.parse(["--version", "json", "--dry-run"])).toMatchObject({
      kind: "values",
      values: { version: "json", dryRun: true },
    });
  });

  it("preserves an own __proto__ parameter", () => {
    const params = Object.fromEntries([["__proto__", { type: "string" as const }]]);
    const command = defineCommand({ params, run: (values) => values });

    expect(command.descriptor.parameters).toContainEqual(
      expect.objectContaining({ flag: "__proto__", key: "__proto__", type: "string" })
    );
    const result = command.parse(["--__proto__", "value"]);
    expect(result.kind).toBe("values");
    if (result.kind !== "values") return;
    expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
    expect(result.values["__proto__"]).toBe("value");
  });

  it("throws at definition time if a schema redeclares the dryRun key", () => {
    expect(() =>
      defineCommand({
        params: { dryRun: { type: "string" } as never },
        run: () => undefined,
      })
    ).toThrow(/"dryRun" is a reserved parameter/);
  });

  it("throws at definition time if a param's flag collides with --dry-run", () => {
    expect(() =>
      defineCommand({
        params: { preview: { type: "boolean", flag: "dry-run" } },
        run: () => undefined,
      })
    ).toThrow(/--dry-run is a reserved flag/);
  });

  it("throws at definition time if a param's flag collides with --help", () => {
    expect(() =>
      defineCommand({
        params: { showHelp: { type: "boolean", flag: "help" } },
        run: () => undefined,
      })
    ).toThrow(/--help is a reserved flag/);
  });
});

describe("defineCommand: path params", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-path-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a relative value against context.cwd", () => {
    const command = defineCommand({ params: { dataDir: { type: "path" } }, run: (v) => v });
    const result = command.parse(["--data-dir", "public/data"], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({
      kind: "values",
      values: { dataDir: path.join("/tmp/workspace", "public/data") },
    });
  });

  it("passes an absolute value through unchanged", () => {
    const command = defineCommand({ params: { dataDir: { type: "path" } }, run: (v) => v });
    const result = command.parse(["--data-dir", "/abs/data"], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({ kind: "values", values: { dataDir: "/abs/data" } });
  });

  it("resolves a relative default against context.cwd", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", default: "public/data" } },
      run: (v) => v,
    });
    const result = command.parse([], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({
      kind: "values",
      values: { dataDir: path.join("/tmp/workspace", "public/data") },
    });
  });

  it("errors when mustExist is set and the path is missing", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true } },
      run: (v) => v,
    });
    const missing = path.join(dir, "missing");
    const result = command.parse(["--data-dir", missing]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("does not exist");
  });

  it("errors when kind is directory but the path is a file", () => {
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: (v) => v,
    });
    const result = command.parse(["--data-dir", filePath]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("must be a directory");
  });

  it("accepts a directory when kind is directory", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: (v) => v,
    });
    const result = command.parse(["--data-dir", dir]);
    expect(result).toMatchObject({ kind: "values", values: { dataDir: dir } });
  });
});

describe("defineCommand: unknown/malformed args", () => {
  it("reports unknown options", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse(["--version", "json", "--bogus"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Unknown option: --bogus");
  });

  it("reports a missing value at the end of argv", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse(["--version"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --version");
  });

  it("reports a bare positional argument", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    const result = command.parse(["leftover"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("Unexpected argument: leftover");
  });

  it("throws at definition time when two keys derive the same flag", () => {
    expect(() =>
      defineCommand({
        params: {
          verbose: { type: "boolean" },
          loud: { type: "boolean", flag: "verbose" },
        },
        run: () => undefined,
      })
    ).toThrow(/Duplicate --verbose flag/);
  });

  it("suggests the closest long flag, including --no- forms and --help", () => {
    const command = defineCommand({
      params: { source: { type: "string", optional: true }, verbose: { type: "boolean" } },
      run: (v) => v,
    });
    const errors = (argv: string[]) => {
      const result = command.parse(argv);
      return result.kind === "error" ? result.errors : [];
    };
    expect(errors(["--sourc=x"])).toEqual(["Unknown option: --sourc=x. Did you mean --source?"]);
    expect(errors(["--no-verbos"])).toEqual([
      "Unknown option: --no-verbos. Did you mean --no-verbose?",
    ]);
    expect(errors(["--hepl"])).toEqual(["Unknown option: --hepl. Did you mean --help?"]);
    expect(errors(["--bogus"])).toEqual(["Unknown option: --bogus"]);
  });

  it("treats the token after an unknown flag as its value instead of a stray argument", () => {
    const command = defineCommand({ params: { source: { type: "string" } }, run: (v) => v });
    const result = command.parse(["--sourc", "x"]);
    expect(result.kind === "error" && result.errors).toEqual([
      "Unknown option: --sourc. Did you mean --source?",
      "Missing required option --source",
    ]);
  });

  it("still reports stray arguments beyond the unknown flag's value", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    const result = command.parse(["--bogus", "a", "b"]);
    expect(result.kind === "error" && result.errors).toEqual([
      "Unknown option: --bogus",
      "Unexpected argument: b",
    ]);
  });

  it("suggests the closest choice for a mistyped value", () => {
    const command = defineCommand({
      params: { format: { type: "string", choices: ["json", "yaml"] } },
      run: (v) => v,
    });
    const near = command.parse(["--format", "jsno"]);
    expect(near.kind === "error" && near.errors).toEqual([
      '--format must be one of: json, yaml (got "jsno"). Did you mean "json"?',
    ]);
    const far = command.parse(["--format", "xml"]);
    expect(far.kind === "error" && far.errors).toEqual([
      '--format must be one of: json, yaml (got "xml")',
    ]);
  });
});

describe("defineCommand: --help", () => {
  it("takes precedence over validation errors and lists every option", () => {
    const command = defineCommand({
      description: "Example command.",
      params: {
        version: { type: "string", choices: ["json", "yaml"], description: "Output format" },
        limit: { type: "number", optional: true },
      },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind).toBe("help");
    expect(result.kind === "help" && result.helpText).toContain("--version <string>");
    expect(result.kind === "help" && result.helpText).toContain("one of: json, yaml");
    expect(result.kind === "help" && result.helpText).toContain("--limit <number>");
    expect(result.kind === "help" && result.helpText).toContain("Example command.");
  });

  it("-h is equivalent to --help", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    expect(command.parse(["-h"]).kind).toBe("help");
  });

  it("does not claim a path's kind constraint when mustExist is not set", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", kind: "directory" } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).not.toContain("must be a directory");
  });

  it("does claim a path's kind constraint when mustExist is set", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("must be a directory");
  });

  it("lists domain options before a separate pipeline-controls section with bracketed metadata", () => {
    const command = defineCommand({
      name: "import",
      params: {
        source: { type: "string", description: "Source to import." },
        limit: { type: "number", integer: true, min: 1, default: 10, description: "Rows." },
        format: { type: "string", choices: ["json", "yaml"], optional: true },
        tag: { type: "string", multiple: true, description: "Tag rows." },
        token: { type: "string", env: "TOKEN", description: "API token." },
        verbose: { type: "boolean", short: "v", default: true, description: "Talk more." },
        quiet: { type: "boolean", description: "Talk less." },
        workers: { type: "number", group: "execution", default: 2, description: "Workers." },
      },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toBe(
      [
        "Usage: import [options]",
        "",
        "Options:",
        "  --source <string>   Source to import. [required]",
        "  --limit <number>    Rows. [integer, min: 1, default: 10]",
        "  --format <string>   [one of: json, yaml]",
        "  --tag <string...>   Tag rows. [repeatable]",
        "  --token <string>    API token. [required, env: TOKEN]",
        "  -v, --verbose       Talk more. [default: true]",
        "  --quiet             Talk less.",
        "  -h, --help          Show this help message.",
        "",
        "Pipeline controls:",
        "  --dry-run           Preview without making changes.",
        "  --workers <number>  Workers. [default: 2]",
      ].join("\n")
    );
  });
});

describe("defineCommand: validate hook", () => {
  it("runs after field-level validation and can add cross-field errors", () => {
    const command = defineCommand({
      params: {
        all: { type: "boolean" },
        version: { type: "string", optional: true },
      },
      validate: (values) =>
        values.all || values.version ? undefined : ["Pass --all or --version"],
      run: (v) => v,
    });
    const result = command.parse([]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toEqual(["Pass --all or --version"]);
  });

  it("does not run when field-level validation already failed", () => {
    const validate = vi.fn();
    const command = defineCommand({
      params: { limit: { type: "number" } },
      validate,
      run: (v) => v,
    });
    command.parse(["--limit", "abc"]);
    expect(validate).not.toHaveBeenCalled();
  });
});
