import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { getDb, getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import {
  canUseIntervals,
  getIntervalsConnection,
  INTERVALS_API_KEY_NOT_CONFIGURED,
  INTERVALS_ENC_NOT_CONFIGURED,
  INTERVALS_NOT_FOR_ACCOUNT,
  INTERVALS_SYNC_ERROR,
  INTERVALS_SYNC_NEEDS_CONNECT,
  INTERVALS_CONNECT_UNAVAILABLE,
  getIntervalsConnectionView,
  intervalsSyncUserError,
  intervalsBasicAuthHeader,
  intervalsSettingsControls,
  revokeUnownedIntervals,
} from "./intervals.ts";
import { handleSettingsPost, type Plan, type Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-owner-"));
process.env.AUTH_DATA_DIR = dataDir;

const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalKey = process.env.INTERVALS_ICU_API_KEY;
const originalFetch = globalThis.fetch;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
  if (originalKey === undefined) delete process.env.INTERVALS_ICU_API_KEY;
  else process.env.INTERVALS_ICU_API_KEY = originalKey;
  delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
  delete process.env.INTERVALS_ICU_ATHLETE_ID;
});

describe("canUseIntervals", () => {
  it("fails closed when the allowlist is unset, empty, or only whitespace", () => {
    for (const value of [undefined, "", "   ", ",", " , "]) {
      if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
      else process.env.INTERVALS_OWNER_EMAILS = value;
      assert.equal(canUseIntervals({ email: "crispal94@gmail.com" }), false);
      assert.equal(canUseIntervals(null), false);
      assert.equal(canUseIntervals({ email: "  " }), false);
    }
  });

  it("matches allowlisted emails case-insensitively and trims whitespace when verified", () => {
    process.env.INTERVALS_OWNER_EMAILS = "  CrisPal94@gmail.com , other@example.com  ";
    const verified = "2026-09-25T12:00:00.000Z";
    assert.equal(canUseIntervals({ email: "crispal94@gmail.com", emailVerifiedAt: verified }), true);
    assert.equal(canUseIntervals({ email: "  CRISPAL94@gmail.com  ", emailVerifiedAt: verified }), true);
    assert.equal(canUseIntervals({ email: "other@example.com", emailVerifiedAt: verified }), true);
    assert.equal(canUseIntervals({ email: "nope@example.com", emailVerifiedAt: verified }), false);
    assert.equal(canUseIntervals({ email: "crispal94@gmail.com" }), false);
    assert.equal(canUseIntervals({ email: "crispal94@gmail.com", emailVerifiedAt: null }), false);
    assert.equal(canUseIntervals({ email: "crispal94@gmail.com", emailVerifiedAt: "  " }), false);
  });
});

describe("Settings Intervals row", () => {
  it("keeps Connect and Sync when the account is not on the owner allowlist", () => {
    const hidden = intervalsSettingsControls({
      available: false,
      connection: {
        connected: true,
        athleteId: "i123456",
        statusLabel: "Connected as i123456",
        lastSyncLabel: "Synced 2h ago",
      },
    });
    assert.equal(hidden.statusLabel, "Connected as i123456");
    assert.equal(hidden.statusLabel.includes("Not available for your account"), false);
    assert.equal(hidden.showConnect, false);
    assert.equal(hidden.showSync, true);

    const disconnected = intervalsSettingsControls({
      available: false,
      connection: { connected: false, statusLabel: "Not connected" },
    });
    assert.equal(disconnected.statusLabel, "Not connected");
    assert.equal(disconnected.statusLabel.includes("Not available for your account"), false);
    assert.equal(disconnected.showConnect, true);
    assert.equal(disconnected.showSync, false);
  });

  it("shows Connect when disconnected and Sync now when connected", () => {
    const connect = intervalsSettingsControls({
      available: true,
      connection: { connected: false, statusLabel: "Not connected" },
    });
    assert.equal(connect.statusLabel, "Not connected");
    assert.equal(connect.showConnect, true);
    assert.equal(connect.showSync, false);

    const sync = intervalsSettingsControls({
      available: true,
      connection: {
        connected: true,
        athleteId: "i123456",
        statusLabel: "Connected · i123456",
        lastSyncLabel: null,
      },
    });
    assert.equal(sync.statusLabel, "Connected · i123456");
    assert.equal(sync.showConnect, false);
    assert.equal(sync.showSync, true);
  });
});

