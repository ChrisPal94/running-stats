import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptCronConfigured, adaptRunLogLine } from "./adapt-cron.ts";

describe("adaptCronConfigured", () => {
  it("is false when the secret is missing, empty, or whitespace", () => {
    assert.equal(adaptCronConfigured(undefined), false);
    assert.equal(adaptCronConfigured(""), false);
    assert.equal(adaptCronConfigured("   "), false);
  });

  it("is true when the secret is set and non-empty after trim", () => {
    assert.equal(adaptCronConfigured("cron-token"), true);
    assert.equal(adaptCronConfigured("  cron-token  "), true);
  });

  it("health JSON is a boolean flag and never includes the secret", () => {
    const secret = "unit-test-cron-secret";
    const body = JSON.stringify({ ok: true, adaptCronConfigured: adaptCronConfigured(secret) });
    assert.deepEqual(JSON.parse(body), { ok: true, adaptCronConfigured: true });
    assert.equal(body.includes(secret), false);
    assert.equal(body.includes("unit-test"), false);
  });
});

describe("adaptRunLogLine", () => {
  it("summarizes counts without user identifiers", () => {
    const line = adaptRunLogLine({
      processed: 3,
      written: 1,
      skipped: 2,
      patched: 1,
      llmFailed: 0,
      uploaded: 1,
      uploadFailed: 0,
    });
    assert.equal(
      line,
      "[adapt] run processed=3 written=1 skipped=2 patched=1 llmFailed=0 uploaded=1 uploadFailed=0 noConnection=0 reconnect=0",
    );
    assert.equal(/user-|@|email/i.test(line), false);
  });
});
