import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import {
  handleTodayPost,
  submitSessionFeedback,
  type Session,
} from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-feedback-done-"));
process.env.AUTH_DATA_DIR = dataDir;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const PLAN_ID = "plan-1";

function seedSession(userId: string, sessionId: string): Session {
  return {
    id: sessionId,
    planId: PLAN_ID,
    userId,
    date: "2026-09-15",
    weekday: "tue",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 5 km",
    cue: "Keep it conversational",
    distanceKm: 5,
  };
}

/** Fresh snapshot per test: one user, one session, optionally an Intervals-sourced run log. */
function seed({
  userId,
  sessionId,
  runLog,
}: {
  userId: string;
  sessionId: string;
  runLog?: { source: "intervals"; distanceKm: number; timeSec: number; paceSecPerKm: number };
}): void {
  saveTrainingSnapshot({
    onboarding: [],
    plans: [
      {
        id: PLAN_ID,
        userId,
        version: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
        goal: "5k",
        raceDate: null,
        level: "beginner",
        days: ["tue"],
        feedbackCadence: "daily",
      },
    ],
    sessions: [seedSession(userId, sessionId)],
    feedbacks: [],
    runLogs: runLog
      ? [
          {
            id: "runlog-1",
            userId,
            sessionId,
            planId: PLAN_ID,
            distanceKm: runLog.distanceKm,
            timeSec: runLog.timeSec,
            paceSecPerKm: runLog.paceSecPerKm,
            route: { type: "none" },
            createdAt: "2026-09-15T18:00:00.000Z",
            source: runLog.source,
          },
        ]
      : [],
    adaptationEvents: [],
  });
}

function emptyDoneForm(sessionId: string): FormData {
  const formData = new FormData();
  formData.set("intent", "done");
  formData.set("sessionId", sessionId);
  return formData;
}

function feedbacksFor(userId: string, sessionId: string) {
  return loadTrainingSnapshot().feedbacks.filter(
    (entry) => entry.userId === userId && entry.sessionId === sessionId,
  );
}

before(() => {
  assert.ok(typeof handleTodayPost === "function");
  assert.ok(typeof submitSessionFeedback === "function");
});

describe("intent=done from an Intervals-sourced run log", () => {
  it("creates a done feedback from the stored log with an empty form and marks the session done", async () => {
    seed({
      userId: "done-intervals",
      sessionId: "session-intervals",
      runLog: { source: "intervals", distanceKm: 5.2, timeSec: 1800, paceSecPerKm: 346 },
    });

    const result = await handleTodayPost("done-intervals", emptyDoneForm("session-intervals"));

    assert.deepEqual(result, { ok: true, redirect: "/today?saved=1" });
    const snapshot = loadTrainingSnapshot();
    const feedbacks = feedbacksFor("done-intervals", "session-intervals");
    assert.equal(feedbacks.length, 1);
    assert.equal(feedbacks[0]?.kind, "done");
    assert.equal(
      snapshot.sessions.find((entry) => entry.id === "session-intervals")?.outcome,
      "done",
    );
  });

  it("still fails with logOpen for an empty form when the session has no run log", async () => {
    seed({ userId: "done-no-log", sessionId: "session-no-log" });

    const result = await handleTodayPost("done-no-log", emptyDoneForm("session-no-log"));

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.logOpen, true);
    assert.equal(result.ok ? null : result.error, "Enter the distance you ran.");
    assert.equal(feedbacksFor("done-no-log", "session-no-log").length, 0);
  });

  it("does not create a second feedback when intent=done is posted again", async () => {
    seed({
      userId: "done-twice",
      sessionId: "session-twice",
      runLog: { source: "intervals", distanceKm: 5.2, timeSec: 1800, paceSecPerKm: 346 },
    });

    const first = await handleTodayPost("done-twice", emptyDoneForm("session-twice"));
    const second = await handleTodayPost("done-twice", emptyDoneForm("session-twice"));

    assert.deepEqual(first, { ok: true, redirect: "/today?saved=1" });
    assert.deepEqual(second, { ok: true, redirect: "/today?saved=1" });
    const feedbacks = feedbacksFor("done-twice", "session-twice");
    assert.equal(feedbacks.length, 1);
    assert.equal(feedbacks[0]?.kind, "done");
  });

  it("keeps the stored run log numbers through the fallback path", async () => {
    seed({
      userId: "done-numbers",
      sessionId: "session-numbers",
      runLog: { source: "intervals", distanceKm: 5.2, timeSec: 1800, paceSecPerKm: 346 },
    });

    await handleTodayPost("done-numbers", emptyDoneForm("session-numbers"));

    const stored = loadTrainingSnapshot().runLogs.find(
      (entry) => entry.userId === "done-numbers" && entry.sessionId === "session-numbers",
    );
    assert.ok(stored);
    assert.equal(stored.distanceKm, 5.2);
    assert.equal(stored.timeSec, 1800);
    assert.equal(stored.paceSecPerKm, 346);
    assert.deepEqual(stored.route, { type: "none" });
    // Provenance must survive: the import skips a run log it considers manual,
    // so relabelling this one would silently freeze that day on every sync.
    assert.equal(stored.source, "intervals");
  });

  it("fails without falling back when the typed distance does not validate", async () => {
    seed({
      userId: "done-typed-bad",
      sessionId: "session-typed-bad",
      runLog: { source: "intervals", distanceKm: 5.2, timeSec: 1800, paceSecPerKm: 346 },
    });

    const form = emptyDoneForm("session-typed-bad");
    form.set("loggedDistanceKm", "0");
    const result = await handleTodayPost("done-typed-bad", form);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.logOpen, true);
    assert.equal(result.ok ? null : result.error, "Enter the distance you ran.");
    const stored = loadTrainingSnapshot().runLogs.find(
      (entry) => entry.userId === "done-typed-bad" && entry.sessionId === "session-typed-bad",
    );
    assert.ok(stored);
    assert.equal(stored.distanceKm, 5.2);
    assert.equal(feedbacksFor("done-typed-bad", "session-typed-bad").length, 0);
  });
});