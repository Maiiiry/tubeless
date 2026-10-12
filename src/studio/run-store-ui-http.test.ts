import { describe, expect, it, vi } from "vitest";
import {
  errorResponse,
  formatHttpUrlHost,
  isUnspecifiedHttpHost,
  jsonResponse,
  normalizeHttpAuthority,
  parseHttpAuthority,
  readJsonBody,
  StudioRequestError,
  unexpectedStudioErrorResponse,
} from "./run-store-ui-http.js";

describe("studio HTTP authorities", () => {
  it("brackets IPv6 literals for URLs", () => {
    expect(formatHttpUrlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(formatHttpUrlHost("::1")).toBe("[::1]");
  });

  it("normalizes explicit default ports and preserves non-default ports", () => {
    expect(normalizeHttpAuthority("127.0.0.1:80")).toBe("127.0.0.1");
    expect(normalizeHttpAuthority("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHttpAuthority("[::1]:80")).toBe("[::1]");
    expect(normalizeHttpAuthority("[::1]")).toBe("[::1]");
    expect(normalizeHttpAuthority("LOCALHOST:4317")).toBe("localhost:4317");
  });

  it("rejects values that are not bare authorities", () => {
    expect(normalizeHttpAuthority(undefined)).toBeUndefined();
    expect(normalizeHttpAuthority("user@127.0.0.1")).toBeUndefined();
    expect(normalizeHttpAuthority("127.0.0.1/path")).toBeUndefined();
    expect(normalizeHttpAuthority("::1:4317")).toBeUndefined();
  });

  it("identifies unspecified bind hosts", () => {
    expect(isUnspecifiedHttpHost("0.0.0.0")).toBe(true);
    expect(isUnspecifiedHttpHost("::")).toBe(true);
    expect(isUnspecifiedHttpHost("127.0.0.1")).toBe(false);
    expect(isUnspecifiedHttpHost("::1")).toBe(false);
  });

  it("splits a normalized authority into hostname and port", () => {
    expect(parseHttpAuthority("127.0.0.1:4317")).toEqual({ hostname: "127.0.0.1", port: "4317" });
    expect(parseHttpAuthority("[::1]:4317")).toEqual({ hostname: "::1", port: "4317" });
    expect(parseHttpAuthority("127.0.0.1:80")).toEqual({ hostname: "127.0.0.1", port: "" });
    expect(parseHttpAuthority(undefined)).toBeUndefined();
  });
});

describe("fetch-native Studio responses", () => {
  it("formats JSON with no-store and nosniff headers", async () => {
    const response = jsonResponse({ ok: true }, 201, { etag: '"x"' });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe('"x"');
    expect(await response.json()).toEqual({ ok: true });
  });

  it("formats errors as code, hint and message", async () => {
    const response = errorResponse(404, "not_found", "Missing.", "Retry.");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "not_found",
      hint: "Retry.",
      message: "Missing.",
    });
  });

  it("hides unexpected error details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = unexpectedStudioErrorResponse(new Error("secret path"));
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret path");
  });

  it("reads bounded JSON request bodies", async () => {
    const ok = new Request("http://studio.local/", { method: "POST", body: '{"a":1}' });
    expect(await readJsonBody(ok)).toEqual({ a: 1 });
    const invalid = new Request("http://studio.local/", { method: "POST", body: "{" });
    await expect(readJsonBody(invalid)).rejects.toMatchObject({
      code: "invalid_json",
      status: 400,
    });
    const large = new Request("http://studio.local/", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(70_000) }),
    });
    await expect(readJsonBody(large)).rejects.toBeInstanceOf(StudioRequestError);
    await expect(
      readJsonBody(
        new Request("http://studio.local/", { method: "POST", body: "x".repeat(70_000) })
      )
    ).rejects.toMatchObject({ code: "request_body_too_large", status: 413 });
  });
});
