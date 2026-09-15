import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import {
  connectIntervals,
  INTERVALS_CONNECT_ERROR,
  INTERVALS_NO_NEW_RUNS_TOAST,
  INTERVALS_NO_SESSION_TOAST,
  INTERVALS_SYNC_ERROR,
  intervalsActivityDay,
  intervalsActivityStats,
  intervalsSyncToast,
  intervalsSyncToastCopy,
  intervalsSyncToastRedirect,
  loadIntervalsRunsForSync,
  parseIntervalsActivity,
  type IntervalsRunStats,
} from "./intervals.ts";
import { applyIntervalsRuns, handleSettingsPost, type Plan, type RunLog, type Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-"));
process.env.AUTH_DATA_DIR = dataDir;

const API_KEY = "icu-fixture-key-do-not-leak";
const SESSION_DAY = "2026-09-14";
const OTHER_DAY = "2026-09-15";

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function planAndSession(userId: string): { plan: Plan; session: Session } {
  const plan: Plan = {
    id: `${userId}-plan`,
    userId,
    version: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["mon", "wed", "fri"],
    feedbackCadence: "daily",
  };
  const session: Session = {
    id: `${userId}-session`,
    planId: plan.id,
    userId,
    date: SESSION_DAY,
    weekday: "mon",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
  };
  return { plan, session };
}

function seed(userId: string, runLogs: RunLog[] = []): { plan: Plan; session: Session } {
  const { plan, session } = planAndSession(userId);
  saveTrainingSnapshot({
    onboarding: [],
    plans: [plan],
    sessions: [session],
    feedbacks: [],
    runLogs,
    adaptationEvents: [],
  });
  return { plan, session };
}

function runStats(
  date: string,
  activityId: string,
  distanceKm = 8.05,
  timeSec = 2415,
): IntervalsRunStats {
  return {
    activityId,
    date,
    distanceKm,
    timeSec,
    paceSecPerKm: timeSec / distanceKm,
    start_date_local: `${date}T07:15:00`,
  };
}

function logsFor(userId: string): RunLog[] {
  return loadTrainingSnapshot().runLogs.filter((entry) => entry.userId === userId);
}

function connectUser(userId: string): void {
  upsertIntervalsConnection({
    userId,
    athleteId: "i704884",
    connectedAt: "2026-09-14T12:00:00.000Z",
  });
}

function activityPayload(
  date: string,
  id: string,
  distanceM = 8050,
  movingTime = 2415,
): Record<string, unknown> {
  return {
    id,
    start_date_local: `${date}T07:15:00`,
    distance: distanceM,
    moving_time: movingTime,
    type: "Run",
  };
}

function mockActivities(payload: unknown): void {
  mock.method(globalThis, "fetch", async () => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function postSync(userId: string) {
  const formData = new FormData();
  formData.set("intent", "intervals-sync");
  return handleSettingsPost(userId, formData);
}

describe("Intervals activity day", () => {
  it("uses the Guayaquil civil day from start_date_local", () => {
    assert.equal(intervalsActivityDay("2026-09-14T07:15:00"), SESSION_DAY);
    assert.equal(intervalsActivityDay("2026-09-14T23:45:00"), SESSION_DAY);
    assert.equal(intervalsActivityDay("2026-09-14"), SESSION_DAY);

    const activity = parseIntervalsActivity({
      id: "act-local",
      start_date_local: "2026-09-14T07:15:00",
      distance: 8050,
      moving_time: 2415,
      type: "Run",
    });
    const stats = activity ? intervalsActivityStats(activity) : null;
    assert.equal(stats?.date, SESSION_DAY);
  });
});

describe("applyIntervalsRuns", () => {
  it("matches a Run to the Session on that Guayaquil day and skips days with no Session", async () => {
    const userId = "match-skip";
    const { session } = seed(userId);
    const matched = runStats(SESSION_DAY, "act-match");
    const orphan = runStats(OTHER_DAY, "act-orphan");

    const result = await applyIntervalsRuns(userId, [matched, orphan]);
    const stored = logsFor(userId);

    assert.equal(result.imported, 1);
    assert.equal(result.skippedNoSession, 1);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.sessionId, session.id);
    assert.equal(stored[0]?.source, "intervals");
    assert.equal(
      stored.some((entry) => entry.sessionId !== session.id),
      false,
    );
  });

  it("upserts the same Intervals activity for the same Session without duplicate RunLogs", async () => {
    const userId = "idempotent";
    const { session } = seed(userId);
    const run = runStats(SESSION_DAY, "act-same");

    const first = await applyIntervalsRuns(userId, [run]);
    const afterFirst = logsFor(userId);
    const second = await applyIntervalsRuns(userId, [run]);
    const afterSecond = logsFor(userId);

    assert.equal(first.imported, 1);
    assert.equal(second.imported, 1);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterSecond.length, 1);
    assert.equal(afterSecond[0]?.id, afterFirst[0]?.id);
    assert.equal(afterSecond[0]?.sessionId, session.id);
    assert.equal(afterSecond[0]?.source, "intervals");
    assert.equal(afterSecond[0]?.distanceKm, run.distanceKm);
  });

  it("does not overwrite a manual RunLog with an Intervals import", async () => {
    const userId = "manual-wins";
    const { plan, session } = planAndSession(userId);
    const manual: RunLog = {
      id: "manual-log",
      userId,
      sessionId: session.id,
      planId: plan.id,
      distanceKm: 7.2,
      timeSec: 2100,
      paceSecPerKm: 2100 / 7.2,
      createdAt: "2026-09-14T18:00:00.000Z",
      source: "manual",
    };
    seed(userId, [manual]);

    const result = await applyIntervalsRuns(userId, [runStats(SESSION_DAY, "act-ignored", 9.5, 2800)]);
    const stored = logsFor(userId);

    assert.equal(result.imported, 0);
    assert.equal(result.skippedManual, 1);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, "manual-log");
    assert.equal(stored[0]?.source, "manual");
    assert.equal(stored[0]?.distanceKm, 7.2);
    assert.equal(stored[0]?.timeSec, 2100);
  });

  it("leaves RunLogs untouched and reports no import when Intervals returns no Runs", async () => {
    const userId = "empty-fetch";
    seed(userId);

    const result = await applyIntervalsRuns(userId, []);

    assert.equal(result.imported, 0);
    assert.equal(result.skippedNoSession, 0);
    assert.equal(result.skippedManual, 0);
    assert.equal(result.pendingChoices.length, 0);
    assert.equal(logsFor(userId).length, 0);
  });

  it("does not write an orphan RunLog and queues Which run? when one Session has several Runs", async () => {
    const userId = "picker";
    const { session } = seed(userId);

    const result = await applyIntervalsRuns(userId, [
      runStats(SESSION_DAY, "act-a", 7.9, 2400),
      runStats(SESSION_DAY, "act-b", 8.1, 2430),
    ]);

    assert.equal(result.imported, 0);
    assert.equal(result.skippedNoSession, 0);
    assert.equal(result.pendingChoices.length, 1);
    assert.equal(result.pendingChoices[0]?.sessionId, session.id);
    assert.equal(result.pendingChoices[0]?.runs.length, 2);
    assert.equal(logsFor(userId).length, 0);
  });
});

