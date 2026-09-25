import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { adaptRunLogLine } from "./adapt-cron.ts";
import { runNocturnalAdaptation } from "./adapt.ts";
import { getDb, getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import type { Feedback, Plan, RunLog, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-adapt-gate-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_OWNER_EMAILS: process.env.INTERVALS_OWNER_EMAILS,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  INTERVALS_ICU_API_KEY: process.env.INTERVALS_ICU_API_KEY,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  INTERVALS_OWNER_ENV_FALLBACK: process.env.INTERVALS_OWNER_ENV_FALLBACK,
};
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 5).toString("base64");

const NOW = new Date("2026-09-24T17:00:00.000Z");
const OWNER_EMAIL = "crispal94@gmail.com";

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

function installAthlete(userId: string, email: string): void {
  if (!getUserById(userId)) {
    insertUser({
      id: userId,
      email,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  upsertIntervalsConnection({
    userId,
    athleteId: "i704884",
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
    delete process.env.ADAPT_LLM_API_KEY;
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    const userId = "adapt-non-owner";
    installAthlete(userId, "runner@example.com");
    const stored = getDb()
      .prepare("SELECT athleteId FROM intervals_connections WHERE userId = ?")
      .get(userId) as { athleteId: string };
    assert.equal(stored.athleteId, "i704884");

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
    delete process.env.ADAPT_LLM_API_KEY;
    process.env.INTERVALS_OWNER_EMAILS = `  ${OWNER_EMAIL.toUpperCase()}  `;
    const userId = "adapt-owner";
    installAthlete(userId, OWNER_EMAIL);
    upsertIntervalsConnection({
      userId,
      athleteId: "i704884",
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: encryptIntervalsApiKey("owner-personal-key"),
      needsReconnect: false,
    });

    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(loadRunEffort.mock.calls.length, 1);
    assert.equal(upsertPlannedRuns.mock.calls.length, 1);
    assert.equal(result.uploaded, 1);
    assert.match(adaptRunLogLine(result), /uploaded=1/);
    assert.equal(loadTrainingSnapshot().sessions.find((session) => session.id === `${userId}-tomorrow`)?.distanceKm, 8);
  });
});
