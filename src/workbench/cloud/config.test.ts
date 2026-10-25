import { describe, expect, it } from "vitest";
import { normalizeCloudHost, resolveCloudHost } from "./config.js";

describe("Cloud origins", () => {
  it("normalizes selected origins and uses only explicit or default host", () => {
    expect(normalizeCloudHost("https://CLOUD.example:443/")).toBe("https://cloud.example");
    expect(normalizeCloudHost("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeCloudHost("http://[::1]:8787/")).toBe("http://[::1]:8787");
    expect(resolveCloudHost()).toBe("https://cloud.tubeless.io");
    expect(resolveCloudHost("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects credentials, remote HTTP, paths, queries, fragments and disguised paths", () => {
    for (const host of [
      "https://user:secret@cloud.example",
      "https://@cloud.example",
      "http://cloud.example",
      "https://cloud.example/api",
      "https://cloud.example/x/..",
      "https://cloud.example?",
      "https://cloud.example?token=secret",
      "https://cloud.example#",
      "https://cloud.example/#fragment",
      " https://cloud.example",
      "https://cloud.example\\api",
    ]) {
      expect(() => normalizeCloudHost(host)).toThrow("Cloud host must");
    }
  });
});
