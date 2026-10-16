export const USE_CASES_INTRO = "Tubeless runs TypeScript functions as steps in a pipeline. Here are some ways to use it, with example workflows and links to working code.";

export const USE_CASES = [
  {
    id: "ci-cd",
    label: "CI/CD",
    headline: "Build and release software",
    summary: "Run the same release logic locally and in your CI runner.",
    description: "A release pipeline can build an artifact, run checks, and publish once those checks pass. The same code runs locally and in CI. Tubeless uses this setup for its own CI, where it runs linting, type checks, tests, documentation checks, and package verification.",
    stages: ["Build artifact", "Validate", "Publish"],
    benefits: [
      { title: "Release previews", detail: "Preview a target and its prerequisites without executing steps. Mark publication steps to skip during dry runs." },
      { title: "Debugging failed builds", detail: "Record step results, timings, and logs. Export an NDJSON trace as a CI artifact to inspect after the job ends." },
    ],
    boundary: "The pipeline runs inside a CI job. Runners, secrets, triggers, and approvals stay in your CI configuration.",
    recipes: [
      { label: "Publication with failure gates", file: "publish-with-gates.ts" },
      { label: "Pipeline-backed CLI", file: "automatic-cli.ts" },
    ],
    guide: { label: "CLI documentation", path: "cli" },
  },
  {
    id: "ml-flows",
    label: "ML flows",
    headline: "Prepare data and evaluate models",
    summary: "Coordinate dataset preparation, training jobs, and evaluation.",
    description: "Use a pipeline to prepare a dataset, submit a training job, and evaluate the resulting model. Training can run on a remote service while preparation and evaluation use your existing functions.",
    stages: ["Prepare dataset", "Train remotely", "Evaluate", "Register model"],
    benefits: [
      { title: "Comparing models", detail: "Run the same evaluation pipeline for several datasets or model candidates. Limit how many run at once and track progress for each." },
      { title: "Checking training results", detail: "Validate the training service’s response with a schema. An evaluation step can reject models that fail your criteria and block registration." },
    ],
    boundary: "You’ll still need a training service for GPU jobs and model tracking. Job delivery and retries across process restarts need an external host.",
    recipes: [
      { label: "Validated remote calls", file: "remote-steps.ts" },
      { label: "Fan-out with progress", file: "fan-out-progress.ts" },
    ],
    guide: { label: "Remote step documentation", path: "remote-step-composition" },
  },
  {
    id: "llm-workflows",
    label: "LLM workflows",
    headline: "Process documents with an LLM",
    summary: "Retrieve context, call a model, and validate its response.",
    description: "A document processing job might retrieve context, call a model, and check the response before saving it. Write the prompts and provider calls as ordinary functions; Tubeless tracks their progress and results.",
    stages: ["Retrieve context", "Generate", "Validate output", "Save result"],
    benefits: [
      { title: "API limits and retries", detail: "Retry and rate-limit helpers wrap provider calls. When processing documents in parallel, you can cap concurrency and pass cancellation through to each request." },
      { title: "Checking model output", detail: "Check structured responses against a schema before saving them. A custom dry-run handler can return a sample response without making a paid model call." },
    ],
    boundary: "Use whichever model SDK and retrieval system you already work with. For dynamic tool selection, tubeless/agent adds a bounded agent loop with default workspace tools and optional OpenAI and Anthropic adapters that work with compatible APIs.",
    recipes: [
      { label: "Retry and rate-limit calls", file: "resumable-enrichment.ts" },
      { label: "Validate output boundaries", file: "validated-boundaries.ts" },
    ],
    guide: { label: "Child pipeline documentation", path: "child-pipeline-composition" },
  },
  {
    id: "data-pipelines",
    label: "Data pipelines",
    headline: "Import and transform data",
    summary: "Import records, enrich them through an API, and write the results.",
    description: "Split an import into steps for reading, normalizing, enriching, and writing records. Each step declares which outputs it needs, so TypeScript can check the data passed between them.",
    stages: ["Extract", "Normalize", "Enrich", "Write"],
    benefits: [
      { title: "Batch progress and failures", detail: "Report how many items have completed and identify which child pipeline items failed. Checkpointed batch helpers can track completed work for a later run." },
      { title: "Dry runs", detail: "Configure write steps to skip during a dry run, or return a preview without changing data. Recorded runs include logs and timings you can inspect in the local Studio." },
    ],
    boundary: "You write the source and destination connectors and decide when to save checkpoints. Tubeless runs in your process. Distributed scheduling and crash recovery require an external host.",
    recipes: [
      { label: "Typed import pipeline", file: "typed-import.ts" },
      { label: "Checkpointed enrichment", file: "resumable-enrichment.ts" },
    ],
    guide: { label: "All recipes", path: "recipes" },
  },
  {
    id: "operational-workflows",
    label: "Operational workflows",
    headline: "Run maintenance tasks",
    summary: "Run tenant setup, migrations, and other maintenance commands.",
    description: "Register maintenance scripts as named commands with declared inputs. Teammates can see what’s available, preview a task, and follow its progress when they run it.",
    stages: ["Check inputs", "Plan changes", "Apply changes", "Verify"],
    benefits: [
      { title: "Shared commands", detail: "Group pipelines with defineProject to share them with your team. Schema-backed pipelines run from the terminal or launch through the local Studio." },
      { title: "Troubleshooting a run", detail: "Record runs to see which steps completed before a failure or cancellation. For commands that change data, add a dry-run handler so teammates can review the proposed changes first." },
    ],
    boundary: "Your application handles permissions and credentials. If a run stops after making some changes, it also needs to handle cleanup or recovery; cancellation doesn’t roll those changes back.",
    recipes: [
      { label: "Project with custom adapters", file: "project/tubeless.project.ts" },
      { label: "Cancellation and testing", file: "cancellation-and-testing.ts" },
    ],
    guide: { label: "Studio documentation", path: "studio" },
  },
];
