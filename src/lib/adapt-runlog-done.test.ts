import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runNocturnalAdaptation } from "./adapt.ts";
import { loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import type { AdaptationEvent, Feedback, FeedbackKind, Plan, RunLog, RunLogSource, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-adapt-runlog-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
};
process.env.AUTH_DATA_DIR = dataDir;

const NOW = new Date("2026-09-24T17:00:00.000Z");
const TODAY = "2026-09-24";
const YESTERDAY = "2026-09-23";
const TOMORROW = "2026-09-25";
const OUTSIDE = "2026-09-22";
const USER = "runlog-done-user";
const PLAN_ID = "runlog-done-plan";

function llmOff(): void {
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_MODEL;
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

beforeEach(() => {
  process.env.AUTH_DATA_DIR = dataDir;
  llmOff();
});

function plan(): Plan {
  return {
    id: PLAN_ID,
    userId: USER,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["wed", "thu", "fri"],
    baseline: { kind: "skip" },
    feedbackCadence: "daily",
  };
}

function session(
  id: string,
  date: string,
  weekday: Session["weekday"],
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    planId: PLAN_ID,
    userId: USER,
    date,
    weekday,
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
    ...overrides,
  };
}

function nextSession(): Session {
  return session("next", TOMORROW, "fri", {
    kind: "tempo",
    title: "Tempo · 11 km",
    cue: "Comfortably hard, controlled",
    distanceKm: 11,
  });
}

function log(sessionId: string, source: RunLogSource, createdAt: string, id = `log-${sessionId}`): RunLog {
  return {
    id,
    userId: USER,
    sessionId,
    planId: PLAN_ID,
    distanceKm: 11,
    timeSec: 3300,
    paceSecPerKm: 300,
    createdAt,
    source,
  };
}

function feedback(sessionId: string, kind: FeedbackKind): Feedback {
  return {
    id: `fb-${kind}`,
    userId: USER,
    planId: PLAN_ID,
    sessionId,
    kind,
    createdAt: "2026-09-24T15:00:00.000Z",
  };
}

function priorEvent(sourceDate: string): AdaptationEvent {
  return {
    id: "existing-event",
    userId: USER,
    planId: PLAN_ID,
    sessionId: "next",
    date: TOMORROW,
    title: "Plan adjusted",
    summary: "Already adjusted.",
    reason: "Earlier adaptation.",
    sourceDate,
    createdAt: "2026-09-22T02:00:00.000Z",
  };
}

function save(input: {
  sessions: Session[];
  feedbacks?: Feedback[];
  runLogs?: RunLog[];
  adaptationEvents?: AdaptationEvent[];
}): void {
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: [plan()],
      sessions: input.sessions,
      feedbacks: input.feedbacks ?? [],
      runLogs: input.runLogs ?? [],
      adaptationEvents: input.adaptationEvents ?? [],
    },
    "replace",
  );
}

function storedNext(): Session | undefined {
  return loadTrainingSnapshot().sessions.find((entry) => entry.id === "next");
}

