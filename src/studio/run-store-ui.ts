import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import type { PipelineRunEventReader, PipelineRunEventStore } from "../run-store/run-store.js";
import {
  errorResponse,
  formatHttpUrlHost,
  isUnspecifiedHttpHost,
  normalizeHttpAuthority,
  parseHttpAuthority,
  unexpectedStudioErrorResponse,
} from "./run-store-ui-http.js";
import { createStudioPage } from "./run-store-ui-page.js";
import { readStudioClientScript } from "./run-store-ui-page-node.js";
import { toFetchHeaders, toFetchRequest, writeFetchResponse } from "./run-store-ui-node.js";
import { createStudioRequestHandler, untrustedHostResponse } from "./run-store-ui-handler.js";
import { createStudioApiHandler, type PipelineRunStudioApiOptions } from "./run-store-ui-api.js";
import type { StudioHosting } from "./run-store-ui-hosting.js";
export type { PipelineRunStudioLaunchResult } from "./run-store-ui-protocol.js";

export interface PipelineRunStudioOptions extends PipelineRunStudioApiOptions {
  store: PipelineRunEventReader | PipelineRunEventStore;
  /** Bind address. Defaults to loopback only. */
  host?: string;
  /** HTTP port. Pass `0` to select an available port. Defaults to `4317`. */
  port?: number;
  hosting?: StudioHosting;
}

export interface PipelineRunStudioServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function isAddressInfo(
  address: string | import("node:net").AddressInfo | null
): address is import("node:net").AddressInfo {
  return typeof address !== "string" && address !== null;
}

/** Hostname that a wildcard listener may trust: localhost or a literal IP. */
export function isLiteralOrLocalhostHttpHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unbracketed === "localhost" || isIP(unbracketed) !== 0;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Start the local studio against any store and optional execution capability. */
export async function startPipelineRunStudio(
  options: PipelineRunStudioOptions
): Promise<PipelineRunStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4317;
  const hosting = options.hosting;
  const api = createStudioApiHandler({
    ...options,
    history: hosting ? undefined : options.history,
  });
  const page = await createStudioPage(readStudioClientScript());
  let ready = true;
  let expectedAuthority: string | undefined;
  const wildcardBind = isUnspecifiedHttpHost(host);
  const trustsAuthority = (authority: string | undefined): boolean => {
    const requestAuthority = normalizeHttpAuthority(authority);
    if (!requestAuthority || !expectedAuthority) return false;
    if (requestAuthority === expectedAuthority || hosting?.trustsAuthority(authority)) return true;
    if (!wildcardBind) return false;
    const requestParts = parseHttpAuthority(requestAuthority);
    const expectedParts = parseHttpAuthority(expectedAuthority);
    return (
      requestParts !== undefined &&
      expectedParts !== undefined &&
      requestParts.port === expectedParts.port &&
      isLiteralOrLocalhostHttpHost(requestParts.hostname)
    );
  };
  const authenticate = hosting
    ? (request: Request): Response | undefined =>
        hosting.authenticates(request)
          ? undefined
          : errorResponse(
              401,
              "gateway_authentication_required",
              "Gateway authentication failed.",
              "Check the application gateway configuration."
            )
    : undefined;
  const handle = createStudioRequestHandler({
    api,
    page,
    mount: hosting?.mount ?? "",
    authenticate,
    trustsAuthority,
    allowedOrigin: hosting ? () => hosting.origin : undefined,
    isReady: () => ready,
  });
  /** Fetch cannot represent methods such as TRACE; apply the gateway order without a body. */
  const rejectUnconvertible = async (request: IncomingMessage): Promise<Response> => {
    const denial = await authenticate?.(
      new Request("http://studio.local/", { headers: toFetchHeaders(request) })
    );
    if (denial) return denial;
    if (!trustsAuthority(request.headers.host)) return untrustedHostResponse();
    return errorResponse(
      405,
      "method_not_allowed",
      "Method not allowed.",
      "Read the Studio guide at https://tubeless.io/docs/studio."
    );
  };
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    try {
      let fetchRequest: Request | undefined;
      try {
        fetchRequest = toFetchRequest(request);
      } catch {
        fetchRequest = undefined;
      }
      const result = fetchRequest
        ? await handle(fetchRequest, {
            rawTarget: request.url ?? "/",
            authority: request.headers.host,
          })
        : await rejectUnconvertible(request);
      await writeFetchResponse(response, result, method);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      await writeFetchResponse(response, unexpectedStudioErrorResponse(error), method);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("The local studio did not receive a TCP address.");
  }
  const port = address.port;
  const urlHost = formatHttpUrlHost(host);
  const authority = `${urlHost}:${port}`;
  expectedAuthority = normalizeHttpAuthority(authority);
  if (!expectedAuthority) {
    await closeServer(server);
    throw new Error("The local studio could not normalize its HTTP authority.");
  }
  return {
    host,
    port,
    url: hosting?.publicUrl ?? `http://${authority}`,
    close: () => {
      ready = false;
      return closeServer(server);
    },
  };
}
