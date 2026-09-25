import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { getDb, getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import {
  canUseIntervals,
  getIntervalsConnection,
  INTERVALS_NOT_FOR_ACCOUNT,
  INTERVALS_UNAVAILABLE_STATUS,
  intervalsOwnerDeniedResponse,
  intervalsSettingsControls,
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
  it("shows Not available for your account and no buttons when the account cannot use Intervals", () => {
    const hidden = intervalsSettingsControls({
      available: false,
      connection: {
        connected: true,
        athleteId: "i704884",
        statusLabel: "Connected · i704884",
        lastSyncLabel: "Synced 2h ago",
      },
    });
    assert.equal(hidden.statusLabel, "Not available for your account");
    assert.equal(hidden.statusLabel, INTERVALS_UNAVAILABLE_STATUS);
    assert.equal(hidden.showConnect, false);
    assert.equal(hidden.showSync, false);

    const disconnected = intervalsSettingsControls({
      available: false,
      connection: { connected: false, statusLabel: "Not connected" },
    });
    assert.equal(disconnected.statusLabel, INTERVALS_UNAVAILABLE_STATUS);
    assert.equal(disconnected.showConnect, false);
    assert.equal(disconnected.showSync, false);
  });

  it("shows Connect or Sync now only for an owner", () => {
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
        athleteId: "i704884",
        statusLabel: "Connected · i704884",
        lastSyncLabel: null,
      },
    });
    assert.equal(sync.statusLabel, "Connected · i704884");
    assert.equal(sync.showConnect, false);
    assert.equal(sync.showSync, true);
  });
});

describe("getIntervalsConnection", () => {
  it("does not throw when revoking an unowned connection rejects", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "revoke-reject";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email: "revoke-reject@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i704884",
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
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const connection = getIntervalsConnection(userId);
      assert.equal(connection, null);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.equal(unhandled.length, 0);
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
  it("rejects a non-owner with 403 and does not call Intervals", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "non-owner-route";
    const email = "runner@example.com";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email, createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i704884",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });

    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    });

    for (const intent of ["intervals-connect", "intervals-sync"] as const) {
      const denied = intervalsOwnerDeniedResponse({ email }, intent);
      assert.ok(denied);
      assert.equal(denied.status, 403);
      const body = await denied.text();
      assert.equal(body, INTERVALS_NOT_FOR_ACCOUNT);
      assert.equal(body.includes("INTERVALS_OWNER_EMAILS"), false);
      assert.equal(body.includes("INTERVALS_ICU"), false);

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
    const verifiedOwner = { email: "CrisPal94@gmail.com", emailVerifiedAt: "2026-09-25T12:00:00.000Z" };
    assert.ok(intervalsOwnerDeniedResponse({ email: "CrisPal94@gmail.com" }, "intervals-connect"));
    assert.equal(intervalsOwnerDeniedResponse(verifiedOwner, "intervals-connect"), null);
    assert.equal(intervalsOwnerDeniedResponse(verifiedOwner, "intervals-sync"), null);
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
      athleteId: "i704884",
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

    for (const [intent, formData] of [
      ["intervals-sync", sync],
      ["intervals-pick-run", pick],
      ["intervals-skip-pick", skip],
    ] as const) {
      const denied = intervalsOwnerDeniedResponse({ email }, intent);
      assert.ok(denied);
      assert.equal(denied.status, 403);
      const result = await handleSettingsPost(userId, formData);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 403);
    }

    assert.equal(fetched, false);
    assert.equal(loadTrainingSnapshot().runLogs.filter((entry) => entry.userId === userId).length, 0);
  });
});
