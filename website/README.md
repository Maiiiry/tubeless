# Tubeless website

Human docs site plus agent entrypoints. **Not part of the npm package.**

Source of truth for long-form docs remains `../docs/*.md`. This project renders
those files and adds the landing, start, use-cases, brand, developer-resource, and agents pages.

## Local

```sh
cd website
bun ci
bun run dev
```

From the package root: `make website`.

## Analytics

PostHog pageview analytics are optional. Copy `.env.example` to `.env` for a
local analytics-enabled build, or configure both `PUBLIC_POSTHOG_KEY` and
`PUBLIC_POSTHOG_HOST` as GitHub Actions repository variables for production.
Use the project key and ingestion host from the PostHog Web analytics install
snippet. These values are public browser configuration, not secrets.

When configured, the site captures pageview and page-leave events. Interaction
autocapture, person profiles for anonymous visitors, and session recording stay
disabled. When neither variable is configured, Astro omits PostHog entirely.
The build fails when only one variable is set.

## Update content

| Change | Edit |
| --- | --- |
| Concepts, CLI, recipes, agent rules | `../docs/*.md` then rebuild |
| Landing copy | `src/pages/index.astro` |
| Featured use cases | `src/data/use-cases.ts` shares copy between `src/pages/use-cases.astro`, its Markdown download, and homepage cards. The featured Agents card lives in `src/pages/index.astro` and links to the agent overview |
| Use-case animations | `src/data/workflow-scenes.ts` defines illustrative fan-out and DAG scenes; `WorkflowAnimation.astro` animates cargo along their tracks and `WorkflowObject.astro` draws dimensional machines. Includes pause controls, offscreen pausing, and reduced-motion support |
| Animated stage pipe | `src/components/PipelineFlow.astro`; weaves behind the hero and homepage stages, ending in a pulse-synchronized completion bucket, with responsive curves and reduced-motion support |
| Agent execution graph | `src/components/AgentGraph.astro`; illustrates successive model turns, branching tool calls, and a nested subagent on the agent overview page. Uses a scripted animation, not recorded data. Includes playback controls, offscreen pausing, and a static reduced-motion view. |
| Recorded-run context | `src/data/agent-recordings.ts` describes the starting fixtures and expected outcomes for `public/agent-evaluation.json`, shared by the replay and Markdown page. Keep it matched to the recorded fixture version when replacing the recordings. The exact task comes from the recording itself. |
| Recording provenance | The evaluator captures `sourceHashes` before running. Retain those hashes when sanitizing the report; the website build verifies them against the candidate sources. Regenerate the recording after changing those sources. |
| Package version and engines | `../package.json` via `src/lib/package.ts` |
| Route catalog | `src/lib/docs.ts` (`DOC_NAV`; static paths and doc nav) |
| Rendered-link check | `scripts/check-built-links.mjs` (runs after `astro build`) |
| CLI tapes | `src/data/tapes.ts` (used on Start) |
| Studio screenshot | `public/studio.png` (recapture from `tubeless ui`) |
| Markdown downloads and full text | `src/pages/*.md.ts`, `src/pages/docs/[slug].md.ts`, `src/pages/llms-full.txt.ts`; generated from `DOC_NAV` and `../docs/*.md` |
| Agent URL table | `src/pages/agents.astro`, `src/pages/llms.txt.ts` |
| Agent overview | `src/pages/agent-harness.astro` and its Markdown alternate explain execution, composition, and setup. Recorded test tasks live on the separate examples page. |
| Agent examples and recordings | `src/pages/agent-examples.astro` and its Markdown alternate; `AgentReplay.astro` displays `public/agent-evaluation.json`. Update the recording only from a passing opt-in evaluation, retaining model/effort/date and replacing disposable workspace prefixes with `<workspace>`. Preserve failed attempts in the candidate's acceptance evidence. `public/agent-delegation.json` is separate, scripted CLI history with local stack paths removed. No live calls run during site builds or replay. |
| Developer resource hub | `src/pages/developers.astro`, `src/pages/developers.md.ts` |
| Brand page and downloadable assets | `src/pages/brand.astro`, `src/pages/brand.md.ts`, and `public/wordmark*.svg`; the square mark remains `public/logo.svg`. The brand page also previews and links to the social share JPEG |
| Homepage Markdown overview | `src/pages/index.md.ts`; advertised in the homepage head and `llms.txt` |
| Visual system | `src/styles/global.css` |
| Logo and social card | `../docs/assets/logo.svg` and `../docs/assets/social.svg`; `bun scripts/rasterize-og.mjs` writes `public/og.jpg` at 1200×630 JPEG. `src/lib/social-image.ts` shares the image URL and alt text between site metadata and the brand page, with a content hash to refresh crawler caches whenever the artwork changes. `bun scripts/rasterize-icon.mjs` writes `public/apple-touch-icon.png` at 180×180. `public/og.png` is a historical URL only |

Refresh captured CLI tapes by running the workbench against `examples/` and
replacing the strings in `src/data/tapes.ts`.

## Deploy

The GitHub repo already uses **GitHub Actions** as the Pages source.
`.github/workflows/pages.yml` is the deploy job: it builds `website/` on
`main` and uploads `website/dist`.

- Site: `https://tubeless.io`
- Custom domain source: `public/CNAME`
- Package `make check` does not include this project

Every documentation page links to its `.md` counterpart. `/llms.txt` lists all
Markdown URLs; `/llms-full.txt` bundles the same build’s docs with the agent guide
first. Links in Markdown are absolute, so downloaded context remains navigable.
These routes use the same documentation catalog as the human navigation.

## Agent readiness and hosting boundaries

The build checks `llms.txt` against the [published file-list format](https://llmstxt.org/),
checks homepage [SoftwareApplication](https://schema.org/SoftwareApplication) JSON-LD,
and verifies the [sitemap](https://www.sitemaps.org/protocol.html) covers every human
page except the noindex 404. Every human page advertises its Markdown
alternate in the HTML head. The existing 404 design includes a short Markdown
recovery block, also downloadable at `/404.md`. That download is a normal
static file (200); unknown paths must still return 404 from the host.

GitHub Pages serves static files. Astro endpoint headers are build-time metadata;
adding `Vary` to a static endpoint does not configure Pages responses.
The site therefore **does not implement Accept negotiation**. For
[acceptmarkdown.com compliance](https://acceptmarkdown.com/), choose a host or edge
layer that can serve HTML and Markdown from the same URL, honor media ranges and
quality values (including `q=0`), return 406 for unsupported types, and add
`Vary: Accept` to both variants while preserving `Accept-Encoding`. Test both cache
orders, GET and HEAD, and unknown paths before claiming compliance. A true
`text/markdown` 404 response also needs that layer. Do not replace unknown paths
with the homepage or add a client-side redirect.

Keep GitHub Pages for now; Accept negotiation remains an accepted hosting limitation.
The canonical site is `https://tubeless.io/`. Astro builds it at the domain root,
and `public/CNAME` keeps the deployed artifact aligned with the Pages custom-domain
setting. The apex DNS records point to GitHub Pages; `www.tubeless.io` points to
`chetmancini.github.io` so Pages can redirect it to the canonical apex domain.
Keep HTTPS enforcement enabled in the repository's Pages settings. The homepage
title, canonical URL, sitemap, and structured data use Tubeless as the product name
and Chet Mancini as its author. Submit `/sitemap.xml` through the domain's search
console property after deployment; indexing and rank still depend on the search
engine and inbound links.
