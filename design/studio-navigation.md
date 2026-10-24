# Studio pipeline-first navigation

Status: implemented. Follows the run-view quick wins in
[#209](https://github.com/chetmancini/tubeless/pull/209). Studio's server routes and
JSON payloads stay internal and version-coupled, so this changes no public API.

## Goal

Make Studio read top-down: pick a pipeline, see how it has been running, open a
run, select a step, and only then see raw identifiers. Each level answers one
question, and deeper detail appears when asked for rather than by default.

| Level | Question                        | Surface                                       |
| ----- | ------------------------------- | --------------------------------------------- |
| 0     | What is running and what broke? | Activity page and the pipeline rail           |
| 1     | How is this pipeline doing?     | Pipeline page: runs, graph, versions, Run     |
| 2     | What happened in this run?      | Run page: outcome, errors, steps, logs        |
| 3     | What happened in this step?     | Step drawer: timing, inputs, logs, child runs |
| 4     | Which exact records are these?  | Run Details tab: IDs, events, definition hash |

Non-goals for this stage: graph-driven launch with a live plan, a timed
(Gantt) timeline, ⌘K search, and per-domain grouping. They build on this layout.

## Layout

```text
┌ rail ────────────┬ main ─────────────────────────────────────────────────────┐
│ Tubeless         │ Activity                                                  │
│ ◉ Activity  2    │   2 running · 13 runs · 69% succeeded                     │
│ PIPELINES  [⌕]   │   run list across pipelines (running first, paged)        │
│ ● import    ▪▪▪▫ │                                                           │
│ ● enrich    ▪▪▪▪ ├───────────────────────────────────────────────────────────┤
│ ○ publish        │ ● Import rows                                   [Run]     │
│ ▸ Nested (3)     │   Runs | Graph | Versions                                 │
│                  ├───────────────────────────────────────────────────────────┤
│ store · clear    │ import / Run 9:16 PM                                      │
│                  │ ┌ runs ┐┌ run ─────────────────────────────────────────┐  │
│                  │ │ ...  ││ Failed at validate · 1 skipped    [status]    │  │
│                  │ │      ││ errors · Steps | Logs | Nested | Details      │  │
│                  │ │      ││ ┌ timeline or graph ┐┌ step drawer ────────┐ │  │
│                  │ │      ││ │ ...               ││ validate · inputs   │ │  │
│                  │ │      ││ └───────────────────┘└─────────────────────┘ │  │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

### Rail

- **Activity** opens the cross-pipeline run list and shows the running count.
- **Pipelines** lists every known pipeline: registered commands plus pipelines with
  recorded top-level runs, sorted by display name, with a local filter field. Each
  row shows a status dot for the latest run (spinning when running) and a strip of
  up to ten recent run outcomes. Commands without runs show no strip.
- **Nested pipelines** is a collapsed group for pipelines recorded only as child
  runs, so their runs and versions stay reachable.
- The footer keeps connection, store, and Clear history.
- The Pipelines card grid and the global Definitions view are removed. Launching
  moves to each pipeline page (and the existing top-bar **Run pipeline** button);
  definitions become that pipeline's **Versions** tab.

### Activity (level 0)

The default page with no URL state. A compact line replaces the summary cards:
running count, recorded runs, and success rate. Below it is the existing run list
across pipelines: running first, searchable, paged by 50. Selecting a run opens the
run page with the list scoped to all pipelines.

### Pipeline page (level 1)

Header: display name, description, latest-run status, and **Run** when a command is
registered. Tabs:

- **Runs** (default): this pipeline's runs at any depth, newest first, paged.
- **Graph**: the pipeline's step graph without run state. It comes from the latest
  observed definition snapshot; for a command that has never run, from its plan
  preview. Selecting a step opens the drawer with its description, inputs,
  consumers, and failure gates. Step metadata stays in the Versions tab's
  **Explore steps**.
- **Versions**: today's observed-definitions panel scoped to this pipeline,
  including **Compare from**. Hidden when no definition was recorded.

### Run page (level 2)

Two columns at desktop width: a narrow run list (scoped to the pipeline, or to all
pipelines when opened from Activity) and the run. The step drawer opens beside the
steps inside the run, so it stays next to what it describes and follows scrolling.

- A breadcrumb above the page title replaces the kicker: `import / Run 9:16 PM`.
  Nested runs extend it through ancestors and the starting step:
  `import / Run 9:16 PM / enrich-rows / enrich / Run 9:16 PM · item 3`.
- The run header leads with the outcome line, then status, copy-link, and Cancel,
  plus one compact meta line (start time, age, duration, correlation ID).
- Error diagnostics stay above the tabs when the run failed.
- Tabs: **Steps** (Timeline/Graph toggle, unchanged), **Logs (n)**,
  **Nested runs (n)**, and **Details** (run, correlation, and definition IDs; event
  count; implementation version). Tabs with nothing to show are omitted.

### Step drawer (level 3)

Selecting a timeline row or graph node opens one drawer, shared by both views.
It shows the step's status and outcome, skip explanation, timing, retries, inputs
and consumers (each selectable), failure gates, artifacts, progress items, the
step's own logs, the run error when this step failed, and its child runs with
**Open run**. Edge, nested-run, and dynamic-item selections from the graph render
in the same drawer. Escape or × closes it. Selecting another run clears it.

## URL state

| URL                          | Page                                   |
| ---------------------------- | -------------------------------------- |
| `?` (none)                   | Activity                               |
| `?pipeline=import`           | Pipeline page, Runs tab                |
| `?pipeline=import&tab=graph` | Pipeline page, Graph or Versions tab   |
| `?run=<id>`                  | Run page, list scoped to all pipelines |
| `?pipeline=import&run=<id>`  | Run page, list scoped to `import`      |
| `…&step=<id>`                | Run page with that step's drawer open  |

Existing `?run=<id>` links keep working. Navigation pushes history entries, so Back
and Forward move between levels. Tab and drawer changes replace the current entry,
so Back leaves the run instead of replaying every click. A pipeline that is neither
registered nor recorded shows an unavailable state with a link to Activity, like an
unavailable run.

## Data and API

Two additions to the internal snapshot endpoint; everything else already exists.

1. `GET /api/snapshot?pipeline=<id>` returns that pipeline's runs at any depth,
   newest first, using the existing paging and `query` search. Without it the
   endpoint keeps returning top-level runs.
2. The snapshot gains `pipelines`: one entry per recorded pipeline ID with
   `topLevelRunCount`, `nestedRunCount`, `runningCount`, `latestStartedAtMs`, and
   `recent` (up to ten `{ runId, status }`, newest first, top-level runs when any
   exist, otherwise nested runs). It is bounded like other lists and derived from
   the same history index. The ETag already covers it.

The client merges `pipelines` with the command catalog to build the rail. The Graph
tab uses the existing definition and plan endpoints. No storage, trace, or
projection change is needed.

## Ownership

| Module                                           | Responsibility                            |
| ------------------------------------------------ | ----------------------------------------- |
| `run-store-ui-route.ts` (new)                    | Parse and serialize URL state; pure       |
| `run-store-ui-rail.tsx` (new)                    | Rail, pipeline list, recent-outcome strip |
| `run-store-ui-pipeline.tsx` (new)                | Pipeline page and its tabs                |
| `run-store-ui-inspector.tsx` (new)               | Shared step drawer content                |
| `run-store-ui-runs.tsx`                          | Activity list, run page, tabs, breadcrumb |
| `run-store-ui-graph.tsx`                         | Graph canvas; inspector content moves out |
| `run-store-ui-definitions.tsx`                   | Versions tab, scoped to one pipeline      |
| `run-store-ui-data-controller.ts`                | History scope gains an optional pipeline  |
| `run-store-ui-state.ts`, `-api.ts`, `-schema.ts` | Pipeline filter and summaries             |

`RunGraph` follows the page's selected step (`selectedStepId`) and reports step
selections back (`onSelectStep`), so the URL and the timeline share one selection.
It still owns edge, nested-run, and item selections because they need its scene
context for expanded child runs. Both views render their selection in the shared
`Drawer`, and step selections use the shared `StepInspector`. The Pipelines card
view (`run-store-ui-pipelines.tsx`) keeps `PlanView` for the launch form; the card
grid is deleted.

## Responsive behavior

- Wider than 1280 px: rail, run list, and run side by side, with the drawer beside
  the steps.
- 980–1280 px: the drawer overlays the run from the right instead of taking space.
- 680–980 px: the rail narrows and the run list stacks above the run.
- Narrower than 680 px: the rail becomes a top bar with Activity, a pipeline picker,
  and Clear history; the drawer covers the page.

## Verification

- Unit tests: route parsing and serialization, the pipeline filter and summaries in
  `PipelineRunStudioEventState`, the rail merge of commands with recorded pipelines,
  and render tests for the rail, pipeline page, run tabs, breadcrumb, and drawer.
- Existing Studio tests keep passing, including gateway, NDJSON read-only, and
  unavailable-run cases; tests that assert removed surfaces are updated.
- Browser check over seeded failed, fan-out, and nested runs at 1440, 1100, and
  600 px: rail → pipeline → run → step → child run → Back.
- `docs/studio.md` is rewritten for the new navigation, and the website is rebuilt.
