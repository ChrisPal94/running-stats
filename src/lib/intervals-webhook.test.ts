import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { POST } from "../pages/api/intervals-webhook.ts";
import {
  getDb,
  getIntervalsConnectionByAthleteId,
  insertUser,
  upsertIntervalsConnection,
} from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import {
  collectWebhookEventAthleteIds,
  intervalsWebhookConfigured,
  normalizeWebhookAthleteId,
  runWebhookSyncs,
  webhookBodyIsObject,
  webhookSecretAuthorized,
  type IntervalsWebhookSyncResult,
} from "./intervals-webhook.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-webhook-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  INTERVALS_WEBHOOK_SECRET: process.env.INTERVALS_WEBHOOK_SECRET,
};
const KEY_SECRET = Buffer.alloc(32, 9).toString("base64");
const WEBHOOK_SECRET = "webhook-test-secret";
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = KEY_SECRET;

type SyncCall = { userId: string; result: IntervalsWebhookSyncResult | Error };

function syncStub(results: SyncCall[]): { fn: (userId: string) => Promise<IntervalsWebhookSyncResult>; calls: string[] } {
  const calls: string[] = [];
  const fn = async (userId: string): Promise<IntervalsWebhookSyncResult> => {
    calls.push(userId);
    const found = results.find((entry) => entry.userId === userId);
    if (!found) return { ok: true, imported: 1, skippedNoSession: 0, skippedManual: 0, pendingChoices: [], cooperResolved: false };
    if (found.result instanceof Error) throw found.result;
    return found.result;
  };
  return { fn, calls };
}

function okSyncResult(imported = 1, skippedNoSession = 0): IntervalsWebhookSyncResult {
  return { ok: true, imported, skippedNoSession, skippedManual: 0, pendingChoices: [], cooperResolved: false };
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  process.env.AUTH_DATA_DIR = dataDir;
  process.env.INTERVALS_KEY_ENC_SECRET = KEY_SECRET;
  if (originalEnv.INTERVALS_WEBHOOK_SECRET === undefined) delete process.env.INTERVALS_WEBHOOK_SECRET;
  else process.env.INTERVALS_WEBHOOK_SECRET = originalEnv.INTERVALS_WEBHOOK_SECRET;
});

function connect(userId: string, athleteId: string): void {
  const existing = getDb().prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: string }
    | undefined;
  if (!existing) {
    insertUser({
      id: userId,
      email: `${userId}@example.com`,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  upsertIntervalsConnection({
    userId,
    athleteId,
    connectedAt: "2026-09-01T00:00:00.000Z",
    apiKeyEnc: encryptIntervalsApiKey(`key-${userId}`, userId),
    authType: "apikey",
  });
}

/** Blocks any live Intervals.icu call from inside a test. */
function blockNetwork(): void {
  mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    const error = new Error(`offline fixture blocked ${url}`);
    error.name = "OfflineFixture";
    throw error;
  });
}

async function callWebhook(payload: unknown): Promise<Response> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const request = new Request("https://stride.test/api/intervals-webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return POST({ request } as Parameters<typeof POST>[0]);
}

function cookbook(overrides: Record<string, unknown> = {}): unknown {
  return {
    secret: WEBHOOK_SECRET,
    events: [
      {
        athlete_id: "2049151",
        type: "ACTIVITY_UPLOADED",
        timestamp: "2024-12-06T06:40:47.011+00:00",
        activity: {},
      },
    ],
    ...overrides,
  };
}

