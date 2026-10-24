/** Pipeline page tabs other than the default run list. */
export type StudioPipelineTab = "graph" | "versions";

/**
 * Studio navigation state carried in the page URL. A run ID selects the run page;
 * otherwise a pipeline ID selects that pipeline's page; with neither, Activity.
 * On the run page the pipeline scopes the run list instead of naming a page.
 */
export interface StudioRoute {
  pipelineId?: string;
  runId?: string;
  /** Step drawer on the run page. */
  stepId?: string;
  /** Pipeline page tab; absent for the default run list. */
  tab?: StudioPipelineTab;
}

export type StudioPage = "activity" | "pipeline" | "run";

const ROUTE_KEYS = ["pipeline", "run", "step", "tab"] as const;

export function studioPage(route: StudioRoute): StudioPage {
  return route.runId ? "run" : route.pipelineId ? "pipeline" : "activity";
}

/** Drop parameters that do not apply to the selected page. */
function normalizeStudioRoute(raw: {
  pipelineId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  tab?: string | null;
}): StudioRoute {
  const route: StudioRoute = {};
  if (raw.pipelineId) route.pipelineId = raw.pipelineId;
  if (raw.runId) {
    route.runId = raw.runId;
    if (raw.stepId) route.stepId = raw.stepId;
  } else if (raw.pipelineId && (raw.tab === "graph" || raw.tab === "versions")) {
    route.tab = raw.tab;
  }
  return route;
}

export function parseStudioRoute(href: string): StudioRoute {
  const params = new URL(href).searchParams;
  return normalizeStudioRoute({
    pipelineId: params.get("pipeline"),
    runId: params.get("run"),
    stepId: params.get("step"),
    tab: params.get("tab"),
  });
}

/** The same page URL with only this route's parameters; the mount path is preserved. */
export function studioRouteUrl(href: string, route: StudioRoute): string {
  const url = new URL(href);
  for (const key of ROUTE_KEYS) url.searchParams.delete(key);
  const { pipelineId, runId, stepId, tab } = normalizeStudioRoute(route);
  if (pipelineId) url.searchParams.set("pipeline", pipelineId);
  if (runId) url.searchParams.set("run", runId);
  if (stepId) url.searchParams.set("step", stepId);
  if (tab) url.searchParams.set("tab", tab);
  return url.href;
}

export function sameStudioRoute(left: StudioRoute, right: StudioRoute): boolean {
  return (
    left.pipelineId === right.pipelineId &&
    left.runId === right.runId &&
    left.stepId === right.stepId &&
    left.tab === right.tab
  );
}
