import type { TargetedEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";
import { commandDescription, errorMessage } from "./run-store-ui-common.js";
import { PlanView } from "./run-store-ui-pipelines.js";

export type StudioParameterValue = boolean | number | string;

export type ReadStudioParameterValues = (
  parameter: CliParameterDescriptor,
  index: number
) => readonly StudioParameterValue[];

/** Initial form values that match the rendered controls. */
export function initialStudioParameterValues(
  command: PipelineRunStudioCommand
): StudioParameterValue[][] {
  return command.parameters.map((parameter) => {
    if (parameter.type === "boolean") return [Boolean(parameter.default)];
    if (parameter.multiple) return parameter.choices ? [] : [""];
    return parameter.default === undefined ? [""] : [parameter.default];
  });
}

/** Convert launch-form values into the bounded wire shape expected by the Studio API. */
export function serializeLaunchValues(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunStudioLaunchRequest["values"] {
  const values: PipelineRunStudioLaunchRequest["values"] = {};
  command.parameters.forEach((parameter, index) => {
    const parameterValue = readValues(parameter, index);
    if (parameter.type === "boolean") {
      const checked = parameterValue[0];
      if (checked !== Boolean(parameter.default)) values[parameter.key] = checked;
      return;
    }
    if (parameter.multiple) {
      values[parameter.key] =
        parameter.type === "number"
          ? parameterValue.filter((value): value is number => typeof value === "number")
          : parameterValue.filter((value): value is string => typeof value === "string");
      return;
    }
    const single = parameterValue[0];
    if (single !== "" && single !== undefined) values[parameter.key] = single;
  });
  return values;
}

/** Select only execution controls for plan requests. */
export function serializePlanInput(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunControls {
  const input: Record<string, boolean | readonly string[]> = {};
  command.parameters.forEach((parameter, index) => {
    if (parameter.group !== "execution") return;
    const values = readValues(parameter, index);
    if (parameter.type === "boolean") {
      if (values[0] === true) input[parameter.key] = true;
      return;
    }
    if (parameter.multiple && values.length) {
      input[parameter.key] = values.filter((value): value is string => typeof value === "string");
    }
  });
  // SAFETY: Execution controls are plan selections; the server parser ignores unknown keys.
  return input as PipelineRunControls;
}

function parameterLabel(parameter: CliParameterDescriptor): string {
  return parameter.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parameterHint(parameter: CliParameterDescriptor): string {
  const details = [];
  if (parameter.description) details.push(parameter.description);
  if (parameter.environment) details.push("Environment fallback: " + parameter.environment);
  if (parameter.multiple)
    details.push(parameter.choices ? "Choose one or more values." : "Enter one value per line.");
  if (parameter.mustExist)
    details.push("Must be an existing " + (parameter.pathKind || "path") + ".");
  return details.join(" ");
}

interface ParameterControlProps {
  index: number;
  onChange(index: number, values: StudioParameterValue[]): void;
  parameter: CliParameterDescriptor;
  values: readonly StudioParameterValue[];
}

function ParameterControl({ index, onChange, parameter, values }: ParameterControlProps) {
  const id = "run-param-" + index;
  const hint = parameterHint(parameter);
  const label = parameterLabel(parameter);
  if (parameter.type === "boolean") {
    return (
      <label class="boolean-field" for={id}>
        <span>
          <strong>{label}</strong>
          <small>{hint || "Enable this option."}</small>
        </span>
        <input
          id={id}
          type="checkbox"
          checked={values[0] === true}
          onChange={(event) => onChange(index, [event.currentTarget.checked])}
        />
      </label>
    );
  }
  const fieldLabel = (
    <label for={id}>
      {label}
      {parameter.required && <span class="required-mark">required</span>}
    </label>
  );
  let control;
  if (parameter.choices) {
    const selectedValues = values.filter((value): value is string => typeof value === "string");
    control = (
      <select
        id={id}
        multiple={parameter.multiple}
        required={parameter.required}
        value={parameter.multiple ? undefined : (selectedValues[0] ?? "")}
        onChange={(event: TargetedEvent<HTMLSelectElement>) =>
          onChange(
            index,
            parameter.multiple
              ? Array.from(event.currentTarget.selectedOptions, (option) => option.value)
              : [event.currentTarget.value]
          )
        }
      >
        {!parameter.multiple && !parameter.required && (
          <option value="">Use default or leave unset</option>
        )}
        {parameter.choices.map((choice) => (
          <option
            key={choice}
            value={choice}
            selected={parameter.multiple ? selectedValues.includes(choice) : undefined}
          >
            {choice}
          </option>
        ))}
      </select>
    );
  } else if (parameter.multiple) {
    control = (
      <textarea
        id={id}
        spellcheck={false}
        placeholder="One value per line"
        value={String(values[0] ?? "")}
        onInput={(event) => onChange(index, [event.currentTarget.value])}
      />
    );
  } else if (parameter.type === "number") {
    const inputValue = values[0] ?? "";
    control = (
      <input
        id={id}
        type="number"
        value={String(inputValue)}
        step={parameter.integer ? "1" : "any"}
        min={parameter.min}
        max={parameter.max}
        required={parameter.required}
        onInput={(event) =>
          onChange(
            index,
            event.currentTarget.value !== ""
              ? [Number(event.currentTarget.value)]
              : [event.currentTarget.value]
          )
        }
      />
    );
  } else {
    const inputValue = values[0] ?? "";
    control = (
      <input
        id={id}
        type="text"
        value={String(inputValue)}
        placeholder={
          parameter.type === "path"
            ? parameter.pathKind === "directory"
              ? "./directory"
              : "./file"
            : ""
        }
        required={parameter.required}
        onInput={(event) => onChange(index, [event.currentTarget.value])}
      />
    );
  }
  return (
    <div class="field">
      {fieldLabel}
      {control}
      {hint && <div class="field-hint">{hint}</div>}
    </div>
  );
}

interface CommandFieldsProps {
  command: PipelineRunStudioCommand;
  onChange(index: number, values: StudioParameterValue[]): void;
  values: readonly (readonly StudioParameterValue[])[];
}

export function CommandFields({ command, onChange, values }: CommandFieldsProps) {
  const renderSection = (execution: boolean, title: string, note: string) => {
    const parameters = command.parameters
      .map((parameter, index) => ({ index, parameter }))
      .filter(({ parameter }) => (parameter.group === "execution") === execution);
    if (!parameters.length) return null;
    const grid = (
      <div class="parameter-grid">
        {parameters.map(({ index, parameter }) => (
          <ParameterControl
            key={parameter.key}
            index={index}
            onChange={onChange}
            parameter={parameter}
            values={values[index] ?? []}
          />
        ))}
      </div>
    );
    // Execution controls have working defaults, so they stay folded until needed.
    return execution ? (
      <details class="form-section execution-controls">
        <summary class="form-section-head">
          <strong>{title}</strong>
          <span>{note}</span>
        </summary>
        {grid}
      </details>
    ) : (
      <section class="form-section">
        <div class="form-section-head">
          <strong>{title}</strong>
          <span>{note}</span>
        </div>
        {grid}
      </section>
    );
  };
  const domainCount = command.parameters.filter(
    (parameter) => parameter.group !== "execution"
  ).length;
  return (
    <div class="parameter-fields" id="parameterFields">
      {renderSection(
        false,
        "Pipeline inputs",
        domainCount + " parameter" + (domainCount === 1 ? "" : "s")
      )}
      {domainCount === 0 && <p class="form-empty">This pipeline takes no inputs.</p>}
      {renderSection(
        true,
        "Execution controls",
        "Built into Tubeless · dry run, step selection, cache, concurrency"
      )}
    </div>
  );
}

interface LaunchModalProps {
  api: StudioApi;
  commands: readonly PipelineRunStudioCommand[];
  commandId: string | null;
  onClose(): void;
  /** Receives the new run and the command (pipeline) that started it. */
  onLaunched(runId: string, commandId: string): void;
}

export function LaunchModal({ api, commands, commandId, onClose, onLaunched }: LaunchModalProps) {
  const [selectedId, setSelectedId] = useState(commandId ?? commands[0]?.id ?? "");
  const command = commands.find((candidate) => candidate.id === selectedId);
  const [values, setValues] = useState<StudioParameterValue[][]>([]);
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [planning, setPlanning] = useState(false);
  const firstField = useRef<HTMLDivElement>(null);
  const planVersion = useRef(0);

  useEffect(() => {
    setSelectedId(commandId ?? commands[0]?.id ?? "");
  }, [commandId, commands]);

  useEffect(() => {
    planVersion.current += 1;
    setValues(command ? initialStudioParameterValues(command) : []);
    setPlan(null);
    setError("");
    requestAnimationFrame(() =>
      firstField.current?.querySelector<HTMLElement>("input, select, textarea")?.focus()
    );
  }, [command]);

  useEffect(() => {
    if (commandId === null) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !launching && !planning) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [commandId, launching, onClose, planning]);

  if (commandId === null) return null;

  const close = () => {
    if (!launching && !planning) onClose();
  };
  const updateValue = (index: number, next: StudioParameterValue[]) => {
    if (!command) return;
    planVersion.current += 1;
    setValues((current) =>
      current.map((value, candidateIndex) => {
        if (candidateIndex === index) return next;
        const parameter = command.parameters[candidateIndex];
        return command.parameters[index]?.exclusive &&
          command.parameters[index]?.multiple &&
          next.length > 0 &&
          parameter?.exclusive &&
          parameter.multiple
          ? []
          : value;
      })
    );
    setPlan(null);
  };
  const readValues = (parameter: CliParameterDescriptor, index: number) => {
    const stored = values[index] ?? [];
    if (!parameter.multiple || parameter.choices) return stored;
    return String(stored[0] ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (parameter.type === "number" ? Number(value) : value));
  };
  const preview = async () => {
    if (!command?.canPlan || planning) return;
    const requestedVersion = planVersion.current;
    setPlanning(true);
    setError("");
    try {
      const nextPlan = await api.previewPlan(command.id, serializePlanInput(command, readValues));
      if (planVersion.current === requestedVersion) setPlan(nextPlan);
    } catch (caught) {
      if (planVersion.current === requestedVersion) setError(errorMessage(caught));
    } finally {
      setPlanning(false);
    }
  };
  const launch = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!command || launching) return;
    setLaunching(true);
    setError("");
    try {
      onLaunched(
        await api.launch(command.id, serializeLaunchValues(command, readValues)),
        command.id
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLaunching(false);
    }
  };
  return (
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="launchTitle"
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div class="modal">
        <div class="modal-head">
          <div>
            <div class="detail-kicker">Configure pipeline</div>
            <h2 id="launchTitle">{command?.name || "Run a pipeline"}</h2>
            <p>
              {command
                ? commandDescription(command)
                : "Choose a declared pipeline and provide its inputs."}
            </p>
          </div>
          <button class="close-button" type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <form
          class="launch-form"
          onSubmit={launch}
          onInvalidCapture={(event) => {
            // Reveal a folded section so the browser can show its validation message.
            const field = event.target instanceof HTMLElement ? event.target : null;
            field?.closest("details")?.setAttribute("open", "");
          }}
        >
          <div class="field">
            <label for="launchCommand">Pipeline command</label>
            <select
              id="launchCommand"
              value={selectedId}
              onChange={(event) => {
                planVersion.current += 1;
                setPlan(null);
                setError("");
                setSelectedId(event.currentTarget.value);
              }}
            >
              {commands.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
          <div ref={firstField}>
            {command && <CommandFields command={command} onChange={updateValue} values={values} />}
          </div>
          {plan && (
            <div class="plan-result" aria-live="polite">
              <PlanView plan={plan} />
            </div>
          )}
          {error && <div class="launch-error">{error}</div>}
          <div class="modal-actions">
            <button class="secondary-button" type="button" onClick={close}>
              Cancel
            </button>
            {command?.canPlan && (
              <button
                class="secondary-button"
                type="button"
                disabled={planning || launching}
                onClick={() => void preview()}
              >
                {planning ? "Planning…" : "Preview plan"}
              </button>
            )}
            <button class="primary-button" type="submit" disabled={launching || planning}>
              {launching ? "Starting…" : "Run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
