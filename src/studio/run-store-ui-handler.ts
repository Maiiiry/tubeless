import { errorResponse, jsonResponse, unexpectedStudioErrorResponse } from "./run-store-ui-http.js";
import { studioRoute } from "./run-store-ui-hosting.js";
import type { StudioPage } from "./run-store-ui-page.js";

/** Response for a request whose Host is not trusted. */
export function untrustedHostResponse(): Response {
  return errorResponse(
    403,
    "untrusted_host",
    "The request host is not trusted.",
    "Use the exact local Studio URL printed by tubeless ui."
  );
}

export interface StudioRequestContext {
  /** Raw request target (path and query) exactly as received. */
  readonly rawTarget: string;
  /** Request authority (Host) as received, before normalization. */
  readonly authority: string | undefined;
}

export interface StudioRequestHandlerOptions {
  readonly api: (request: Request, url: URL) => Promise<Response>;
  readonly page: StudioPage;
  /** Validated mount path; empty for root mounts. */
  readonly mount: string;
  /** Return a denial response, or undefined to continue. Runs before every other check. */
  readonly authenticate?: (
    request: Request
  ) => Response | undefined | Promise<Response | undefined>;
  readonly trustsAuthority: (authority: string | undefined) => boolean;
  /** Required browser Origin for POST and DELETE. Omit only for loopback-local Studio. */
  readonly allowedOrigin?: (request: Request) => string;
  readonly isReady: () => boolean;
}

/** Route one Studio request in the same order on every host. */
export function createStudioRequestHandler(
  options: StudioRequestHandlerOptions
): (request: Request, context: StudioRequestContext) => Promise<Response> {
  return async (request, context) => {
    try {
      const denial = await options.authenticate?.(request);
      if (denial) return denial;
      if (!options.trustsAuthority(context.authority)) {
        return untrustedHostResponse();
      }
      const method = request.method;
      if (
        options.allowedOrigin &&
        (method === "POST" || method === "DELETE") &&
        request.headers.get("origin") !== options.allowedOrigin(request)
      ) {
        return errorResponse(
          403,
          "untrusted_origin",
          "The request origin is not trusted.",
          "Send mutations from the configured Studio origin."
        );
      }
      const route = studioRoute(context.rawTarget, options.mount);
      if (!route) {
        return errorResponse(
          404,
          "not_found",
          "Studio route not found.",
          "Use the configured Studio URL."
        );
      }
      if (route.path === "" && (method === "GET" || method === "HEAD")) {
        return new Response(null, {
          status: 308,
          headers: { "cache-control": "no-store", location: options.mount + "/" + route.search },
        });
      }
      const url = new URL(route.path + route.search, "http://studio.local");
      if (method === "GET" && url.pathname === "/api/health") {
        const ready = options.isReady();
        return jsonResponse({ ready }, ready ? 200 : 503);
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/") {
        return new Response(options.page.html(options.mount), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-security-policy": options.page.csp,
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      }
      return await options.api(request, url);
    } catch (error) {
      return unexpectedStudioErrorResponse(error);
    }
  };
}
