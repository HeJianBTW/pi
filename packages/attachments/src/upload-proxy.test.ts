import { describe, expect, it } from "vitest";
import { isLocalUploadHost } from "./upload-proxy.js";

describe("attachment upload proxy", () => {
  it("limits insecure TLS bypass eligibility to local development hosts", () => {
    expect(isLocalUploadHost("amaster.local")).toBe(true);
    expect(isLocalUploadHost("www.amaster.local")).toBe(true);
    expect(isLocalUploadHost("localhost")).toBe(true);
    expect(isLocalUploadHost("127.0.0.1")).toBe(true);
    expect(isLocalUploadHost("[::1]")).toBe(true);
    expect(isLocalUploadHost("www.helige.cn")).toBe(false);
    expect(isLocalUploadHost("example.com")).toBe(false);
  });
});
