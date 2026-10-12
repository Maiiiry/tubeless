import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { definePipelineCommand } from "../cli/cli.js";
import { executeHostedCommand, hostedProjectCommands } from "./hosting-commands.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "../cli/cli-exit.js";

const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
  "~standard": {
    vendor: "test",
    version: 1,
    validate: (value) =>
      typeof (value as { name?: unknown }).name === "string"
        ? { value: value as { name: string } }
        : { issues: [{ message: "Expected name", path: ["name"] }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
    },
  } as StandardSchemaV1<{ name: string }, { name: string }>["~standard"],
};
const { step } = createSteps(schema);
const greet = step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({
  id: "greeting",
  name: "Greeting",
  steps: [greet],
  finalize: greet,
});
const plain = createSteps<{}>().step("noop", { run: () => 1 });
const Plain = definePipeline({ id: "plain", steps: [plain], finalize: plain });

const output = () => {
  const lines: string[] = [];
  return {
    lines,
    cwd: "/",
    stdout: { write: (chunk: string) => void lines.push(chunk) },
    stderr: { write: (chunk: string) => void lines.push(chunk) },
  };
};

describe("hosted project commands", () => {
  it("derives schema-backed commands with Studio descriptors", () => {
    const [entry] = hostedProjectCommands(defineProject("p", [Greeting]));
    expect(entry!.descriptor).toMatchObject({ id: "greeting", name: "Greeting", canPlan: true });
    expect(entry!.descriptor.parameters.map((parameter) => parameter.key)).toContain("name");
  });

  it("prefers explicit project commands and rejects schema-less pipelines", () => {
    const explicit = definePipelineCommand(Plain, { params: {}, mapOptions: () => ({}) });
    expect(hostedProjectCommands(defineProject("p", [explicit]))[0]!.descriptor.id).toBe("plain");
    expect(() => hostedProjectCommands(defineProject("p", [Plain]))).toThrow(
      /Standard JSON Schema/
    );
  });

  it("executes values with workbench exit codes", async () => {
    const [entry] = hostedProjectCommands(defineProject("p", [Greeting]));
    const ok = output();
    const parsed = entry!.command.parseValues({ name: "ada" });
    expect(parsed.kind).toBe("values");
    if (parsed.kind !== "values") return;
    expect(
      await executeHostedCommand(entry!.command, parsed.values, ok, new AbortController().signal)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const aborted = new AbortController();
    aborted.abort(new DOMException("stop", "AbortError"));
    expect(
      await executeHostedCommand(entry!.command, parsed.values, output(), aborted.signal)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
  });
});
