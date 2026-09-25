import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { cleanupNonOwnerIntervalsRunLogs, PER_USER_INTERVALS_SINCE } from "./cleanup-intervals-nonowners.ts";
import {
  getIntervalsConnection,
  insertUser,
  loadTrainingSnapshot,
  saveTrainingSnapshot,
  upsertIntervalsConnection,
} from "./db.ts";
import { disconnectIntervals, type IntervalsRunStats } from "./intervals.ts";
import { applyIntervalsRuns, type Plan, type RunLog, type Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-reimport-cutoff-"));
process.env.AUTH_DATA_DIR = dataDir;

const USER_ID = "reimport-user";
const PRE_CREATED_AT = "2026-09-20T08:00:00.000Z";
const POST_CREATED_AT = "2026-09-26T08:00:00.000Z";
const PRE_DAY = "2026-09-14";
const POST_DAY = "2026-09-26";
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;

function run(date: string, activityId: string, distanceKm: number): IntervalsRunStats {
  return {
    activityId,
    date,
    distanceKm,
    timeSec: 2100,
    paceSecPerKm: 2100 / distanceKm,
    start_date_local: `${date}T07:00:00`,
  };
}

function log(id: string, sessionId: string, createdAt: string, source: "intervals" | "manual"): RunLog {
  return {
    id,
    userId: USER_ID,
    sessionId,
    planId: `${USER_ID}-plan`,
    distanceKm: 5,
    timeSec: 1800,
    paceSecPerKm: 360,
    createdAt,
    source,
  };
}

function session(id: string, date: string): Session {
  return {
    id,
    planId: `${USER_ID}-plan`,
    userId: USER_ID,
    date,
    weekday: "mon",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 5 km",
    cue: "Easy",
    distanceKm: 5,
  };
}

after(() => {
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
});

describe("intervals re-import createdAt", () => {
  it("keeps the original createdAt so cleanup still deletes a pre-cutoff row after reconnect, re-import, and disconnect", async () => {
    assert.ok(PRE_CREATED_AT < PER_USER_INTERVALS_SINCE);
    assert.ok(POST_CREATED_AT >= PER_USER_INTERVALS_SINCE);

    insertUser({ id: USER_ID, email: "reimport@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const plan: Plan = {
      id: `${USER_ID}-plan`,
      userId: USER_ID,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      goal: "5k",
      raceDate: null,
      level: "beginner",
      days: ["mon"],
      feedbackCadence: "daily",
    };
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [plan],
        sessions: [session("pre-session", PRE_DAY), session("post-session", POST_DAY)],
        feedbacks: [],
        runLogs: [
          log("pre-log", "pre-session", PRE_CREATED_AT, "intervals"),
          log("post-log", "post-session", POST_CREATED_AT, "intervals"),
          log("manual-log", "manual-session", "2026-09-01T00:00:00.000Z", "manual"),
        ],
        adaptationEvents: [],
      },
      "replace",
    );

    upsertIntervalsConnection({
      userId: USER_ID,
      athleteId: "i123456",
      connectedAt: "2026-09-25T12:00:00.000Z",
      apiKeyEnc: "v1:reconnected-secret",
      authType: "apikey",
    });
    process.env.INTERVALS_OWNER_EMAILS = "owner-not-this-user@example.com";

    const whileConnected = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(whileConnected.aborted, false);
    assert.equal(whileConnected.rows.find((row) => row.userId === USER_ID)?.wouldDelete, 0);

    const imported = await applyIntervalsRuns(USER_ID, [
      run(PRE_DAY, "act-pre", 6.4),
      run(POST_DAY, "act-post", 7.1),
    ]);
    assert.equal(imported.imported, 2);

    const rewritten = loadTrainingSnapshot().runLogs;
    const pre = rewritten.find((entry) => entry.id === "pre-log");
    const post = rewritten.find((entry) => entry.id === "post-log");
    assert.equal(pre?.createdAt, PRE_CREATED_AT);
    assert.equal(pre?.distanceKm, 6.4);
    assert.equal(pre?.source, "intervals");
    assert.equal(post?.createdAt, POST_CREATED_AT);
    assert.equal(post?.distanceKm, 7.1);
    assert.equal(rewritten.filter((entry) => entry.userId === USER_ID && entry.source === "intervals").length, 2);

    await disconnectIntervals(USER_ID);
    assert.equal(getIntervalsConnection(USER_ID), null);

    const cleaned = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(cleaned.aborted, false);
    assert.equal(cleaned.rows.find((row) => row.userId === USER_ID)?.wouldDelete, 1);
    const ids = loadTrainingSnapshot()
      .runLogs.map((entry) => entry.id)
      .sort();
    assert.deepEqual(ids, ["manual-log", "post-log"]);
    assert.equal(loadTrainingSnapshot().runLogs.find((entry) => entry.id === "post-log")?.createdAt, POST_CREATED_AT);
  });
});