describe("getIntervalsConnection", () => {
  it("returns the stored row and does not revoke as a side effect", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "getter-pure";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email: "getter-pure@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i123456",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });

    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });
    const connection = getIntervalsConnection(userId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection?.athleteId, "i123456");
    assert.equal(connection?.apiKeyEnc, undefined);
    const still = getDb()
      .prepare("SELECT athleteId FROM intervals_connections WHERE userId = ?")
      .get(userId) as { athleteId: string };
    assert.equal(still.athleteId, "i123456");
    assert.equal(logged.filter((args) => String(args[0] ?? "").startsWith("[intervals]")).length, 0);
  });

  it("logs a revoke failure without throwing when revoke is called explicitly", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "revoke-reject";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email: "revoke-reject@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i123456",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });

    const database = getDb();
    const originalPrepare = database.prepare.bind(database);
    mock.method(database, "prepare", (sql: string) => {
      if (sql.includes("DELETE FROM intervals_connections")) throw new Error("revoke failed");
      return originalPrepare(sql);
    });

    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });
    await revokeUnownedIntervals(userId);
    assert.equal(getIntervalsConnection(userId)?.athleteId, "i123456");
    const revokeLogs = logged.filter(
      (args) => typeof args[0] === "string" && args[0].startsWith("[intervals] revoke unowned failed"),
    );
    assert.equal(revokeLogs.length, 1);
    assert.equal(revokeLogs[0]?.[0], "[intervals] revoke unowned failed");
    const dumped = JSON.stringify(logged, (_key, value) =>
      value instanceof Error ? { message: value.message } : value,
    );
    assert.equal(dumped.includes("owner-key-do-not-leak"), false);
    assert.equal(dumped.includes("INTERVALS_"), false);
  });
});