describe("Intervals Sync toasts", () => {
  it("uses No new runs to import when there is nothing to import", () => {
    assert.equal(INTERVALS_NO_NEW_RUNS_TOAST, "No new runs to import");
    assert.equal(INTERVALS_NO_SESSION_TOAST, "No planned session that day");
    assert.equal(intervalsSyncToast({ imported: 0, skippedNoSession: 0 }), "no-new-runs");
    assert.equal(intervalsSyncToastCopy("no-new-runs"), INTERVALS_NO_NEW_RUNS_TOAST);
    assert.equal(intervalsSyncToastRedirect("no-new-runs"), "/settings?toast=no-new-runs");
  });

  it("keeps No planned session that day when Runs exist without a Session", () => {
    assert.equal(intervalsSyncToast({ imported: 0, skippedNoSession: 1 }), "no-session");
    assert.equal(intervalsSyncToast({ imported: 1, skippedNoSession: 1 }), "no-session");
    assert.equal(intervalsSyncToastCopy("no-session"), INTERVALS_NO_SESSION_TOAST);
    assert.equal(intervalsSyncToastRedirect("no-session"), "/settings?toast=no-session");
  });

  it("does not toast after a successful import", () => {
    assert.equal(intervalsSyncToast({ imported: 1, skippedNoSession: 0 }), null);
    assert.equal(intervalsSyncToastRedirect(null), "/settings");
  });
});

