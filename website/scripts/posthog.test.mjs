import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const websiteRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const astroCli = join(websiteRoot, "node_modules", ".bin", "astro");
const builtHtml = await readFile(join(websiteRoot, "dist", "index.html"), "utf8");

function assertDisabled(html) {
  assert.doesNotMatch(html, /window\.__posthog_initialized/);
  assert.doesNotMatch(html, /\/static\/array\.js/);
}

function assertEnabled(html, expected) {
  assert.match(html, /window\.__posthog_initialized/);
  assert.match(html, /autocapture:\s*false/);
  assert.match(html, /disable_session_recording:\s*true/);
  assert.match(html, /script\.src\s*=\s*config\.asset_host/);

  if (expected) {
    assert.ok(html.includes(JSON.stringify(expected.projectKey)));
    assert.ok(html.includes(JSON.stringify(expected.apiHost)));
    assert.ok(html.includes(JSON.stringify(expected.assetHost)));
  }
}

async function buildWith(config) {
  // Astro renames prerendered assets into outDir, which fails across filesystems
  // (EXDEV) when the OS temp directory is a separate mount, as on some CI runners.
  const scratch = join(websiteRoot, ".astro");
  await mkdir(scratch, { recursive: true });
  const outDir = await mkdtemp(join(scratch, "posthog-test-"));
  const env = {
    ...process.env,
    PUBLIC_POSTHOG_HOST: config.apiHost ?? "",
    PUBLIC_POSTHOG_KEY: config.projectKey ?? "",
  };

  try {
    await execFileAsync(process.execPath, [astroCli, "build", "--outDir", outDir], {
      cwd: websiteRoot,
      env,
    });
    return await readFile(join(outDir, "index.html"), "utf8");
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
}

test("the production artifact matches the PostHog build configuration", () => {
  if (builtHtml.includes("window.__posthog_initialized")) assertEnabled(builtHtml);
  else assertDisabled(builtHtml);
});

test("an analytics-disabled build omits PostHog", async () => {
  assertDisabled(await buildWith({}));
});

test("an analytics-enabled build uses the regional asset host", async () => {
  const config = {
    apiHost: "https://us.i.posthog.com",
    assetHost: "https://us-assets.i.posthog.com",
    projectKey: "phc_test",
  };

  assertEnabled(await buildWith(config), config);
});

test("a partial analytics configuration fails the build", async () => {
  await assert.rejects(
    buildWith({ projectKey: "phc_test" }),
    (error) =>
      error instanceof Error &&
      `${error.stdout ?? ""}${error.stderr ?? ""}`.includes(
        "PUBLIC_POSTHOG_KEY and PUBLIC_POSTHOG_HOST must be set together",
      ),
  );
});
