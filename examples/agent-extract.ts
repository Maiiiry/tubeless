import { readdir } from "node:fs/promises";
import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { defineAgent, type AgentModel } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";

interface Extracted {
  files: string[];
}
interface Triage {
  files: { path: string; kind: "empty" | "short" | "long" }[];
}

const extracted: StandardSchemaV1<Extracted> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      Array.isArray((value as Partial<Extracted>)?.files) &&
      (value as Extracted).files.every((file) => typeof file === "string")
        ? { value: value as Extracted }
        : { issues: [{ message: "Expected extracted file paths" }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { files: { type: "array", items: { type: "string" } } },
        required: ["files"],
      }),
    },
  },
};
const triage: StandardSchemaV1<Triage> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      Array.isArray((value as Partial<Triage>)?.files)
        ? { value: value as Triage }
        : { issues: [{ message: "Expected triaged files" }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                kind: { enum: ["empty", "short", "long"] },
              },
              required: ["path", "kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["files"],
        additionalProperties: false,
      }),
    },
  },
};

/**
 * A credential-free stand-in that writes the script a model would. Replace it with
 * `openaiModel()` or `anthropicModel()`; the agent definition stays the same.
 */
const scriptedModel: AgentModel = (request) => {
  const outcome = request.outcomes[0];
  if (outcome)
    return {
      conversation: null,
      decision: outcome.ok
        ? { kind: "finish", result: { files: (outcome.value as { result: unknown }).result } }
        : { kind: "finish", result: { files: [] } },
    };
  const paths = request.task
    .split("\n")
    .flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []));
  const code = `
const files = [];
for (const path of ${JSON.stringify(paths)}) {
  const { content } = await tools.read({ path, startLine: null, maxLines: null });
  const kind = content.trim() === "" ? "empty" : content.length < 80 ? "short" : "long";
  files.push({ path, kind });
}
return files;`;
  return {
    conversation: null,
    decision: { kind: "continue", calls: [{ id: "triage", tool: "codemode", input: { code } }] },
  };
};

/** Typed in, typed out: the agent receives the extract step's output and returns a triage. */
export const TriageAgent = defineAgent({
  id: "triage-agent",
  description: "Classify extracted files with one code-mode script.",
  model: scriptedModel,
  inputSchema: extracted,
  resultSchema: triage,
  task: ({ files }) =>
    `Classify each extracted file as empty, short or long:\n${files.map((file) => `- ${file}`).join("\n")}`,
  codemode: true,
  // Read-only permission: the script can read files but not write or run commands.
  defaultTools: ["read"],
  projectContext: false,
  limits: { maxTurns: 2, maxCalls: 50 },
});

const { step, fromPipeline } = createSteps<{}>();

const extract = step("extract", {
  description: "List the text files in the run directory.",
  run: async (_inputs, context): Promise<Extracted> => ({
    files: (await readdir(context.cwd, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => entry.name)
      .sort(),
  }),
});
// The agent is an ordinary child pipeline; its typed options come from the extract step.
const classify = fromPipeline("classify", {
  pipeline: TriageAgent,
  dependsOn: [extract],
  mapOptions: ({ extract }) => extract,
});
const report = step("report", {
  dependsOn: [classify],
  description: "Consume the agent's typed result in ordinary pipeline work.",
  run: ({ classify }) => classify.files.map(({ path, kind }) => `${path}: ${kind}`).join("\n"),
});

export const ExtractTriagePipeline = definePipeline({
  id: "extract-triage",
  description: "Extract files, triage them with a typed agent, and report the result.",
  steps: [extract, classify, report],
  finalize: report,
});

export const ExtractTriageCommand = definePipelineCommand(ExtractTriagePipeline, {
  params: {},
  summarize: (result) => [result],
});