describe("intervals webhook", { concurrency: false }, () => {
  it("reports not configured when the secret env is missing or blank", () => {
    delete process.env.INTERVALS_WEBHOOK_SECRET;
    assert.equal(intervalsWebhookConfigured(), false);
    process.env.INTERVALS_WEBHOOK_SECRET = "   ";
    assert.equal(intervalsWebhookConfigured(), false);
    process.env.INTERVALS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    assert.equal(intervalsWebhookConfigured(), true);
  });

  it("compares the body secret to the env secret timing-safely", () => {
    delete process.env.INTERVALS_WEBHOOK_SECRET;
    assert.equal(webhookSecretAuthorized(WEBHOOK_SECRET), false);
    process.env.INTERVALS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    assert.equal(webhookSecretAuthorized("wrong-secret"), false);
    assert.equal(webhookSecretAuthorized(undefined), false);
    assert.equal(webhookSecretAuthorized(123), false);
    assert.equal(webhookSecretAuthorized(WEBHOOK_SECRET), true);
  });

  it("normalizes webhook athlete ids to the OAuth i-form", () => {
    assert.equal(normalizeWebhookAthleteId("2049151"), "i2049151");
    assert.equal(normalizeWebhookAthleteId("i2049151"), "i2049151");
    assert.equal(normalizeWebhookAthleteId(2049151), "i2049151");
    assert.equal(normalizeWebhookAthleteId(" i2049151 "), "i2049151");
    assert.equal(normalizeWebhookAthleteId(""), null);
    assert.equal(normalizeWebhookAthleteId("athlete"), null);
    assert.equal(normalizeWebhookAthleteId(null), null);
    assert.equal(normalizeWebhookAthleteId(undefined), null);
    assert.equal(normalizeWebhookAthleteId("1234567890123456"), null);
  });

  it("collects only activity events and collapses duplicate athletes", () => {
    assert.deepEqual(
      collectWebhookEventAthleteIds(cookbook()),
      ["i2049151"],
    );
    assert.deepEqual(
      collectWebhookEventAthleteIds({
        secret: WEBHOOK_SECRET,
        events: [
          { athlete_id: "123", type: "ACTIVITY_UPLOADED" },
          { athlete_id: "CALENDAR_USER", type: "CALENDAR_UPDATED" },
          { athlete_id: "i456", type: "WORKOUT_CREATED" },
          { athlete_id: "456", type: "ACTIVITY_ANALYZED" },
          { athlete_id: "123", type: "ACTIVITY_ANALYZED" },
          { athlete_id: "bad id!", type: "ACTIVITY_UPLOADED" },
          { type: "ACTIVITY_UPLOADED" },
        ],
      }),
      ["i123", "i456"],
    );
    assert.deepEqual(collectWebhookEventAthleteIds({ events: "nope" }), []);
    assert.deepEqual(collectWebhookEventAthleteIds({}), []);
    assert.deepEqual(collectWebhookEventAthleteIds("nonsense"), []);
  });

  it("treats only JSON objects as webhook bodies", () => {
    assert.equal(webhookBodyIsObject({}), true);
    assert.equal(webhookBodyIsObject([]), false);
    assert.equal(webhookBodyIsObject("x"), false);
    assert.equal(webhookBodyIsObject(7), false);
    assert.equal(webhookBodyIsObject(null), false);
    assert.equal(webhookBodyIsObject(undefined), false);
  });

  it("looks up a connection by normalized athlete id and returns the first of duplicates", () => {
    connect("wh-lookup-a", "i246001");
    connect("wh-lookup-b", "i246002");
    const found = getIntervalsConnectionByAthleteId("i246001");
    assert.ok(found);
    assert.equal(found.athleteId, "i246001");
    const first = getIntervalsConnectionByAthleteId("i246002");
    const second = getIntervalsConnectionByAthleteId("i246002");
    assert.ok(first);
    assert.equal(first.userId, second?.userId);

    connect("wh-dup-x", "i246003");
    connect("wh-dup-y", "i246003");
    const dup = getIntervalsConnectionByAthleteId("i246003");
    assert.ok(dup);
    assert.ok(["wh-dup-x", "wh-dup-y"].includes(dup.userId));
    assert.equal(dup.userId, getIntervalsConnectionByAthleteId("i246003")?.userId);

    assert.equal(getIntervalsConnectionByAthleteId("i999777"), null);
  });

  it("syncs each matched user once and sums counts", async () => {
    connect("wh-sync-a", "i246011");
    connect("wh-sync-b", "i246012");
    const lookup = (athleteId: string): string | null =>
      athleteId === "i246011" ? "wh-sync-a" : athleteId === "i246012" ? "wh-sync-b" : null;
    const stub = syncStub([
      { userId: "wh-sync-a", result: okSyncResult(2, 1) },
      { userId: "wh-sync-b", result: okSyncResult(3, 0) },
    ]);
    const outcome = await runWebhookSyncs(
      {
        secret: WEBHOOK_SECRET,
        events: [
          { athlete_id: "246011", type: "ACTIVITY_UPLOADED" },
          { athlete_id: "i246012", type: "ACTIVITY_ANALYZED" },
          { athlete_id: "246012", type: "ACTIVITY_UPLOADED" },
        ],
      },
      lookup,
      stub.fn,
    );
    assert.equal(outcome.status, 200);
    assert.deepEqual(stub.calls, ["wh-sync-a", "wh-sync-b"]);
    assert.equal(outcome.body.ok, true);
    assert.equal(outcome.body.imported, 5);
    assert.equal(outcome.body.skippedNoSession, 1);
  });

  it("returns 200 ignored when no event maps to a connected athlete", async () => {
    blockNetwork();
    const lookup = (): string | null => null;
    const stub = syncStub([]);
    const outcome = await runWebhookSyncs(cookbook(), lookup, stub.fn);
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { ignored: true });
    assert.deepEqual(stub.calls, []);
  });

  it("returns 500 when one sync throws or reports failure", async () => {
    connect("wh-fail-a", "i246021");
    const lookup = (athleteId: string): string | null => (athleteId === "i246021" ? "wh-fail-a" : null);
    const body = {
      secret: WEBHOOK_SECRET,
      events: [{ athlete_id: "246021", type: "ACTIVITY_UPLOADED" }],
    };
    const throwing = syncStub([{ userId: "wh-fail-a", result: new Error("intervals down") }]);
    const thrownOutcome = await runWebhookSyncs(body, lookup, throwing.fn);
    assert.equal(thrownOutcome.status, 500);
    assert.equal(thrownOutcome.body.ok, false);
    assert.equal(JSON.stringify(thrownOutcome.body).includes("intervals down"), false);

    const failing = syncStub([{ userId: "wh-fail-a", result: { ok: false, error: "upstream" } }]);
    const failedOutcome = await runWebhookSyncs(body, lookup, failing.fn);
    assert.equal(failedOutcome.status, 500);
    assert.equal(failedOutcome.body.ok, false);
  });

  it("returns 503 when INTERVALS_WEBHOOK_SECRET is not set", async () => {
    delete process.env.INTERVALS_WEBHOOK_SECRET;
    const response = await callWebhook(cookbook());
    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: "INTERVALS_WEBHOOK_SECRET is not set" });
  });

  it("returns 503 when INTERVALS_WEBHOOK_SECRET is blank", async () => {
    process.env.INTERVALS_WEBHOOK_SECRET = "   ";
    const response = await callWebhook(cookbook());
    assert.equal(response.status, 503);
  });

  it("returns 401 when the body secret is wrong or missing", async () => {
    process.env.INTERVALS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    blockNetwork();
    const wrong = await callWebhook({
      secret: "not-the-secret",
      events: [{ athlete_id: "2049151", type: "ACTIVITY_UPLOADED" }],
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual((await wrong.json()) as Record<string, unknown>, { error: "Unauthorized" });

    const missing = await callWebhook({
      events: [{ athlete_id: "2049151", type: "ACTIVITY_UPLOADED" }],
    });
    assert.equal(missing.status, 401);
  });

  it("returns 400 when the body is not JSON or not an object", async () => {
    process.env.INTERVALS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    blockNetwork();
    const badJson = await callWebhook("{not json");
    assert.equal(badJson.status, 400);
    assert.deepEqual((await badJson.json()) as Record<string, unknown>, { error: "Invalid payload" });

    const notObject = await callWebhook("[]");
    assert.equal(notObject.status, 400);
    assert.deepEqual((await notObject.json()) as Record<string, unknown>, { error: "Invalid payload" });
  });

  it("returns 200 ignored for an unknown athlete without syncing", async () => {
    connect("wh-known", "i246031");
    process.env.INTERVALS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    blockNetwork();
    const lines: string[] = [];
    mock.method(console, "log", (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    mock.method(console, "warn", (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    mock.method(console, "error", (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    const response = await callWebhook({
      secret: WEBHOOK_SECRET,
      events: [
        { athlete_id: "987654", type: "ACTIVITY_UPLOADED" },
        { athlete_id: "i246032", type: "ACTIVITY_UPLOADED" },
        { athlete_id: "i246031", type: "CALENDAR_UPDATED" },
      ],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { ignored: true });
    assert.equal(getIntervalsConnectionByAthleteId("i246031")?.userId, "wh-known");
    assert.equal(
      lines.some((line) => line.includes("987654") || line.includes("i246032") || line.includes(WEBHOOK_SECRET)),
      false,
    );
  });
});