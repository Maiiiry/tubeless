import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { createSteps, definePipeline } from "../../../core/pipeline.js";
import { DefinitionHistoryView } from "./definitions.js";
import type { StoredPipelineDefinition } from "../../../run-store/run-store.js";

function definition(version: string): StoredPipelineDefinition {
  const { step } = createSteps();
  const a = step("a", { run: () => 1 });
  const snapshot = definePipeline({
    id: "example",
    implementationVersion: version,
    steps: [a],
    finalize: () => 0,
  }).definition!;
  return {
    identity: snapshot.identity,
    snapshot,
    activeRuns: 0,
    firstSeenAtMs: 0,
    lastSeenAtMs: 0,
    pipelineId: "example",
    runCount: 1,
    steps: [],
    targetIds: [],
  };
}

describe("Studio definition history", () => {
  it("renders definition selection, comparison direction and implementation changes as escaped text", () => {
    const selected = definition("<new>");
    const previous = definition("old");
    const html = renderToString(
      <DefinitionHistoryView
        definitions={[selected, previous]}
        selected={selected}
        candidates={[previous]}
        previous={previous}
        definition={{ value: selected, loading: false, reload: () => {} }}
        runs={{ value: { runs: [], offset: 0, runCount: 0 }, loading: false, reload: () => {} }}
        comparison={{ value: previous, loading: false, reload: () => {} }}
        onDefinition={() => {}}
        onCompare={() => {}}
        onPage={() => {}}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('aria-label="Definition"');
    expect(html).toContain('aria-label="Compare from"');
    expect(html).toContain("Implementation version");
    expect(html).toContain("&lt;new>");
    expect(html).not.toContain("<new>");
    expect(html).toContain("Graph fingerprints do not verify handler code");
  });

  it.each(["loading", "failed"] as const)(
    "keeps metadata and comparison visible while a run page is %s",
    (status) => {
      const selected = definition("new");
      const previous = definition("old");
      const html = renderToString(
        <DefinitionHistoryView
          definitions={[selected, previous]}
          selected={selected}
          candidates={[previous]}
          previous={previous}
          definition={{ value: selected, loading: false, reload: () => {} }}
          comparison={{ value: previous, loading: false, reload: () => {} }}
          runs={{
            value: null,
            loading: status === "loading",
            error: status === "failed" ? "Run page unavailable" : undefined,
            reload: () => {},
          }}
          onDefinition={() => {}}
          onCompare={() => {}}
          onPage={() => {}}
          onSelect={() => {}}
        />
      );
      expect(html).toContain("Explore steps");
      expect(html).toContain("Implementation version");
      expect(html).not.toContain("Loading definition");
      expect(html).not.toContain("Loading comparison");
      expect(html).toContain(status === "loading" ? "Loading runs" : "Run page unavailable");
    }
  );

  it("labels legacy versions and refuses to compare incomplete snapshots", () => {
    const selected = definition("new");
    const legacy = { ...definition("old"), identity: undefined, snapshot: undefined };
    const html = renderToString(
      <DefinitionHistoryView
        definitions={[selected, legacy]}
        selected={selected}
        candidates={[legacy]}
        previous={legacy}
        definition={{ value: selected, loading: false, reload: () => {} }}
        runs={{ value: { runs: [], offset: 0, runCount: 0 }, loading: false, reload: () => {} }}
        comparison={{ value: legacy, loading: false, reload: () => {} }}
        onDefinition={() => {}}
        onCompare={() => {}}
        onPage={() => {}}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain("Legacy (identity not recorded)");
    expect(html).toContain("A complete comparison is unavailable");
  });
});
