import { useState } from "preact/hooks";
import { cacheArtifactMetadata } from "../../../run-store/cache-artifact.js";
import type { StoredPipelineArtifact } from "../../../run-store/run-store.js";

export function StepArtifacts({
  artifacts,
  stepId,
}: {
  artifacts: readonly StoredPipelineArtifact[];
  stepId: string;
}) {
  const [filter, setFilter] = useState("all");
  const cached = artifacts.filter((entry) => cacheArtifactMetadata(entry.artifact));
  const mixed = cached.length > 0 && cached.length < artifacts.length;
  return (
    <>
      {mixed && (
        <label class="artifact-filter">
          Artifacts for {stepId}{" "}
          <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
            <option value="all">All artifacts</option>
            <option value="cache">Cached outputs</option>
            <option value="application">Application artifacts</option>
          </select>
        </label>
      )}
      {artifacts.map((entry, index) => {
        const cache = cacheArtifactMetadata(entry.artifact);
        if (mixed && ((filter === "cache" && !cache) || (filter === "application" && cache)))
          return null;
        const created = cache ? new Date(cache.createdAtMs) : undefined;
        return (
          <details class="artifact-detail" key={index}>
            <summary>
              {cache ? "Cached output " : entry.preview ? "Preview " : "Artifact "}
              {entry.operation}
              {!cache && `: ${entry.artifact.id || entry.artifact.uri}`}
            </summary>
            {cache && (
              <div class="artifact-info">
                <div>
                  Created:{" "}
                  {created && Number.isFinite(created.getTime())
                    ? created.toISOString()
                    : String(cache.createdAtMs)}
                </div>
                <div>
                  Age at {entry.operation}: {cache.ageMs} ms
                </div>
                {entry.artifact.uri && <div>Location: {entry.artifact.uri}</div>}
                {entry.artifact.byteSize !== undefined && (
                  <div>Size: {entry.artifact.byteSize} bytes</div>
                )}
                <p class="artifact-note">
                  Recorded operation; current cache availability is not checked.
                </p>
              </div>
            )}
            {cache ? (
              <details class="artifact-receipt">
                <summary>Receipt metadata</summary>
                <pre>{JSON.stringify(entry.artifact, null, 2)}</pre>
              </details>
            ) : (
              <pre>{JSON.stringify(entry.artifact, null, 2)}</pre>
            )}
          </details>
        );
      })}
    </>
  );
}
