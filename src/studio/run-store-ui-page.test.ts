import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStudioPage, PIPELINE_RUN_STUDIO_STYLE } from "./run-store-ui-page.js";
import { readStudioClientScript } from "./run-store-ui-page-node.js";
import { startPipelineRunStudio } from "./run-store-ui.js";

const PIPELINE_RUN_STUDIO_SCRIPT = readStudioClientScript();

describe("pipeline run studio page composition", () => {
  it("embeds one compiled Studio script as a native module", async () => {
    const PIPELINE_RUN_STUDIO_HTML = (await createStudioPage(PIPELINE_RUN_STUDIO_SCRIPT)).html("");
    expect(PIPELINE_RUN_STUDIO_HTML.match(/<script type="module">/g)).toEqual([
      '<script type="module">',
    ]);
    expect(PIPELINE_RUN_STUDIO_HTML.match(/<\/html>/g)).toEqual(["</html>"]);
    expect(PIPELINE_RUN_STUDIO_SCRIPT).toContain("#studio-root");
    expect(PIPELINE_RUN_STUDIO_SCRIPT).not.toMatch(/\bimport\s/);
    expect(PIPELINE_RUN_STUDIO_HTML).toContain(
      `<script type="module">${PIPELINE_RUN_STUDIO_SCRIPT}</script>`
    );
    expect(PIPELINE_RUN_STUDIO_HTML).toContain(`<style>${PIPELINE_RUN_STUDIO_STYLE}</style>`);
  });

  it("keeps the studio shell tokens the existing tests rely on", async () => {
    const PIPELINE_RUN_STUDIO_HTML = (await createStudioPage(PIPELINE_RUN_STUDIO_SCRIPT)).html("");
    expect(PIPELINE_RUN_STUDIO_HTML).toContain("<title>Tubeless — Studio</title>");
    expect(PIPELINE_RUN_STUDIO_HTML).toContain('id="studio-root"');
    expect(PIPELINE_RUN_STUDIO_SCRIPT).toContain("data-run-id");
    expect(PIPELINE_RUN_STUDIO_SCRIPT).toContain("Pipeline runs");
  });

  it("pins the served CSP hashes to the composed inline script and style", async () => {
    const server = await startPipelineRunStudio({
      port: 0,
      store: {
        close() {},
        export() {},
        async listEvents() {
          return [];
        },
      },
    });
    try {
      const page = await fetch(server.url);
      const csp = page.headers.get("content-security-policy") ?? "";
      const html = await page.text();
      const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1];
      const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1];
      expect(script).toBe(PIPELINE_RUN_STUDIO_SCRIPT);
      expect(style).toBe(PIPELINE_RUN_STUDIO_STYLE);
      const scriptHash = `'sha256-${createHash("sha256")
        .update(script ?? "")
        .digest("base64")}'`;
      const styleHash = `'sha256-${createHash("sha256")
        .update(style ?? "")
        .digest("base64")}'`;
      expect(csp).toBe(
        `default-src 'none'; style-src ${styleHash}; script-src ${scriptHash}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      );
    } finally {
      await server.close();
    }
  });
});
