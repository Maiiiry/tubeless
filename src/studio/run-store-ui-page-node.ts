import { existsSync, readFileSync } from "node:fs";

const distributedClientUrl = new URL("./run-store-ui-client-browser.js", import.meta.url);
const workspaceClientUrl = new URL(
  "../../dist/studio/run-store-ui-client-browser.js",
  import.meta.url
);

/** Compiled Studio client inlined into the served page. Refresh with `bun run build`. */
export function readStudioClientScript(): string {
  return readFileSync(
    existsSync(distributedClientUrl) ? distributedClientUrl : workspaceClientUrl,
    "utf8"
  );
}
