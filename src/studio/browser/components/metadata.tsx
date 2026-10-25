import { useState } from "preact/hooks";
import type { PipelineMetadata } from "../../../core/pipeline.js";

export function MetadataDetails({ metadata }: { metadata?: PipelineMetadata }) {
  if (!metadata) return null;
  return (
    <details class="step-metadata">
      <summary>
        {[metadata.owner, metadata.domain, ...(metadata.tags ?? [])].filter(Boolean).join(" · ") ||
          "Metadata"}
      </summary>
      <pre>{JSON.stringify(metadata, null, 2)}</pre>
    </details>
  );
}

type MetadataStep = { readonly id: string; readonly metadata?: PipelineMetadata };

export function groupMetadataSteps(
  steps: readonly MetadataStep[],
  search: string,
  groupBy: "owner" | "domain" | "none"
) {
  const groups = new Map<string | undefined, MetadataStep[]>();
  const query = search.trim().toLowerCase();
  for (const step of steps) {
    if (!`${step.id} ${JSON.stringify(step.metadata ?? {})}`.toLowerCase().includes(query))
      continue;
    const label = groupBy === "none" ? "Steps" : step.metadata?.[groupBy];
    const group = groups.get(label) ?? [];
    group.push(step);
    groups.set(label, group);
  }
  return groups;
}

export function MetadataExplorer({ steps }: { steps: readonly MetadataStep[] }) {
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"owner" | "domain" | "none">("none");
  const groups = groupMetadataSteps(steps, search, groupBy);
  return (
    <details>
      <summary>Explore steps ({steps.length})</summary>
      <label class="field">
        Search steps and metadata
        <input
          type="search"
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        Group steps
        <select
          value={groupBy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "owner" || value === "domain" || value === "none") setGroupBy(value);
          }}
        >
          <option value="none">Execution order</option>
          <option value="owner">Owner</option>
          <option value="domain">Domain</option>
        </select>
      </label>
      {groups.size === 0 && <p>No matching steps.</p>}
      {[...groups].map(([label, members]) => (
        <section key={JSON.stringify([label])}>
          <h4>{label ?? "Unassigned"}</h4>
          {label === undefined && <small>No {groupBy} specified</small>}
          <ul>
            {members.map((step) => (
              <li key={step.id}>
                <code>{step.id}</code>
                <MetadataDetails metadata={step.metadata} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}