describe("connect/sync error text", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.INTERVALS_ICU_API_KEY;
  });

  it("connectIntervals never returns the API key in error text", async () => {
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mock.method(console, "error", () => {});
    mock.method(globalThis, "fetch", async () => {
      throw new Error(`401 Unauthorized for ${API_KEY}`);
    });

    const result = await connectIntervals("user-connect");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, INTERVALS_CONNECT_ERROR);
    assert.equal(result.error.includes(API_KEY), false);
  });

  it("loadIntervalsRunsForSync never returns the API key in error text", async () => {
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mock.method(console, "error", () => {});
    mock.method(globalThis, "fetch", async () => {
      return new Response(`invalid key ${API_KEY}`, { status: 401, statusText: "Unauthorized" });
    });

    const result = await loadIntervalsRunsForSync(SESSION_DAY, SESSION_DAY);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, INTERVALS_SYNC_ERROR);
    assert.equal(result.error.includes(API_KEY), false);
  });
});

describe("Settings Sync path", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.INTERVALS_ICU_API_KEY;
  });

  it("toasts No new runs to import when Intervals returns no Runs", async () => {
    const userId = "settings-empty";
    seed(userId);
    connectUser(userId);
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mockActivities([]);

    const result = await postSync(userId);
    assert.deepEqual(result, { ok: true, redirect: "/settings?toast=no-new-runs" });
    assert.equal(logsFor(userId).length, 0);
  });

  it("toasts No planned session that day when there are Runs but no Session that Guayaquil day", async () => {
    const userId = "settings-no-session";
    seed(userId);
    connectUser(userId);
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mockActivities([activityPayload(OTHER_DAY, "act-orphan")]);

    const result = await postSync(userId);
    assert.deepEqual(result, { ok: true, redirect: "/settings?toast=no-session" });
    assert.equal(logsFor(userId).length, 0);
  });

  it("opens Which run? when one Session has more than one Run", async () => {
    const userId = "settings-picker";
    const { session } = seed(userId);
    connectUser(userId);
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mockActivities([
      activityPayload(SESSION_DAY, "act-a", 7900, 2400),
      activityPayload(SESSION_DAY, "act-b", 8100, 2430),
    ]);

    const result = await postSync(userId);
    if (!result.ok || !("picker" in result)) {
      throw new Error("expected Which run? picker");
    }
    assert.equal(result.picker.choice.sessionId, session.id);
    assert.equal(result.picker.choice.runs.length, 2);
    assert.equal(result.picker.skippedNoSession, false);
    assert.equal(logsFor(userId).length, 0);
  });

  it("does not overwrite a manual RunLog and toasts No new runs to import", async () => {
    const userId = "settings-manual";
    const { plan, session } = planAndSession(userId);
    const manual: RunLog = {
      id: "manual-settings",
      userId,
      sessionId: session.id,
      planId: plan.id,
      distanceKm: 7.2,
      timeSec: 2100,
      paceSecPerKm: 2100 / 7.2,
      createdAt: "2026-09-14T18:00:00.000Z",
      source: "manual",
    };
    seed(userId, [manual]);
    connectUser(userId);
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mockActivities([activityPayload(SESSION_DAY, "act-ignored", 9500, 2800)]);

    const result = await postSync(userId);
    assert.deepEqual(result, { ok: true, redirect: "/settings?toast=no-new-runs" });
    const stored = logsFor(userId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, "manual-settings");
    assert.equal(stored[0]?.source, "manual");
    assert.equal(stored[0]?.distanceKm, 7.2);
  });

  it("imports a matching Run without a toast", async () => {
    const userId = "settings-import";
    const { session } = seed(userId);
    connectUser(userId);
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    mockActivities([activityPayload(SESSION_DAY, "act-match")]);

    const result = await postSync(userId);
    assert.deepEqual(result, { ok: true, redirect: "/settings" });
    const stored = logsFor(userId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.sessionId, session.id);
    assert.equal(stored[0]?.source, "intervals");
  });
});
