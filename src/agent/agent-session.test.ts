import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createAgentSession,
  defineAgent,
  defineAgentLoop,
  type AgentModel,
  type AgentModelRequest,
} from "./agent.js";
import { emptyInput, textSchema } from "./agent.test-support.js";
import { toolObject } from "./default-tool-schema.js";
import { remote } from "./environment.test-support.js";
import { wireArray, wireString } from "../tracing/wire-schema.js";

/** A provider that appends each task, and fails tasks named "fail", recording what it saw. */
function chatModel() {
  const requests: AgentModelRequest[] = [];
  const model: AgentModel = (request) => {
    requests.push(request);
    if (request.task === "fail") throw new Error("provider failed");
    const conversation = [...((request.conversation as string[] | null) ?? []), request.task];
    return {
      decision: { kind: "finish", result: { answer: conversation.join(" > ") } },
      conversation,
    };
  };
  return { model, requests };
}

const agent = (model: AgentModel) =>
  defineAgent({ id: "chat", projectContext: false, environment: remote(), model });

describe("agent sessions", () => {
  it("continues one conversation across prompts and keeps it after failures", async () => {
    const { model, requests } = chatModel();
    const session = createAgentSession(agent(model));
    expectTypeOf(session.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    expect(await session.runOrThrow({ task: "hello" })).toEqual({ answer: "hello" });
    expect(session.conversation).toEqual(["hello"]);
    const failed = await session.run({ task: "fail" });
    expect(failed.status).toBe("failed");
    expect(session.conversation).toEqual(["hello"]);
    await expect(session.runOrThrow({ task: "fail" })).rejects.toThrow("provider failed");
    expect(await session.runOrThrow({ task: "again" })).toEqual({ answer: "hello > again" });
    expect(requests.map(({ conversation }) => conversation)).toEqual([
      null,
      ["hello"],
      ["hello"],
      ["hello"],
    ]);
    session.clear();
    expect(session.conversation).toBeNull();
    expect(await session.runOrThrow({ task: "fresh" })).toEqual({ answer: "fresh" });
  });

  it("resumes a persisted conversation and leaves the original agent stateless", async () => {
    const { model } = chatModel();
    const chat = agent(model);
    const session = createAgentSession(chat, { conversation: ["stored"] });
    expect(await session.runOrThrow({ task: "next" })).toEqual({ answer: "stored > next" });
    expect(await chat.runOrThrow({ task: "solo" })).toEqual({ answer: "solo" });
    expect(Object.isFrozen(session.conversation)).toBe(true);
  });

  it("rejects overlapping runs and agents without a model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createAgentSession(
      agent(async () => {
        await gate;
        return { decision: { kind: "finish", result: { answer: "done" } }, conversation: null };
      })
    );
    const first = session.run({ task: "slow" });
    await expect(session.run({ task: "overlap" })).rejects.toThrow(
      "Agent session is already running"
    );
    release();
    expect((await first).status).toBe("completed");
    const loop = defineAgentLoop({
      id: "loop",
      inputSchema: emptyInput,
      resultSchema: textSchema,
      initialState: () => null,
      decide: () => ({ kind: "finish", result: "" }),
    });
    // Loops own their state; only model-backed agents carry a provider conversation.
    expect(() => createAgentSession(loop)).toThrow("requires an agent from defineAgent");
  });

  it("supports typed agents", async () => {
    const { model, requests } = chatModel();
    const typed = defineAgent({
      id: "typed-chat",
      environment: remote(),
      inputSchema: toolObject({ topics: wireArray(wireString(), {}) }),
      task: ({ topics }) => topics.join(", "),
      model,
    });
    const session = createAgentSession(typed);
    await session.runOrThrow({ topics: ["a", "b"] });
    await session.runOrThrow({ topics: ["c"] });
    expect(requests.map(({ task, conversation }) => [task, conversation])).toEqual([
      ["a, b", null],
      ["c", ["a, b"]],
    ]);
  });
});
