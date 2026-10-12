import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteDocLinks } from "./doc-links";
import { GITHUB_BLOB, absUrl, href } from "./paths";

const docsDir = join(__REPO_ROOT__, "docs");

export type DocPage = {
  slug: string;
  title: string;
  description: string;
};

export const DOC_NAV = [
  { slug: "getting-started", label: "Getting started", blurb: "Build, run, and test your first pipeline." },
  { slug: "recipes", label: "Recipes", blurb: "Examples by use case." },
  { slug: "concepts", label: "Concepts", blurb: "Understand dependencies, results, failures, and execution controls." },
  { slug: "cli", label: "CLI", blurb: "Select and run commands, record results, and inspect history." },
  { slug: "step-output-cache", label: "Step output caching", blurb: "Reuse deterministic outputs with explicit keys, versions, and cache policies." },
  { slug: "artifacts", label: "Artifacts", blurb: "Load, save, and trace typed artifacts with dry-run safety." },
  { slug: "graph-metadata", label: "Graph metadata", blurb: "Describe ownership, tags, and annotations; query graphs without changing execution." },
  { slug: "studio", label: "Studio", blurb: "Inspect recorded runs and launch commands in your browser." },
  {
    slug: "declarative-pipelines",
    label: "YAML and JSON",
    blurb: "Compile YAML or JSON with an application registry, then run or register selected pipelines.",
  },
  { slug: "comparison", label: "Comparison", blurb: "Compare Tubeless with Hamilton, Prefect, Temporal, and other job runners." },
  { slug: "child-pipeline-composition", label: "Child pipelines", blurb: "Reuse a workflow once or run it for a list of items." },
  { slug: "agents", label: "In-process agents", blurb: "Connect an LLM or scripted decisions to validated tools and owned state." },
  { slug: "remote-step-composition", label: "Remote steps", blurb: "Call remote services and invoke pipelines from workers." },
  { slug: "airflow", label: "Tubeless ↔ Airflow", blurb: "Invoke Airflow DAGs and run Tubeless pipelines inside Airflow tasks." },
  { slug: "temporal", label: "Tubeless on Temporal", blurb: "Run pipelines inside Temporal Activities with retries, heartbeats, and cancellation." },
  { slug: "inngest", label: "Tubeless on Inngest", blurb: "Run pipelines inside durable steps with retries, memoized results, and correlated logs." },
  { slug: "dagster", label: "Tubeless on Dagster", blurb: "Materialize assets through Dagster Pipes with progress, data versions, and traces." },
  { slug: "step-functions", label: "Tubeless on Step Functions", blurb: "Run pipelines in AWS Lambda Tasks with retries, deadlines, and correlated logs." },
  { slug: "deploy-cloudflare", label: "Deploy to Cloudflare", blurb: "Host Studio and pipelines in your account behind Access, and plan for the 14-minute run limit." },
  { slug: "agent-guide", label: "Agent guide", blurb: "Rules for generating pipeline code." },
  { slug: "agent-skills", label: "Agent skills", blurb: "Install the skill pack and convert existing code into pipelines." },
  { slug: "api-reference", label: "API reference", blurb: "Public exports and TypeScript signatures, generated from the package." },
] as const;

export const DOC_SLUGS = new Set(DOC_NAV.map((item) => item.slug));

export function loadDoc(slug: string): DocPage {
  const source = readFileSync(join(docsDir, `${slug}.md`), "utf8");
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, "") ?? slug;
  const description =
    source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("|")) ?? title;
  return { slug, title, description };
}

// Keep agent downloads aligned with the exact sources rendered by this build.
export function loadMarkdown(slug: string): string {
  if (!DOC_SLUGS.has(slug as (typeof DOC_NAV)[number]["slug"])) {
    throw new Error(`Unknown documentation page: ${slug}`);
  }
  return rewriteDocLinks(readFileSync(join(docsDir, `${slug}.md`), "utf8"), href)
    .replace(/\]\((\/[^)]+)\)/g, (_match, path: string) => {
      const url = new URL(path, absUrl());
      if (url.pathname.startsWith(href("docs/"))) url.pathname += ".md";
      return `](${url.href})`;
    });
}
