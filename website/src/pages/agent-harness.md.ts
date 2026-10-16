import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Agents are pipelines

An agent is a pipeline of LLM turns and tool calls. The model chooses what runs next. Tubeless runs the steps and keeps track of what happened.

Tool calls are steps. Subagents are child pipelines. You can trace the whole run, reuse a pipeline as a tool, or put an agent in the middle of a larger workflow.

Each model turn can choose a new batch of registered tools or finish. [Watch an illustrated run](${absUrl("agent-harness")}) to see tool calls branch, a subagent run its own pipeline, and results feed the next model turn.

## Prompt an agent in your terminal

Export OPENAI_API_KEY to child processes, then run from your workspace:

\`\`\`sh
bunx tubeless agent --model gpt-5.4-mini
\`\`\`

Or keep the key in a local dotenv file and run \`bunx tubeless agent --env-file .env.agent\`. Existing environment values take precedence over the file. If the key is already set in your shell, \`export OPENAI_API_KEY\` makes it available to Tubeless.

Enter a task, watch its pipeline execution, read the answer, and prompt again. Agent mode uses the same reporter as \`tubeless run\`: shimmer, colors, spinners, elapsed time, and logs alongside nested model turns and tool calls. Wide terminals show a separate log pane; redirected output uses plain pipeline logs.

Tool activity shows what is happening: file paths for reads, writes, and edits; command previews for bash; paths and queries for listing and searching. The tree and logs include completion summaries such as bytes written, lines read, and command exit codes.

The bike-inspired \`◯╱◯ ❯\` prompt has cyan accents. Press Tab to complete a slash command, or Tab twice after / to list commands. Completed prompts retain conversation, answers, and tool history. Use /model <name> to change models, /clear to start fresh, or /quit to exit. Ctrl-C cancels active work and returns to the prompt. Plug in another provider with --model-module ./model.ts, or run one task with --prompt. [Read the agent CLI guide](${absUrl("docs/cli.md#prompt-a-workspace-agent")}).

Other pipelines can use \`createSteps().waitForInput\` to wait for terminal, web, or application input through a pluggable read callback. [Read the input-step guide](${absUrl("docs/concepts.md#wait-for-user-or-application-input")}).

## Use agents wherever you use pipelines

A pipeline can ask an agent to investigate a problem, then pass its answer to the next step. An agent can call an existing pipeline as a tool, or delegate work to another agent.

It is the same execution model in both directions. Inputs and outputs are validated. Each child agent has its own state, and its work counts toward the parent's execution limits.

- Use fromPipeline to run an agent inside a workflow and consume its answer: [composition example](${githubBlob("examples/agent-pipeline.ts")}).
- Use pipelineTool to give an agent a capability you have already built: [delegation example](${githubBlob("examples/agent-delegation.ts")}).
- Add your own tool handlers with defineTool: [custom tool example](${githubBlob("examples/agent-workspace.ts")}).

## Start with a model and a task

Save this as agent.ts:

\`\`\`ts
${readFileSync(join(__REPO_ROOT__, "examples/agent-model.ts"), "utf8").trim()}
\`\`\`

It gives the model a coding prompt, project instructions from AGENTS.md, conversation history, and six workspace tools: read, edit, write, bash, list, and search.

Add your own tools and instructions as needed. The core is provider-independent: use the OpenAI adapter shown here, swap in anthropicModel() from tubeless/agent/anthropic, point either adapter at a compatible API with baseUrl, supply another model callback, or write your own decision logic with defineAgent.

Install tubeless, set OPENAI_API_KEY in your environment, then run from a disposable workspace with Bun 1.3.14+:

\`\`\`sh
npm install tubeless
bunx tubeless run --trace agent.ndjson ./agent.ts -- --task "Find and fix the failing test, then verify the change."
bunx tubeless history --trace agent.ndjson
\`\`\`

This makes paid model calls and uses your machine's file and shell permissions. Run it in a workspace you are comfortable letting it change.

## Runs in your process

Set limits on turns, calls, nesting, and concurrency. Cancel with an AbortSignal. Record history to NDJSON or SQLite. The runtime has no dependencies, and you do not need a separate service to run an agent.

Inspect which tools were called, what failed, and which subagent did the work. Parent and child runs stay connected in the history.

Opt into durable execution with a checkpoint store, execution key and implementation version. Saved conversations, tool outcomes, child state and budgets survive a restart. Completed calls are reused; interrupted mutations return an uncertain outcome for the agent to inspect. [Try the credential-free SQLite recipe](${githubBlob("examples/agent-durable.ts")}).

Supply an execution environment to put guidance, files and commands in a remote workspace. Children inherit it. [Try the environment recipe](${githubBlob("examples/agent-environment.ts")}). The default workspace uses host permissions; isolation belongs to the environment backend. [Read the durability and environment contracts](${absUrl("docs/agents.md#durable-execution")}).

- [Agent documentation](${absUrl("docs/agents.md")})
- [Examples and recorded runs](${absUrl("agent-examples.md")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
