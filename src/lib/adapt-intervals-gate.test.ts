import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { adaptRunLogLine } from "./adapt-cron.ts";
import { runNocturnalAdaptation } from "./adapt.ts";
import { getDb, getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import type { Feedback, Plan, RunLog, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-adapt-gate-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_OWNER_EMAILS: process.env.INTERVALS_OWNER_EMAILS,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  INTERVALS_ICU_API_KEY: process.env.INTERVALS_ICU_API_KEY,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  INTERVALS_OWNER_ENV_FALLBACK: process.env.INTERVALS_OWNER_ENV_FALLBACK,
};
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 5).toString("base64");

const NOW = new Date("2026-09-24T17:00:00.000Z");
const OWNER_EMAIL = "crispal94@gmail.com";

/**
 * Force the LLM to be unconfigured, whatever the developer's local `.env`
 * holds. `loadLocalEnv` runs at import time, so a configured machine would
 * otherwise make the adapt take the LLM path and call the real provider.
 */
function llmOff(): void {
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_MODEL;
}

/** Force the LLM to be configured through the Ollama fallback. */
function llmOn(model = "gemma4:31b"): void {
  delete process.env.ADAPT_LLM_API_KEY;
  process.env.OLLAMA_API_KEY = "test-only-key";
  process.env.OLLAMA_MODEL = model;
}

function restoreEnv(includeDataDir: boolean): void {
  const entries = Object.entries(originalEnv).filter(([key]) => includeDataDir || key !== "AUTH_DATA_DIR");
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv(false);
  process.env.AUTH_DATA_DIR = dataDir;
  process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 5).toString("base64");
});

after(() => {
  restoreEnv(true);
  rmSync(dataDir, { recursive: true, force: true });
});

function installAthlete(userId: string, email: string, emailVerifiedAt?: string): void {
  if (!getUserById(userId)) {
    insertUser({
      id: userId,
      email,
      createdAt: "2026-09-01T00:00:00.000Z",
      emailVerifiedAt,
    });
  }
  upsertIntervalsConnection({
    userId,
    athleteId: "i123456",
    connectedAt: "2026-09-01T00:00:00.000Z",
  });

  const planId = `${userId}-plan`;
  const todayId = `${userId}-today`;
  const tomorrowId = `${userId}-tomorrow`;
  const plan: Plan = {
    id: planId,
    userId,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["thu", "fri"],
    baseline: { kind: "skip" },
    feedbackCadence: "daily",
  };
  const today: Session = {
    id: todayId,
    planId,
    userId,
    date: "2026-09-24",
    weekday: "thu",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
  };
  const tomorrow: Session = {
    id: tomorrowId,
    planId,
    userId,
    date: "2026-09-25",
    weekday: "fri",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 10 km",
    cue: "Keep it conversational",
    distanceKm: 10,
  };
  const feedback: Feedback = {
    id: `${userId}-fb`,
    userId,
    planId,
    sessionId: todayId,
    kind: "skip",
    createdAt: "2026-09-24T15:00:00.000Z",
  };
  const log: RunLog = {
    id: `${userId}-log`,
    userId,
    sessionId: todayId,
    planId,
    distanceKm: 8,
    timeSec: 2400,
    paceSecPerKm: 300,
    createdAt: "2026-09-24T15:00:00.000Z",
    source: "intervals",
  };
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: [plan],
      sessions: [today, tomorrow],
      feedbacks: [feedback],
      runLogs: [log],
      adaptationEvents: [],
    },
    "replace",
  );
}

describe("adapt Intervals gate", () => {
  it("does not call upsertPlannedRuns or loadRunEffort for a non-owner with a stale connection", async () => {
    llmOff();
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    const userId = "adapt-non-owner";
    installAthlete(userId, "runner@example.com");
    const stored = getDb()
      .prepare("SELECT athleteId FROM intervals_connections WHERE userId = ?")
      .get(userId) as { athleteId: string };
    assert.equal(stored.athleteId, "i123456");

    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(loadRunEffort.mock.calls.length, 0);
    assert.equal(upsertPlannedRuns.mock.calls.length, 0);
    assert.equal(result.uploaded, 0);
    assert.match(adaptRunLogLine(result), /uploaded=0/);

    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents.some((event) => event.userId === userId), true);
    assert.equal(snapshot.sessions.find((session) => session.id === `${userId}-tomorrow`)?.distanceKm, 8);
  });

  it("uploads a Skip patch and loads effort for a connected owner", async () => {
    llmOff();
    process.env.INTERVALS_OWNER_EMAILS = `  ${OWNER_EMAIL.toUpperCase()}  `;
    const userId = "adapt-owner";
    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    process.env.INTERVALS_ICU_API_KEY = "owner-env-key";
    installAthlete(userId, OWNER_EMAIL, "2026-09-01T00:00:00.000Z");

    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(loadRunEffort.mock.calls.length, 1);
    assert.equal(upsertPlannedRuns.mock.calls.length, 1);
    assert.equal(result.uploaded, 1);
    assert.match(adaptRunLogLine(result), /uploaded=1/);
    assert.equal(loadTrainingSnapshot().sessions.find((session) => session.id === `${userId}-tomorrow`)?.distanceKm, 8);
  });

  it("does not call upsertPlannedRuns or loadRunEffort for an unverified allowlisted account", async () => {
    llmOff();
    process.env.INTERVALS_OWNER_EMAILS = `unverified-owner@example.com, ${OWNER_EMAIL}`;
    const userId = "adapt-unverified-owner";
    installAthlete(userId, "unverified-owner@example.com");

    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(loadRunEffort.mock.calls.length, 0);
    assert.equal(upsertPlannedRuns.mock.calls.length, 0);
    assert.equal(result.uploaded, 0);
    assert.match(adaptRunLogLine(result), /uploaded=0/);
    assert.equal(loadTrainingSnapshot().adaptationEvents.some((event) => event.userId === userId), true);
    assert.equal(loadTrainingSnapshot().sessions.find((session) => session.id === `${userId}-tomorrow`)?.distanceKm, 8);
  });

  it("parses an LLM adjustment wrapped in a markdown code fence", async () => {
    llmOn();
    const userId = "adapt-fenced-json";
    installAthlete(userId, "fenced-json@example.com");

    const adjustment = {
      title: "Plan adjusted",
      summary: "Trimmed after a skipped day.",
      reason: "You skipped Thursday, so tomorrow is shorter.",
      distanceKm: 6,
      kind: "easy",
    };
    const fenced = "```json\n" + JSON.stringify(adjustment, null, 2) + "\n```";
    const body = JSON.stringify({ choices: [{ message: { content: fenced } }] });
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));

    try {
      const loadRunEffort = mock.fn(async () => null);
      const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
      const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

      // The fenced content must parse; a discarded response would count as an
      // LLM failure and leave the heuristic result (8 km) in place.
      assert.equal(result.llmFailed, 0);
      const snapshot = loadTrainingSnapshot();
      assert.equal(snapshot.sessions.find((session) => session.id === `${userId}-tomorrow`)?.distanceKm, 6);
      assert.ok(fetchMock.mock.calls.length >= 1);
    } finally {
      mock.restoreAll();
    }
  });
});
