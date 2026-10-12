import { DurableObject } from "cloudflare:workers";
import type { AnyProjectPipeline, PipelineProject } from "../project/pipeline-project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { errorResponse } from "../studio/run-store-ui-http.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createAccessAuthenticator, parseAccessConfig } from "./cloudflare-access.js";
import {
  MAX_RUN_DURATION_MS,
  RunObjectCore,
  type RunJob,
  type StudioIngest,
} from "./cloudflare-run.js";
import { StudioObjectCore, type RunStubLike } from "./cloudflare-studio.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import { PIPELINE_RUN_STUDIO_CLIENT } from "./cloudflare-studio-client.js";

export {
  createR2CacheStore,
  jsonCacheCodec,
  type R2BucketLike,
  type R2ObjectLike,
} from "./cloudflare-cache.js";

/** Options for createCloudflareApp. */
export interface CloudflareAppOptions {
  readonly limits?: {
    /** Cooperative run deadline. Defaults to and may not exceed 14 minutes (alarm wall time is 15). */
    readonly maxRunDurationMs?: number;
  };
}

/** Worker module handler to use as the Worker entry's default export. */
export interface CloudflareWorker {
  fetch(request: Request, env: unknown, ctx?: unknown): Promise<Response>;
}

/** Durable Object class to export from the Worker entry under its binding's export name. */
export type CloudflareDurableObjectClass = abstract new (ctx: never, env: never) => object;

/** Worker handler and Durable Object classes that a Worker entry exports. */
export interface CloudflareApp {
  readonly worker: CloudflareWorker;
  readonly durableObjects: {
    readonly TubelessStudio: CloudflareDurableObjectClass;
    readonly TubelessRun: CloudflareDurableObjectClass;
  };
}

interface NamespaceLike<T> {
  getByName(name: string): T;
}

interface StudioStub extends StudioIngest {
  fetch(request: Request): Promise<Response>;
}

interface TubelessEnv {
  readonly TUBELESS_STUDIO: NamespaceLike<StudioStub>;
  readonly TUBELESS_RUN: NamespaceLike<RunStubLike>;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
}

interface DurableObjectStateLike {
  readonly storage: DurableStorageLike;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function maxRunDuration(value: number | undefined): number {
  if (value === undefined) return MAX_RUN_DURATION_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RUN_DURATION_MS) {
    throw new Error(
      `limits.maxRunDurationMs must be a positive integer no greater than ${MAX_RUN_DURATION_MS}.`
    );
  }
  return value;
}

function studioUnavailable(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return errorResponse(
      503,
      "studio_unavailable",
      "Studio is temporarily unavailable.",
      "Retry in a moment."
    );
  }
  return new Response("Studio is temporarily unavailable. Retry in a moment.\n", {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

/** Compose a single-tenant Tubeless deployment for a Worker with two SQLite Durable Objects. */
export function createCloudflareApp(
  project: PipelineProject<string, readonly AnyProjectPipeline[]>,
  options: CloudflareAppOptions = {}
): CloudflareApp {
  const maxRunDurationMs = maxRunDuration(options.limits?.maxRunDurationMs);
  const commands = new Map(
    hostedProjectCommands(project).map((entry) => [entry.descriptor.id, entry])
  );
  let authenticator:
    | { key: string; authenticate: (request: Request) => Promise<Response | undefined> }
    | undefined;

  const worker: CloudflareWorker = {
    async fetch(request, rawEnv) {
      // SAFETY: the scaffolded configuration binds these names; missing bindings fail at the call below.
      const env = rawEnv as TubelessEnv;
      let config: ReturnType<typeof parseAccessConfig>;
      try {
        config = parseAccessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      } catch (error) {
        return errorResponse(
          503,
          "access_misconfigured",
          error instanceof Error ? error.message : "Access is misconfigured.",
          "Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy."
        );
      }
      if (config) {
        const key = `${config.issuer}\0${config.audience}`;
        if (authenticator?.key !== key) {
          authenticator = { key, authenticate: createAccessAuthenticator(config) };
        }
        const denial = await authenticator.authenticate(request);
        if (denial) return denial;
      } else if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) {
        return errorResponse(
          503,
          "access_not_configured",
          "Cloudflare Access is not configured.",
          "Enable Cloudflare Access for this Worker, set ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy."
        );
      }
      try {
        // Forward the original request: the Studio host checks mutation Origin against its URL.
        return await env.TUBELESS_STUDIO.getByName("default").fetch(request);
      } catch (error) {
        console.error(error);
        return studioUnavailable(request);
      }
    },
  };

  class TubelessStudio extends DurableObject<TubelessEnv> {
    readonly #core: StudioObjectCore;

    constructor(ctx: unknown, env: TubelessEnv) {
      super(ctx, env);
      // SAFETY: the Workers runtime passes DurableObjectState, whose storage satisfies DurableStorageLike.
      const state = ctx as DurableObjectStateLike;
      this.#core = new StudioObjectCore({
        storage: state.storage,
        commands,
        clientScript: PIPELINE_RUN_STUDIO_CLIENT,
        maxRunDurationMs,
        runStub: (launchId) => env.TUBELESS_RUN.getByName(launchId),
      });
    }

    fetch(request: Request): Promise<Response> {
      return this.#core.fetch(request);
    }

    admit(launchId: string): Promise<{ admitted: boolean }> {
      return this.#core.admit(launchId);
    }

    appendEvents(
      launchId: string,
      sequence: number,
      events: PipelineTraceEvent[]
    ): Promise<{ accepted: boolean }> {
      return this.#core.appendEvents(launchId, sequence, events);
    }

    reportFailure(launchId: string, message: string): Promise<void> {
      return this.#core.reportFailure(launchId, message);
    }

    alarm(): Promise<void> {
      return this.#core.alarm();
    }
  }

  class TubelessRun extends DurableObject<TubelessEnv> {
    readonly #core: RunObjectCore;

    constructor(ctx: unknown, env: TubelessEnv) {
      super(ctx, env);
      // SAFETY: see TubelessStudio.
      const state = ctx as DurableObjectStateLike;
      this.#core = new RunObjectCore({
        storage: state.storage,
        commands,
        ingest: () => env.TUBELESS_STUDIO.getByName("default"),
      });
    }

    start(job: RunJob): Promise<void> {
      return this.#core.start(job);
    }

    cancel(): boolean {
      return this.#core.cancel();
    }

    alarm(): Promise<void> {
      return this.#core.alarm();
    }
  }

  return { worker, durableObjects: { TubelessStudio, TubelessRun } };
}
