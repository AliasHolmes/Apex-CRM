import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { ssrfSafeDispatcher, isPrivateOrInternalHost } from "../server/leadSearch/siteProbe.js";
import { normalizeBrightDataUrl } from "../server/services/brightdata.js";

const testDbPath = path.join(
  os.tmpdir(),
  `test-ssrf-pinning-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

test("Stream 5 - Connect-Time DNS Socket Pinning & SSRF Protection", async (t) => {
  await t.test("ssrfSafeDispatcher blocks connection to localhost / loopback", async () => {
    let error: any = null;
    try {
      await fetch("http://127.0.0.1:54321/secret", {
        dispatcher: ssrfSafeDispatcher,
        signal: AbortSignal.timeout(3000),
      } as any);
    } catch (err: any) {
      error = err;
    }
    assert.ok(error, "Expected request to 127.0.0.1 to be blocked by SSRF dispatcher");
    const errMsg = [error.message, error.cause?.message, String(error)].filter(Boolean).join(" ");
    assert.match(errMsg, /SSRF blocked/i, "Expected error to specify SSRF blocked");
  });

  await t.test("ssrfSafeDispatcher blocks connection to internal metadata IP (169.254.169.254)", async () => {
    let error: any = null;
    try {
      await fetch("http://169.254.169.254/latest/meta-data", {
        dispatcher: ssrfSafeDispatcher,
        signal: AbortSignal.timeout(3000),
      } as any);
    } catch (err: any) {
      error = err;
    }
    assert.ok(error, "Expected request to metadata IP to be blocked by SSRF dispatcher");
    const errMsg = [error.message, error.cause?.message, String(error)].filter(Boolean).join(" ");
    assert.match(errMsg, /SSRF blocked/i, "Expected error to specify SSRF blocked");
  });

  await t.test("isPrivateOrInternalHost detects private, CGNAT, loopback, and cloud metadata IPs", () => {
    assert.equal(isPrivateOrInternalHost("127.0.0.1"), true);
    assert.equal(isPrivateOrInternalHost("10.0.0.5"), true);
    assert.equal(isPrivateOrInternalHost("192.168.1.100"), true);
    assert.equal(isPrivateOrInternalHost("172.16.0.1"), true);
    assert.equal(isPrivateOrInternalHost("169.254.169.254"), true);
    assert.equal(isPrivateOrInternalHost("::1"), true);
    assert.equal(isPrivateOrInternalHost("fe80::1"), true);
    assert.equal(isPrivateOrInternalHost("8.8.8.8"), false);
    assert.equal(isPrivateOrInternalHost("1.1.1.1"), false);
  });

  await t.test("normalizeBrightDataUrl rejects internal / private host URLs", () => {
    assert.throws(
      () => normalizeBrightDataUrl("http://127.0.0.1/admin"),
      /private or internal host/i,
    );
    assert.throws(
      () => normalizeBrightDataUrl("http://localhost:8080/metrics"),
      /private or internal host/i,
    );
    assert.throws(
      () => normalizeBrightDataUrl("http://169.254.169.254/creds"),
      /private or internal host/i,
    );
    // Valid public URL passes normalization
    const normal = normalizeBrightDataUrl("https://www.linkedin.com/in/johndoe");
    assert.ok(normal.startsWith("https://"));
  });
});
