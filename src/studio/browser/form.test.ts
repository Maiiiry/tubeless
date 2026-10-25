import { describe, expect, it } from "vitest";
import type { CliParameterDescriptor } from "../../cli/cli.js";
import type { PipelineRunStudioCommand } from "../shared/protocol.js";
import {
  initialStudioParameterValues,
  serializeLaunchValues,
  serializePlanInput,
} from "./components/launch.js";

function parameter(
  key: string,
  overrides: Partial<CliParameterDescriptor> = {}
): CliParameterDescriptor {
  return {
    flag: `--${key}`,
    key,
    multiple: false,
    positional: false,
    required: false,
    type: "string",
    ...overrides,
  };
}

function command(parameters: readonly CliParameterDescriptor[]): PipelineRunStudioCommand {
  return { canPlan: true, id: "fixture", name: "Fixture", parameters };
}

describe("Studio form serialization", () => {
  it("starts multiple-choice controls with no selected values", () => {
    const parameters = [
      parameter("stepIds", { choices: ["load", "publish"], multiple: true }),
      parameter("targets", { multiple: true }),
      parameter("dryRun", { default: false, type: "boolean" }),
    ];

    expect(initialStudioParameterValues(command(parameters))).toEqual([[], [""], [false]]);
  });

  it("omits unchanged booleans and empty scalars from launch values", () => {
    const parameters = [
      parameter("enabled", { default: false, type: "boolean" }),
      parameter("verbose", { default: true, type: "boolean" }),
      parameter("name"),
      parameter("count", { type: "number" }),
    ];
    const values = [[false], [false], [""], [3]] as const;
    expect(
      serializeLaunchValues(command(parameters), (_parameter, index) => values[index]!)
    ).toEqual({ verbose: false, count: 3 });
  });

  it("keeps homogeneous multiple values and ignores values with the wrong primitive type", () => {
    const parameters = [
      parameter("targets", { multiple: true }),
      parameter("retries", { multiple: true, type: "number" }),
    ];
    const values = [
      ["one", 2, "three"],
      [1, "two", 3],
    ] as const;
    expect(
      serializeLaunchValues(command(parameters), (_parameter, index) => values[index]!)
    ).toEqual({ targets: ["one", "three"], retries: [1, 3] });
  });

  it("serializes only enabled execution selections for plans", () => {
    const parameters = [
      parameter("domain"),
      parameter("dryRun", { group: "execution", type: "boolean" }),
      parameter("targets", { group: "execution", multiple: true }),
      parameter("stepIds", { group: "execution", multiple: true }),
    ];
    const values = [["ignored"], [true], ["publish", "verify"], []] as const;
    expect(serializePlanInput(command(parameters), (_parameter, index) => values[index]!)).toEqual({
      dryRun: true,
      targets: ["publish", "verify"],
    });
  });
});
