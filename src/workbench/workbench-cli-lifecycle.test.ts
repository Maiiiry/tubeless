import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { onFirstProcessSignal } from "./workbench-shared.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  writeActualPipelineCommandModule,
  writeActualPipelineModule,
} from "./workbench.test-support.js";

describe("workbench CLI lifecycle", () => {
  it("uses stable validation, planning, execution, and cancellation exit codes", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const validationIo = captureIo(directory);
    const planningIo = captureIo(directory);
    const executionIo = captureIo(directory);
    const cancellationIo = captureIo(directory);

    const validationExit = await runWorkbenchCli(["run", "pipeline.mjs"], validationIo);
    const planningExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "work", "--target", "work"],
      planningIo
    );
    const executionExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "failure"],
      executionIo
    );
    const cancellationExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "cancel"],
      cancellationIo
    );

    expect(validationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.validation);
    expect(validationIo.errors.join("")).toContain("Missing required option --message");
    expect(planningExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(planningIo.output.join("")).toContain("TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE");
    expect(executionExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(executionIo.errors.join("")).toContain("TUBELESS_STEP_FAILED");
    expect(executionIo.errors.join("")).toContain("intentional command failure");
    // The fixture's requireOutputs finalizer failure is a consequence, not a second cause.
    expect(executionIo.errors.join("")).not.toContain("Required pipeline outputs missing");
    expect(cancellationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(cancellationIo.errors.join("")).toContain("TUBELESS_RUN_CANCELLED");
  });

  it("prints command help only through the application-argument boundary", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const workbenchHelpIo = captureIo(directory);
    const commandHelpIo = captureIo(directory);

    expect(await runWorkbenchCli(["run", "--help"], workbenchHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["run", "pipeline.mjs", "--", "--help"], commandHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(workbenchHelpIo.output.join("")).toContain("Pass application flags after --");
    expect(workbenchHelpIo.output.join("")).not.toContain("--message");
    expect(commandHelpIo.output.join("")).toContain("--message <string>");
  });

  it("rejects raw pipelines and application flags outside the command boundary", async () => {
    const pipelineFixture = await writeActualPipelineModule();
    const rawPipelineIo = captureIo(pipelineFixture.directory);
    const misplacedFlagFixture = await writeActualPipelineCommandModule();
    const misplacedFlagIo = captureIo(misplacedFlagFixture.directory);

    expect(await runWorkbenchCli(["run", "pipeline.mjs"], rawPipelineIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(rawPipelineIo.errors.join("")).toContain(
      'Cannot derive a CLI for directly loaded pipeline "planning-fixture"'
    );
    expect(rawPipelineIo.errors.join("")).toContain("export a definePipelineCommand");
    expect(
      await runWorkbenchCli(
        ["run", "pipeline.mjs", "--message", "outside-boundary"],
        misplacedFlagIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(misplacedFlagIo.errors.join("")).toContain("Pass application flags after --");
  });

  it("turns SIGINT into cancellation and removes its temporary listener", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
      expect(io.errors.join("")).toContain("SIGINT received; cancelling pipeline work.");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
    } finally {
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("preserves a structured execution failure that races with SIGINT", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "fail-after-abort"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
      expect(io.errors.join("")).toContain("TUBELESS_STEP_FAILED");
      expect(io.errors.join("")).toContain("intentional failure after abort");
      expect(io.errors.join("").match(/SIGINT received/g)).toHaveLength(1);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("handles only the first termination signal and restores default handling", () => {
    const events: string[] = [];
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      const dispose = onFirstProcessSignal(["SIGINT", "SIGTERM"], (signal) => {
        events.push(signal);
      });
      const sigintRegistration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      const sigtermRegistration = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
      expect(sigintRegistration).toBeDefined();
      expect(sigtermRegistration).toBeDefined();

      (sigintRegistration![1] as () => void)();
      (sigtermRegistration![1] as () => void)();
      expect(events).toEqual(["SIGINT"]);
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", sigintRegistration?.[1]]);
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGTERM", sigtermRegistration?.[1]]);

      dispose();
    } finally {
      removeListenerSpy.mockRestore();
      onSpy.mockRestore();
    }
  });
});
