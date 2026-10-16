import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./workbench-init.js";
import { CLOUDFLARE_DEV_DEPENDENCIES } from "./workbench-init-cloudflare.js";

const run = promisify(execFile);
const repo = resolve(".");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const PROJECT = `
import { createSteps, definePipeline } from "tubeless";
import { defineProject } from "tubeless/project";
const schema = { "~standard": { vendor: "t", version: 1, validate: (value) => ({ value }),
  jsonSchema: { input: () => ({ type: "object", properties: {} }) } } };
const { step } = createSteps(schema);
const only = step("only", { run: () => 1 });
export default defineProject("cf-build", [definePipeline({ id: "only", steps: [only], finalize: only })]);
`;

/**
 * A project after `tubeless init cloudflare` and the install its next steps print: the manifest
 * declares exactly the pinned tooling, and node_modules links this checkout's copies of it.
 */
function installedProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tubeless-cf-build-"));
  roots.push(cwd);
  const modules = join(cwd, "node_modules");
  mkdirSync(join(modules, ".bin"), { recursive: true });
  mkdirSync(join(modules, "@cloudflare"));
  symlinkSync(repo, join(modules, "tubeless"), "dir");
  for (const name of Object.keys(CLOUDFLARE_DEV_DEPENDENCIES))
    symlinkSync(join(repo, "node_modules", name), join(modules, name), "dir");
  symlinkSync("../cf/bin/cf", join(modules, ".bin", "cf"));
  symlinkSync("../vite/bin/vite.js", join(modules, ".bin", "vite"));
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "cf-build",
      private: true,
      type: "module",
      dependencies: { tubeless: "*" },
      devDependencies: CLOUDFLARE_DEV_DEPENDENCIES,
    })
  );
  writeFileSync(join(cwd, "tubeless.project.mjs"), PROJECT);
  return cwd;
}

/** No stored credentials, account variables, telemetry or test-runner settings reach cf. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(CLOUDFLARE_|CF_|VITEST|VITE_)/.test(key) && key !== "NODE_ENV"
    )
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CF_SEND_TELEMETRY: "false",
    npm_config_update_notifier: "false",
  };
}

/**
 * Preloaded into every Node process the build spawns (via NODE_OPTIONS): any outbound,
 * non-loopback connection is logged and refused, so a tooling change that starts
 * downloading or calling Cloudflare fails this test instead of passing online only.
 */
const NETWORK_GUARD = `
import net from "node:net";
import { appendFileSync } from "node:fs";
const log = process.env.TUBELESS_TEST_NETWORK_LOG;
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first : undefined;
  const host = options
    ? (options.path ? undefined : (options.host ?? options.hostname ?? "localhost"))
    : typeof first === "number"
      ? (typeof args[1] === "string" ? args[1] : "localhost")
      : undefined;
  if (host !== undefined && !loopback.has(host)) {
    appendFileSync(log, "connect " + host + "\\n");
    throw new Error("Network access is blocked in this offline test: " + host);
  }
  return connect.apply(this, args);
};
`;

/** Environment that preloads the network guard and records blocked attempts in `log`. */
function offlineEnv(env: NodeJS.ProcessEnv, guard: string, log: string): NodeJS.ProcessEnv {
  const preload = `--import=${pathToFileURL(guard).href}`;
  return {
    ...env,
    // Miniflare (inside @cloudflare/vite-plugin) downloads optional request.cf metadata from
    // workers.cloudflare.com and falls back when offline; disable only that known fetch so any
    // other outbound connection still fails this test.
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload,
    TUBELESS_TEST_NETWORK_LOG: log,
  };
}

describe("cloudflare scaffold build", () => {
  // `cf build` produces Build Output locally without an account or network; it is the step
  // `cf deploy` runs first. The pinned versions must stay in lockstep with this checkout.
  it("builds with cf build using only the scaffold files and pinned tooling", async () => {
    for (const [name, version] of Object.entries(CLOUDFLARE_DEV_DEPENDENCIES)) {
      const installed = JSON.parse(
        readFileSync(join(repo, "node_modules", name, "package.json"), "utf8")
      ) as { version: string };
      expect(installed.version, name).toBe(version);
    }
    const cwd = installedProject();
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd,
      stdout: { write: (chunk: string) => void out.push(chunk) },
      stderr: { write: (chunk: string) => void err.push(chunk) },
    };
    expect(
      await runInit(["cloudflare", "--project", "tubeless.project.mjs"], io),
      err.join("")
    ).toBe(0);
    const home = join(cwd, ".home");
    mkdirSync(home);
    const guard = join(cwd, "network-guard.mjs");
    const networkLog = join(cwd, "network.log");
    writeFileSync(guard, NETWORK_GUARD);
    const env = offlineEnv(isolatedEnv(home), guard, networkLog);
    // The guard must be active: a plain outbound fetch from the same environment fails and is logged.
    await expect(
      run(process.execPath, ["-e", "await fetch('https://example.com')"], { cwd, env })
    ).rejects.toThrow();
    expect(readFileSync(networkLog, "utf8")).toContain("connect example.com");
    rmSync(networkLog);
    const build = await run(process.execPath, [join(repo, "node_modules/cf/bin/cf"), "build"], {
      cwd,
      env,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    }).catch((error: { code?: unknown; stdout?: string; stderr?: string }) => {
      throw new Error(`cf build failed (${String(error.code)}):\n${error.stdout}\n${error.stderr}`);
    });
    expect(
      existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "",
      "cf build attempted outbound network access"
    ).toBe("");
    const output = join(cwd, ".cloudflare/output/v0/workers/default");
    const config = JSON.parse(readFileSync(join(output, "worker.config.json"), "utf8")) as {
      exports: Record<string, unknown>;
      env: Record<string, { type: string }>;
    };
    expect(Object.keys(config.exports).sort(), build.stdout).toEqual([
      "TubelessRun",
      "TubelessStudio",
    ]);
    expect(config.env.TUBELESS_BUCKET?.type).toBe("r2");
    expect(readFileSync(join(output, "bundle/index.js"), "utf8")).toContain("TubelessStudio");
  }, 120_000);
});
