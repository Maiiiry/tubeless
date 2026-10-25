import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, execFileAsync, writeModule } from "../workbench.test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockModelResponse() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "finish",
          name: "_finish",
          arguments: JSON.stringify({ result: { answer: "Ready." } }),
          status: "completed",
        },
      ],
    })
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("agent credentials and dotenv files", () => {
  it.each([undefined, "", " \t\n "])(
    "diagnoses an absent or blank inherited key before opening the REPL: %j",
    async (key) => {
      vi.stubEnv("OPENAI_API_KEY", key);
      const fetcher = mockModelResponse();
      const io = { ...captureIo("/tmp"), stdin: Readable.from(["hi\n/quit\n"]) };
      expect(await runWorkbenchCli(["agent"], io)).toBe(1);
      expect(io.errors.join("")).toContain("export OPENAI_API_KEY");
      expect(io.errors.join("")).toContain("--env-file");
      expect(io.output).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      key: undefined,
      model: undefined,
      cliModel: undefined,
      expectedKey: "file-key",
      expectedModel: "file-model",
    },
    {
      key: " \texported-key\n ",
      model: "exported-model",
      cliModel: undefined,
      expectedKey: "exported-key",
      expectedModel: "exported-model",
    },
    {
      key: undefined,
      model: "exported-model",
      cliModel: "selected-model",
      expectedKey: "file-key",
      expectedModel: "selected-model",
    },
  ])(
    "resolves credential and model precedence: %j",
    async ({ key, model, cliModel, expectedKey, expectedModel }) => {
      vi.stubEnv("OPENAI_API_KEY", key);
      vi.stubEnv("OPENAI_MODEL", model);
      const { directory } = await writeModule("export default {};");
      await writeFile(
        join(directory, ".env.agent"),
        `# credentials\r\nexport OPENAI_API_KEY = " file-key " # comment\r\nOPENAI_MODEL='file-model'\r\n`
      );
      const fetcher = mockModelResponse();
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(
          [
            "agent",
            "--env-file",
            ".env.agent",
            "--prompt",
            "hi",
            ...(cliModel ? ["--model", cliModel] : []),
          ],
          io
        )
      ).toBe(0);
      expect(fetcher).toHaveBeenCalledOnce();
      const request = fetcher.mock.calls[0]![1]!;
      expect(new Headers(request.headers).get("Authorization")).toBe(`Bearer ${expectedKey}`);
      expect(JSON.parse(request.body as string).model).toBe(expectedModel);
      const output = io.output.join("") + io.errors.join("");
      expect(output).toContain("Ready.");
      expect(output).not.toContain(expectedKey);
      expect(process.env.OPENAI_API_KEY).toBe(key);
      expect(process.env.OPENAI_MODEL).toBe(model);
    }
  );

  it("keeps an explicitly blank inherited key authoritative over the dotenv value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { directory } = await writeModule("export default {};");
    await writeFile(join(directory, ".env.agent"), "OPENAI_API_KEY=file-key\n");
    const fetcher = mockModelResponse();
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["agent", "--env-file", ".env.agent", "--prompt", "hi"], io)).toBe(
      1
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(io.errors.join("")).not.toContain("file-key");
  });

  it("shows a safe authentication reason and accepts another prompt after HTTP 401", async () => {
    vi.stubEnv("OPENAI_API_KEY", "private-key");
    const { directory } = await writeModule("export default {};");
    const fetcher = mockModelResponse();
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: { code: "invalid_api_key", message: "Incorrect key: private-key" } },
        { status: 401, headers: { "x-request-id": "req_test_401" } }
      )
    );
    const io = { ...captureIo(directory), stdin: Readable.from(["hi\nretry\n/quit\n"]) };
    expect(await runWorkbenchCli(["agent"], io)).toBe(0);
    expect(io.errors.join("")).toContain("[invalid_api_key]");
    expect(io.errors.join("")).toContain("req_test_401");
    expect(io.errors.join("")).toContain("status=failed");
    expect(io.output.join("")).toContain("status=completed");
    expect(io.output.join("")).toContain("Ready.");
    expect(io.output.join("") + io.errors.join("")).not.toContain("private-key");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("passes scoped environment values to custom factories without requiring OpenAI credentials", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("OTHER_PROVIDER_KEY", undefined);
    const { directory } = await writeModule(`
      export default ({ model, env, signal }) => {
        if (!Object.isFrozen(env) || env.OTHER_PROVIDER_KEY !== "other-provider-key" || env.LITERAL !== "$OTHER_PROVIDER_KEY") throw new Error("incorrect environment");
        if (process.env.OTHER_PROVIDER_KEY !== undefined || signal.aborted) throw new Error("incorrect scope");
        return () => ({ decision: { kind: "finish", result: { answer: model + ": scoped credentials" } }, conversation: null });
      };
    `);
    await writeFile(
      join(directory, ".env.agent"),
      "OTHER_PROVIDER_KEY=other-provider-key\nLITERAL=$OTHER_PROVIDER_KEY\nOPENAI_MODEL=other-model\n"
    );
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--env-file", ".env.agent", "--prompt", "hi"],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("other-model: scoped credentials");
    expect(io.output.join("")).not.toContain("other-provider-key");
    expect(io.errors).toEqual([]);
  });

  it.each(["missing-private-key.env", "."])(
    "reports an unreadable file %s without including file contents or paths",
    async (file) => {
      const { directory } = await writeModule("export default {};");
      const io = captureIo(directory);
      expect(await runWorkbenchCli(["agent", "--env-file", file, "--prompt", "hi"], io)).toBe(2);
      expect(io.errors.join("")).toBe(
        "Error: Cannot read --env-file. Supply a readable dotenv file.\n"
      );
      expect(io.output).toEqual([]);
    }
  );

  it("rejects internal whitespace in a credential without echoing it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "private-key\nsecond-line");
    const fetcher = mockModelResponse();
    const io = captureIo("/tmp");
    expect(await runWorkbenchCli(["agent", "--prompt", "hi"], io)).toBe(1);
    expect(io.errors.join("")).toContain("single token");
    expect(io.errors.join("")).not.toContain("private-key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("provides the export diagnostic to a real child process with an unexported shell variable", async () => {
    const { stdout, stderr } = await execFileAsync(
      "sh",
      [
        "-c",
        `
      unset OPENAI_API_KEY
      OPENAI_API_KEY=unexported-fixture
      node dist/workbench/workbench-bin.js agent --prompt hi
      test $? -eq 1
    `,
      ],
      { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "" } }
    );
    expect(stdout).not.toContain("Pipeline tubeless-agent");
    expect(stderr).toContain("export OPENAI_API_KEY");
    expect(stderr).not.toContain("unexported-fixture");
  });

  it.each(["node", "bun"])(
    "loads a dotenv file through the built executable on %s",
    async (runtime) => {
      const { directory, filePath } = await writeModule(`
      export default ({ env }) => {
        if (env.PROVIDER_KEY !== "fixture-provider") throw new Error("file not loaded");
        return () => ({ decision: { kind: "finish", result: { answer: "dotenv ready" } }, conversation: null });
      };
    `);
      const envFile = join(directory, ".env.agent");
      await writeFile(envFile, 'export PROVIDER_KEY="fixture-provider" # comment\n');
      const { stdout, stderr } = await execFileAsync(
        runtime,
        [
          "dist/workbench/workbench-bin.js",
          "agent",
          "--model-module",
          filePath,
          "--env-file",
          envFile,
          "--prompt",
          "hi",
        ],
        { cwd: process.cwd(), env: { ...process.env, PROVIDER_KEY: undefined } }
      );
      expect(stdout).toContain("dotenv ready");
      expect(stdout).not.toContain("fixture-provider");
      expect(stderr).toBe("");
    }
  );
});
