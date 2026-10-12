import { describe, expect, it } from "vitest";
import { constantTimeEqual, parseStudioHosting, studioRoute } from "./run-store-ui-hosting.js";

const token = "a1".repeat(32);
function request(rawHeaders: string[]): Request {
  const headers: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return new Request("http://studio.local/", { headers });
}

describe("Studio hosting contract", () => {
  it("keeps local mode explicit and secrets out of configuration serialization", () => {
    expect(parseStudioHosting(undefined, undefined)).toBeUndefined();
    expect(() => parseStudioHosting(undefined, token)).toThrow("requires --public-url");
    for (const value of [undefined, "", "abc", " ".repeat(64), "z".repeat(64)]) {
      expect(() => parseStudioHosting("https://example.test/admin", value)).toThrow(
        "64 hexadecimal"
      );
    }
    const hosting = parseStudioHosting("https://example.test/admin/", token)!;
    expect(hosting).toMatchObject({
      publicUrl: "https://example.test/admin/",
      mount: "/admin",
      origin: "https://example.test",
      authority: "example.test",
    });
    expect(JSON.stringify(hosting)).not.toContain(token);
  });
  it.each([
    "http://example.test/admin",
    "https://example.test/a//b",
    "https://example.test/a/../b",
    "https://example.test/a/./b",
    "https://example.test/a/%2e/b",
    "https://example.test/a%2fb",
    "https://example.test/a%5Cb",
    "https://example.test/a\\b",
    "https://user:pass@example.test/admin",
    "https://example.test/admin?x=1",
    "https://example.test/admin#x",
    "https://example.test//",
    "https://example.test/space here",
    "https://example.test/café",
    "http://127.1/admin",
    "http://2130706433/admin",
    "https:example.test/admin",
  ])("rejects unsafe public URL %s before normalization", (url) => {
    expect(() => parseStudioHosting(url, token)).toThrow("--public-url");
  });
  it.each([
    "http://localhost:4317/",
    "http://127.0.0.1:4317/admin",
    "http://[::1]:4317/admin",
    "https://example.test:8443/admin",
    "https://example.test/",
  ])("accepts %s", (url) => {
    expect(parseStudioHosting(url, token)).toBeDefined();
  });
  it("requires one exact bearer credential", () => {
    const hosting = parseStudioHosting("https://example.test/admin", token)!;
    expect(hosting.authenticates(request(["Authorization", "Bearer " + token]))).toBe(true);
    for (const headers of [
      [],
      ["Authorization", "Bearer wrong"],
      ["Authorization", "Bearer " + "b2".repeat(32)],
      ["Authorization", "Bearer " + token, "authorization", "Bearer " + token],
      ["Authorization", "Bearer " + token + ", Bearer " + token],
    ]) {
      expect(hosting.authenticates(request(headers))).toBe(false);
    }
  });
  it("compares secrets in constant time", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
  it("strips exactly one mount while preserving opaque IDs and queries", () => {
    expect(
      studioRoute("/admin/pipelines/api/commands/fixture%2Fid/plan?run=x", "/admin/pipelines")
    ).toEqual({ path: "/api/commands/fixture%2Fid/plan", search: "?run=x" });
    expect(studioRoute("/admin/pipelines?run=x", "/admin/pipelines")).toEqual({
      path: "",
      search: "?run=x",
    });
    expect(studioRoute("/api/snapshot", "")).toEqual({ path: "/api/snapshot", search: "" });
    for (const path of [
      "/admin/pipelines-other",
      "/api/snapshot",
      "/admin//pipelines/api/snapshot",
      "/admin%2Fpipelines/api/snapshot",
      "/admin/pipelines/../api/snapshot",
      "/admin/pipelines/%2e%2E/api/snapshot",
      "/admin/pipelines//api/snapshot",
      "//admin/pipelines/",
    ])
      expect(studioRoute(path, "/admin/pipelines")).toBeUndefined();
  });
});

it("matches public authority using its scheme without erasing nondefault ports", () => {
  const secure = parseStudioHosting("https://example.test:80/admin", token)!;
  expect(secure.authority).toBe("example.test:80");
  expect(secure.trustsAuthority("example.test:80")).toBe(true);
  expect(secure.trustsAuthority("example.test")).toBe(false);
  const defaultSecure = parseStudioHosting("https://example.test:443/admin", token)!;
  expect(defaultSecure.origin).toBe("https://example.test");
  expect(defaultSecure.trustsAuthority("example.test:443")).toBe(true);
  expect(defaultSecure.trustsAuthority("example.test")).toBe(true);
  expect(defaultSecure.trustsAuthority("example.test:80")).toBe(false);
  const development = parseStudioHosting("http://localhost:4317/admin", token)!;
  expect(development.trustsAuthority("localhost:4317")).toBe(true);
  expect(development.trustsAuthority("localhost")).toBe(false);
});
