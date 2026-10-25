import { STUDIO_HISTORY_PAGE_SIZE } from "../../shared/limits.js";
import type { StoredDefinitionSummary } from "../../../run-store/run-history.js";
import type { StudioApi, StudioDefinitionRuns } from "../transport.js";
import { MetadataDetails, MetadataExplorer } from "./metadata.js";
import { useCallback, useState } from "preact/hooks";
import { compareDefinitions } from "../../../run-store/definition-diff.js";
import type { StoredPipelineDefinition } from "../../../run-store/run-store.js";
import { useStudioResource, type StudioResource } from "../resource.js";

function key(definition: StoredDefinitionSummary): string {
  return JSON.stringify([definition.pipelineId, definition.identity?.definitionId ?? null]);
}

function label(definition: StoredDefinitionSummary): string {
  const identity = definition.identity;
  return `${definition.pipelineId} · ${identity ? identity.definitionId.slice(7, 19) : "Legacy (identity not recorded)"} · ${identity?.implementationVersion ?? "implementation unknown"} · ${definition.runCount} ${definition.runCount === 1 ? "run" : "runs"}`;
}

export function DefinitionHistoryView({
  definitions,
  selected,
  candidates,
  previous,
  definition,
  runs,
  comparison,
  onDefinition,
  onCompare,
  onPage,
  onSelect,
}: {
  definitions: readonly StoredDefinitionSummary[];
  selected: StoredDefinitionSummary | undefined;
  candidates: readonly StoredDefinitionSummary[];
  previous: StoredDefinitionSummary | undefined;
  definition: StudioResource<StoredPipelineDefinition>;
  runs: StudioResource<StudioDefinitionRuns>;
  comparison: StudioResource<StoredPipelineDefinition>;
  onDefinition(key: string): void;
  onCompare(key: string): void;
  onPage(offset: number): void;
  onSelect(runId: string): void;
}) {
  if (!selected) return null;
  const snapshot = definition.value?.snapshot;
  const page = runs.value;
  const groupedRuns = page?.runs ?? [];
  const changes =
    comparison.value?.snapshot && snapshot
      ? compareDefinitions(comparison.value.snapshot, snapshot)
      : undefined;
  return (
    <section class="sheet definition-history">
      <div class="sheet-head">
        <div>
          <div class="sheet-title">Observed definitions</div>
          <div class="sheet-subtitle">
            Graph fingerprints do not verify handler code. Implementation versions are supplied by
            the application.
          </div>
        </div>
      </div>
      <div class="definition-body">
        <label class="field">
          Definition{" "}
          <select
            aria-label="Definition"
            value={key(selected)}
            onChange={(event) => {
              onDefinition(event.currentTarget.value);
            }}
          >
            {definitions.map((definition) => (
              <option key={key(definition)} value={key(definition)}>
                {label(definition)}
              </option>
            ))}
          </select>
        </label>
        {selected.identity && (
          <p class="definition-identity">
            Structural fingerprint: <code>{selected.identity.structuralFingerprint}</code>
            <br />
            Definition ID: <code>{selected.identity.definitionId}</code>
          </p>
        )}
        {snapshot && (
          <>
            <MetadataDetails metadata={snapshot.metadata} />
            <MetadataExplorer key={key(selected)} steps={snapshot.steps} />
          </>
        )}
        {definition.error && (
          <p role="alert">
            {definition.error}{" "}
            <button type="button" onClick={definition.reload}>
              Retry definition
            </button>
          </p>
        )}
        {!definition.value && definition.loading && <p>Loading definition…</p>}
        <details>
          <summary>Runs with this definition ({selected.runCount})</summary>
          {runs.error && (
            <p role="alert">
              {runs.error}{" "}
              <button type="button" onClick={runs.reload}>
                Retry runs
              </button>
            </p>
          )}
          {runs.loading && <p>Loading runs…</p>}
          <ul>
            {groupedRuns.map((run) => (
              <li key={run.runId}>
                <button type="button" onClick={() => onSelect(run.runId)}>
                  {run.status} · {new Date(run.startedAtMs).toLocaleString()} · {run.runId}
                </button>
              </li>
            ))}
          </ul>
          {page && page.runCount > STUDIO_HISTORY_PAGE_SIZE && (
            <div class="confirm-actions">
              <button
                class="secondary-button"
                disabled={runs.loading || !page.offset}
                onClick={() => onPage(Math.max(0, page.offset - STUDIO_HISTORY_PAGE_SIZE))}
              >
                Previous
              </button>
              <span>
                {page.offset + 1}–{page.offset + groupedRuns.length} of {page.runCount}
              </span>
              <button
                class="secondary-button"
                disabled={runs.loading || page.offset + STUDIO_HISTORY_PAGE_SIZE >= page.runCount}
                onClick={() => onPage(page.offset + STUDIO_HISTORY_PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </details>
        {previous ? (
          <>
            <label class="field">
              Compare from{" "}
              <select
                aria-label="Compare from"
                value={key(previous)}
                onChange={(event) => onCompare(event.currentTarget.value)}
              >
                {candidates.map((definition) => (
                  <option key={key(definition)} value={key(definition)}>
                    {label(definition)}
                  </option>
                ))}
              </select>
            </label>
            <p class="sheet-subtitle">
              Changes from the comparison definition to the selected definition.
            </p>
            {comparison.error ? (
              <p role="alert">
                {comparison.error}{" "}
                <button type="button" onClick={comparison.reload}>
                  Retry comparison
                </button>
              </p>
            ) : !comparison.value || !definition.value ? (
              (comparison.loading || definition.loading) && <p>Loading comparison…</p>
            ) : changes ? (
              changes.length ? (
                <ul class="definition-changes">
                  {changes.map((change, index) => (
                    <li key={index}>
                      <strong>
                        {change.stepId ? `${change.stepId}: ` : ""}
                        {change.field}
                      </strong>
                      {(change.before !== undefined || change.after !== undefined) && (
                        <div>
                          <code>{change.before ?? "not supplied"}</code> →{" "}
                          <code>{change.after ?? "not supplied"}</code>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recorded semantic changes.</p>
              )
            ) : (
              <p>
                A complete comparison is unavailable: a legacy recording has no identity, or a
                definition snapshot exceeded recording limits.
              </p>
            )}
          </>
        ) : (
          <p class="sheet-subtitle">
            Record another version of this pipeline to compare definitions.
          </p>
        )}
      </div>
    </section>
  );
}

function useDefinition(
  api: StudioApi | undefined,
  definition: StoredDefinitionSummary | undefined
): StudioResource<StoredPipelineDefinition> {
  const pipelineId = definition?.pipelineId;
  const definitionId = definition?.identity?.definitionId;
  // Legacy observations can replace their graph; an incomplete snapshot can be
  // supplied by a later run of the same identified definition.
  const revision = definitionId ? definition?.runCount : definition?.lastSeenAtMs;
  const load = useCallback(async () => {
    if (!api || !pipelineId) throw new Error("No definition selected.");
    return api.loadDefinition(pipelineId, definitionId);
  }, [api, pipelineId, definitionId, revision]);
  return useStudioResource(api, definition ? key(definition) : "", load);
}

function useDefinitionRuns(
  api: StudioApi | undefined,
  definition: StoredDefinitionSummary | undefined,
  offset: number
): StudioResource<StudioDefinitionRuns> {
  const pipelineId = definition?.pipelineId;
  const definitionId = definition?.identity?.definitionId;
  const revision = definition
    ? [definition.runCount, definition.activeRuns, definition.lastSeenAtMs].join(":")
    : "";
  const load = useCallback(async () => {
    if (!api || !pipelineId) throw new Error("No definition selected.");
    return api.loadDefinitionRuns(pipelineId, definitionId, offset);
  }, [api, pipelineId, definitionId, revision, offset]);
  return useStudioResource(api, definition ? key(definition) : "", load);
}

export function DefinitionHistory({
  definitions,
  api,
  onSelect,
}: {
  definitions: readonly StoredDefinitionSummary[];
  api?: StudioApi;
  onSelect(runId: string): void;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const [compareKey, setCompareKey] = useState("");
  const [offset, setOffset] = useState(0);
  const selected = definitions.find((entry) => key(entry) === selectedKey) ?? definitions[0];
  const candidates = definitions.filter(
    (entry) =>
      entry.pipelineId === selected?.pipelineId && key(entry) !== (selected && key(selected))
  );
  const previous = candidates.find((entry) => key(entry) === compareKey) ?? candidates[0];
  const definition = useDefinition(api, selected);
  const runs = useDefinitionRuns(api, selected, offset);
  const comparison = useDefinition(api, previous);
  return (
    <DefinitionHistoryView
      definitions={definitions}
      selected={selected}
      candidates={candidates}
      previous={previous}
      definition={definition}
      runs={runs}
      comparison={comparison}
      onDefinition={(value) => {
        setSelectedKey(value);
        setCompareKey("");
        setOffset(0);
      }}
      onCompare={setCompareKey}
      onPage={setOffset}
      onSelect={onSelect}
    />
  );
}