describe("connect/sync route", () => {
  it("does not call Intervals for a non-owner without a personal key", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "non-owner-route";
    const email = "runner@example.com";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email, createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i123456",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });

    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    });

    for (const intent of ["intervals-connect", "intervals-sync"] as const) {
      const formData = new FormData();
      formData.set("intent", intent);
      const result = await handleSettingsPost(userId, formData);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.status, 403);
      assert.equal(result.error, INTERVALS_NOT_FOR_ACCOUNT);
      assert.equal(result.section, "intervals");
    }

    assert.equal(fetched, false);
    assert.equal(canUseIntervals({ email }), false);
    assert.equal(canUseIntervals({ email: "CrisPal94@gmail.com" }), false);
    const verifiedOwner = { email: "CrisPal94@gmail.com", emailVerifiedAt: "2026-09-25T12:00:00.000Z" };
    assert.equal(canUseIntervals(verifiedOwner), true);
  });

  it("does not import a RunLog from sync or Which run? pick/skip when the connection is stale", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "stale-non-owner";
    const email = "stale-runner@example.com";
    const sessionId = "stale-session";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email, createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i123456",
      connectedAt: "2026-09-14T12:00:00.000Z",
    });
    const plan: Plan = {
      id: "stale-plan",
      userId,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      goal: "5k",
      raceDate: null,
      level: "beginner",
      days: ["mon"],
      feedbackCadence: "daily",
    };
    const session: Session = {
      id: sessionId,
      planId: plan.id,
      userId,
      date: "2026-09-14",
      weekday: "mon",
      weekIndex: 0,
      kind: "easy",
      title: "Easy run · 8 km",
      cue: "Keep it conversational",
      distanceKm: 8,
    };
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [plan],
        sessions: [session],
        feedbacks: [],
        runLogs: [],
        adaptationEvents: [],
      },
      "replace",
    );

    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response(
        JSON.stringify([
          {
            id: "act-stale",
            start_date_local: "2026-09-14T07:15:00",
            distance: 8000,
            moving_time: 2400,
            type: "Run",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const run = {
      activityId: "act-stale",
      date: "2026-09-14",
      distanceKm: 8,
      timeSec: 2400,
      paceSecPerKm: 300,
      start_date_local: "2026-09-14T07:15:00",
    };
    const pick = new FormData();
    pick.set("intent", "intervals-pick-run");
    pick.set("pickerDate", "2026-09-14");
    pick.set("pickerSessionId", sessionId);
    pick.set("pickerSessionDistanceKm", "8");
    pick.set("pickerRuns", JSON.stringify([run]));
    pick.set("pickerRemaining", "[]");
    pick.set("skippedNoSession", "0");
    pick.set("imported", "0");
    pick.set("activityId", "act-stale");

    const skip = new FormData();
    skip.set("intent", "intervals-skip-pick");
    skip.set("pickerRemaining", "[]");
    skip.set("skippedNoSession", "0");
    skip.set("imported", "0");

    const sync = new FormData();
    sync.set("intent", "intervals-sync");

    for (const [, formData] of [
      ["intervals-sync", sync],
      ["intervals-pick-run", pick],
      ["intervals-skip-pick", skip],
    ] as const) {
      const result = await handleSettingsPost(userId, formData);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 403);
        assert.equal(result.error, INTERVALS_NOT_FOR_ACCOUNT);
      }
    }

    assert.equal(fetched, false);
    assert.equal(loadTrainingSnapshot().runLogs.filter((entry) => entry.userId === userId).length, 0);
  });

  it("returns 403 and does not use the shared key when the user has no connection of their own", async () => {
    const envKey = "shared-env-key-do-not-use";
    process.env.INTERVALS_ICU_API_KEY = envKey;
    process.env.INTERVALS_ICU_ATHLETE_ID = "i123456";
    process.env.INTERVALS_OWNER_EMAILS = "owner-gate@example.com";
    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    const userId = "no-own-connection";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email: "no-own@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    const ownerId = "verified-owner-no-own";
    if (!getUserById(ownerId)) {
      insertUser({
        id: ownerId,
        email: "owner-gate@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        emailVerifiedAt: "2026-09-25T00:00:00.000Z",
      });
    }

    const auths: string[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const forms = intervalsIntentForms();
    for (const user of [userId]) {
      for (const formData of forms) {
        const result = await handleSettingsPost(user, formData);
        assert.equal(result.ok, false);
        if (result.ok) continue;
        assert.equal(result.status, 403);
        assert.equal(result.error, INTERVALS_NOT_FOR_ACCOUNT);
        assert.equal(result.error.includes("INTERVALS_"), false);
        assert.equal(result.error.includes(envKey), false);
      }
    }
    assert.equal(auths.length, 0);

    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    for (const formData of intervalsIntentForms()) {
      const result = await handleSettingsPost(ownerId, formData);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.status, 403);
      assert.equal(result.error, INTERVALS_NOT_FOR_ACCOUNT);
      assert.equal(JSON.stringify(result).includes(envKey), false);
    }
    assert.equal(auths.length, 0);

    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    const connect = new FormData();
    connect.set("intent", "intervals-connect");
    const allowed = await handleSettingsPost(ownerId, connect);
    assert.equal(allowed.ok, true);
    assert.equal(auths.some((header) => header === intervalsBasicAuthHeader(envKey)), true);
  });

  it("returns generic sync copy when the user can connect but has not yet", async () => {
    const previousSecret = process.env.INTERVALS_KEY_ENC_SECRET;
    const previousClientId = process.env.INTERVALS_CLIENT_ID;
    const previousClientSecret = process.env.INTERVALS_CLIENT_SECRET;
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    delete process.env.INTERVALS_ICU_API_KEY;
    const userId = "can-connect-not-yet";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email: "can-connect@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    const auths: string[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const sync = new FormData();
    sync.set("intent", "intervals-sync");
    try {
      process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 7).toString("base64");
      delete process.env.INTERVALS_CLIENT_ID;
      delete process.env.INTERVALS_CLIENT_SECRET;
      const withKey = await handleSettingsPost(userId, sync);
      assert.equal(withKey.ok, false);
      if (!withKey.ok) {
        assert.equal(withKey.status, undefined);
        assert.equal(withKey.error, INTERVALS_SYNC_NEEDS_CONNECT);
        assert.equal(withKey.error, "Connect Intervals.icu to import your runs.");
        assert.equal(withKey.error.includes("your account"), false);
        assert.equal(withKey.error.includes("isn’t available"), false);
        assert.equal(withKey.section, "intervals");
      }

      delete process.env.INTERVALS_KEY_ENC_SECRET;
      process.env.INTERVALS_CLIENT_ID = "stride-client";
      process.env.INTERVALS_CLIENT_SECRET = "stride-secret";
      const withOAuth = await handleSettingsPost(userId, sync);
      assert.equal(withOAuth.ok, false);
      if (!withOAuth.ok) {
        assert.equal(withOAuth.status, undefined);
        assert.equal(withOAuth.error, INTERVALS_SYNC_NEEDS_CONNECT);
        assert.equal(withOAuth.error.includes("your account"), false);
        assert.equal(withOAuth.error.includes("isn’t available"), false);
      }
      assert.equal(auths.length, 0);
    } finally {
      if (previousSecret === undefined) delete process.env.INTERVALS_KEY_ENC_SECRET;
      else process.env.INTERVALS_KEY_ENC_SECRET = previousSecret;
      if (previousClientId === undefined) delete process.env.INTERVALS_CLIENT_ID;
      else process.env.INTERVALS_CLIENT_ID = previousClientId;
      if (previousClientSecret === undefined) delete process.env.INTERVALS_CLIENT_SECRET;
      else process.env.INTERVALS_CLIENT_SECRET = previousClientSecret;
    }
  });

  it("hides internal sync errors and keeps the unavailable line for a missing secret", async () => {
    assert.equal(intervalsSyncUserError(INTERVALS_ENC_NOT_CONFIGURED), INTERVALS_SYNC_ERROR);
    assert.equal(intervalsSyncUserError(INTERVALS_API_KEY_NOT_CONFIGURED), INTERVALS_SYNC_ERROR);
    assert.equal(intervalsSyncUserError("API key not configured"), INTERVALS_SYNC_ERROR);
    assert.equal(intervalsSyncUserError(INTERVALS_CONNECT_UNAVAILABLE), INTERVALS_CONNECT_UNAVAILABLE);
    assert.equal(INTERVALS_SYNC_ERROR, "Couldn’t sync. Try again.");

    process.env.INTERVALS_OWNER_EMAILS = "owner-sync@example.com";
    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    delete process.env.INTERVALS_ICU_API_KEY;
    const userId = "sync-internal-error";
    if (!getUserById(userId)) {
      insertUser({
        id: userId,
        email: "owner-sync@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        emailVerifiedAt: "2026-09-25T12:00:00.000Z",
      });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i123456",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });
    const sync = new FormData();
    sync.set("intent", "intervals-sync");
    const result = await handleSettingsPost(userId, sync);
    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes(INTERVALS_API_KEY_NOT_CONFIGURED), false);
    assert.equal(dumped.includes(INTERVALS_ENC_NOT_CONFIGURED), false);
    assert.equal(dumped.includes("encryption is not configured"), false);
    if (!result.ok) assert.equal(result.error, INTERVALS_SYNC_ERROR);
    const view = getIntervalsConnectionView(userId);
    assert.equal(view.connected, true);
    if (!view.connected) return;
    assert.equal(view.lastSyncLabel, INTERVALS_SYNC_ERROR);
    assert.equal(view.lastSyncLabel.includes("API key"), false);
  });
});

function intervalsIntentForms(): FormData[] {
  const connect = new FormData();
  connect.set("intent", "intervals-connect");
  const sync = new FormData();
  sync.set("intent", "intervals-sync");
  const pick = new FormData();
  pick.set("intent", "intervals-pick-run");
  pick.set("pickerDate", "2026-09-14");
  pick.set("pickerSessionId", "no-own-session");
  pick.set("pickerSessionDistanceKm", "8");
  pick.set("pickerRuns", "[]");
  pick.set("pickerRemaining", "[]");
  pick.set("activityId", "act-stale");
  const skip = new FormData();
  skip.set("intent", "intervals-skip-pick");
  skip.set("pickerRemaining", "[]");
  skip.set("skippedNoSession", "0");
  skip.set("imported", "0");
  return [connect, sync, pick, skip];
}
