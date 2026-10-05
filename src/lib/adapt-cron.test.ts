import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GET as healthGet } from "../pages/api/health.ts";
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

  it("health JSON reports both flags and never includes the secrets", async () => {
    const previousCron = process.env.ADAPT_CRON_SECRET;
    const previousWebhook = process.env.INTERVALS_WEBHOOK_SECRET;
    const context = {} as Parameters<typeof healthGet>[0];
    try {
      process.env.ADAPT_CRON_SECRET = "unit-test-cron-secret";
      process.env.INTERVALS_WEBHOOK_SECRET = "unit-test-webhook-secret";
      const response = await healthGet(context);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        ok: true,
        adaptCronConfigured: true,
        intervalsWebhookConfigured: true,
      });
      assert.equal(text.includes("unit-test-cron-secret"), false);
      assert.equal(text.includes("unit-test-webhook-secret"), false);
      assert.equal(text.includes("unit-test"), false);

      process.env.INTERVALS_WEBHOOK_SECRET = "   ";
      const blank = (await (await healthGet(context)).json()) as { intervalsWebhookConfigured: boolean };
      assert.equal(blank.intervalsWebhookConfigured, false);

      delete process.env.INTERVALS_WEBHOOK_SECRET;
      const missing = (await (await healthGet(context)).json()) as {
        adaptCronConfigured: boolean;
        intervalsWebhookConfigured: boolean;
      };
      assert.equal(missing.intervalsWebhookConfigured, false);
      assert.equal(missing.adaptCronConfigured, true);

      delete process.env.ADAPT_CRON_SECRET;
      process.env.INTERVALS_WEBHOOK_SECRET = "unit-test-webhook-secret";
      const cronMissing = (await (await healthGet(context)).json()) as {
        adaptCronConfigured: boolean;
        intervalsWebhookConfigured: boolean;
      };
      assert.equal(cronMissing.adaptCronConfigured, false);
      assert.equal(cronMissing.intervalsWebhookConfigured, true);
    } finally {
      if (previousCron === undefined) delete process.env.ADAPT_CRON_SECRET;
      else process.env.ADAPT_CRON_SECRET = previousCron;
      if (previousWebhook === undefined) delete process.env.INTERVALS_WEBHOOK_SECRET;
      else process.env.INTERVALS_WEBHOOK_SECRET = previousWebhook;
    }
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
