import type { PipelineRunEventReader } from "../run-store/run-store.js";
import { createStudioApiHandler } from "../studio/run-store-ui-api.js";
import { createStudioRequestHandler } from "../studio/run-store-ui-handler.js";
import { createStudioPage } from "../studio/run-store-ui-page.js";
import type { PipelineRunStudioLauncher } from "../studio/run-store-ui-protocol.js";

export interface StudioHostOptions {
  readonly store: Pick<PipelineRunEventReader, "listEvents">;
  readonly launcher?: PipelineRunStudioLauncher;
  readonly clientScript: string;
  readonly authenticate?: (
    request: Request
  ) => Response | undefined | Promise<Response | undefined>;
}

export interface StudioHost {
  fetch(request: Request): Promise<Response>;
}

/** Compose Studio for a host whose platform already routed the request by hostname. */
export async function createStudioHost(options: StudioHostOptions): Promise<StudioHost> {
  const api = createStudioApiHandler({ store: options.store, launcher: options.launcher });
  const page = await createStudioPage(options.clientScript);
  const handle = createStudioRequestHandler({
    api,
    page,
    mount: "",
    authenticate: options.authenticate,
    trustsAuthority: () => true,
    allowedOrigin: (request) => new URL(request.url).origin,
    isReady: () => true,
  });
  return {
    fetch(request) {
      const url = new URL(request.url);
      return handle(request, { rawTarget: url.pathname + url.search, authority: url.host });
    },
  };
}