describe("adapt Intervals RunLog as done", { concurrency: false }, () => {
  it("treats an Intervals RunLog with no Feedback as done and is idempotent", async () => {
    save({
      sessions: [session("ran", YESTERDAY, "wed"), nextSession()],
      runLogs: [log("ran", "intervals", "2026-09-23T18:00:00.000Z")],
    });

    const first = await runNocturnalAdaptation(NOW);
    assert.equal(first.written, 1);
    assert.equal(first.patched, 0);
    assert.equal(first.llmFailed, 0);

    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.feedbacks.length, 0);
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(snapshot.adaptationEvents.length, 1);
    assert.equal(snapshot.adaptationEvents[0]?.sourceDate, YESTERDAY);
    assert.equal(snapshot.adaptationEvents[0]?.reason, "Run logged. Tomorrow stays.");
    assert.equal(storedNext()?.kind, "tempo");
    assert.equal(storedNext()?.distanceKm, 11);

    const second = await runNocturnalAdaptation(NOW);
    assert.equal(second.written, 0);
    assert.equal(loadTrainingSnapshot().adaptationEvents.length, 1);
    assert.equal(storedNext()?.distanceKm, 11);
  });

  it("treats today's Intervals RunLog as done when Feedback is absent", async () => {
    save({
      sessions: [session("ran", TODAY, "thu"), nextSession()],
      runLogs: [log("ran", "intervals", "2026-09-24T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 1);
    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents[0]?.sourceDate, TODAY);
    assert.equal(snapshot.adaptationEvents[0]?.reason, "Run logged. Tomorrow stays.");
    assert.equal(snapshot.feedbacks.length, 0);
  });

  it("lets Feeling off win over an Intervals RunLog", async () => {
    save({
      sessions: [session("ran", TODAY, "thu"), nextSession()],
      feedbacks: [feedback("ran", "feeling-off")],
      runLogs: [log("ran", "intervals", "2026-09-24T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 1);
    assert.equal(result.patched, 1);
    const snapshot = loadTrainingSnapshot();
    assert.match(snapshot.adaptationEvents[0]?.reason ?? "", /feeling off/i);
    assert.equal(storedNext()?.kind, "easy");
    assert.equal(storedNext()?.distanceKm, 8);
  });

  it("lets Skip win over an Intervals RunLog", async () => {
    save({
      sessions: [session("ran", TODAY, "thu"), nextSession()],
      feedbacks: [feedback("ran", "skip")],
      runLogs: [log("ran", "intervals", "2026-09-24T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 1);
    assert.equal(result.patched, 1);
    const snapshot = loadTrainingSnapshot();
    assert.match(snapshot.adaptationEvents[0]?.reason ?? "", /skipped/i);
    assert.equal(storedNext()?.kind, "easy");
    assert.equal(storedNext()?.distanceKm, 9);
  });

  it("skips when an AdaptationEvent already exists for that sourceDate", async () => {
    save({
      sessions: [session("ran", YESTERDAY, "wed"), nextSession()],
      runLogs: [log("ran", "intervals", "2026-09-23T18:00:00.000Z")],
      adaptationEvents: [priorEvent(YESTERDAY)],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 0);
    assert.equal(result.patched, 0);
    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents.length, 1);
    assert.equal(snapshot.adaptationEvents[0]?.id, "existing-event");
    assert.equal(snapshot.adaptationEvents[0]?.reason, "Earlier adaptation.");
    assert.equal(storedNext()?.distanceKm, 11);
    assert.equal(storedNext()?.kind, "tempo");
  });

  it("still adapts when the only AdaptationEvent is outside the window", async () => {
    save({
      sessions: [session("ran", TODAY, "thu"), nextSession()],
      runLogs: [log("ran", "intervals", "2026-09-24T18:00:00.000Z")],
      adaptationEvents: [priorEvent(OUTSIDE)],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 1);
    const events = loadTrainingSnapshot().adaptationEvents;
    assert.equal(events.length, 2);
    assert.equal(events.some((event) => event.id === "existing-event"), true);
    assert.equal(events.some((event) => event.sourceDate === TODAY), true);
  });

  it("ignores an Intervals RunLog from before the adapt window", async () => {
    save({
      sessions: [session("old", OUTSIDE, "tue"), nextSession()],
      runLogs: [log("old", "intervals", "2026-09-22T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 0);
    assert.equal(loadTrainingSnapshot().adaptationEvents.length, 0);
    assert.equal(storedNext()?.distanceKm, 11);
  });

  it("does not treat a manual RunLog as done", async () => {
    save({
      sessions: [session("ran", TODAY, "thu"), nextSession()],
      runLogs: [log("ran", "manual", "2026-09-24T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 0);
    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents.length, 0);
    assert.equal(snapshot.feedbacks.length, 0);
  });

  it("does not invent a Session or Feedback for an unmatched Intervals RunLog", async () => {
    save({
      sessions: [nextSession()],
      runLogs: [log("missing-session", "intervals", "2026-09-24T18:00:00.000Z")],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 0);
    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0]?.id, "next");
    assert.equal(snapshot.feedbacks.length, 0);
    assert.equal(snapshot.adaptationEvents.length, 0);
  });

  it("uses the later planned day when yesterday and today both have Intervals runs", async () => {
    save({
      sessions: [
        session("yesterday", YESTERDAY, "wed"),
        session("today", TODAY, "thu"),
        nextSession(),
      ],
      runLogs: [
        log("yesterday", "intervals", "2026-09-24T20:00:00.000Z", "log-yesterday"),
        log("today", "intervals", "2026-09-24T12:00:00.000Z", "log-today"),
      ],
    });

    const result = await runNocturnalAdaptation(NOW);
    assert.equal(result.written, 1);
    assert.equal(loadTrainingSnapshot().adaptationEvents[0]?.sourceDate, TODAY);
  });
});
