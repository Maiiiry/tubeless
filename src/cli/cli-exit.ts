import type { PipelineError } from "../core/pipeline-types.js";
import { tubelessErrorKind } from "../utilities/tubeless-error.js";

/** Stable shell exit codes for the workbench command family. */
export const TUBELESS_WORKBENCH_EXIT_CODE = {
  success: 0,
  usage: 1,
  load: 2,
  definition: 3,
  validation: 4,
  planning: 5,
  execution: 6,
  cancellation: 7,
} as const;

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}

export function isCliHelpRequested(error: unknown): error is { helpText: string } {
  // Dual library copies under dynamic import break instanceof. Key on the
  // brand, then the pre-brand name-and-shape used by older loaded copies.
  return (
    (tubelessErrorKind(error) === "cli-help" || errorName(error) === "CliHelpRequested") &&
    typeof error === "object" &&
    error !== null &&
    "helpText" in error &&
    typeof error.helpText === "string"
  );
}

export function isCliValidationError(
  error: unknown
): error is { errors: readonly string[]; helpText: string } {
  // Dual library copies under dynamic import break instanceof. Key on the
  // brand, then the pre-brand name-and-shape used by older loaded copies.
  return (
    (tubelessErrorKind(error) === "cli-validation" || errorName(error) === "CliValidationError") &&
    typeof error === "object" &&
    error !== null &&
    "errors" in error &&
    Array.isArray(error.errors) &&
    "helpText" in error &&
    typeof error.helpText === "string"
  );
}

/**
 * Compact stderr report for rejected arguments: every error, then only the usage line
 * and a pointer to `--help`, so the errors are not buried under the full option list.
 */
export function cliValidationReportLines(errors: readonly string[], helpText: string): string[] {
  const usage = helpText.split("\n", 1)[0]!;
  return [
    ...errors.map((error) => `Error: ${error}`),
    "",
    ...(usage ? [usage] : []),
    "Run with --help to see all options.",
  ];
}

export function isPipelineExecutionError(
  error: unknown
): error is { result: { errors: PipelineError[] } } {
  // Dual library copies under dynamic import break instanceof. Key on the
  // brand, then the pre-brand name-and-shape used by older loaded copies.
  return (
    (tubelessErrorKind(error) === "pipeline-execution" ||
      errorName(error) === "PipelineExecutionError") &&
    typeof error === "object" &&
    error !== null &&
    "result" in error &&
    typeof error.result === "object" &&
    error.result !== null &&
    "errors" in error.result &&
    Array.isArray(error.result.errors)
  );
}

/** Map a thrown CLI or pipeline error onto the workbench exit-code family. */
export function toExitCode(error: unknown): number {
  if (isCliHelpRequested(error)) return TUBELESS_WORKBENCH_EXIT_CODE.success;
  if (isCliValidationError(error)) return TUBELESS_WORKBENCH_EXIT_CODE.validation;
  if (isPipelineExecutionError(error)) {
    const errors = error.result.errors;
    if (errors.length > 0 && errors.every(({ kind }) => kind === "cancellation")) {
      return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
    if (errors.some(({ phase }) => phase === "planning")) {
      return TUBELESS_WORKBENCH_EXIT_CODE.planning;
    }
    return TUBELESS_WORKBENCH_EXIT_CODE.execution;
  }
  return TUBELESS_WORKBENCH_EXIT_CODE.execution;
}
