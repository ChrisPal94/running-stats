import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { adaptRunLogLine } from "./adapt-cron.ts";
import { runNocturnalAdaptation } from "./adapt.ts";
import { insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import type { Feedback, Plan, RunLog, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-adapt-fail-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
};
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 9).toString("base64");

const NOW = new Date("2026-09-24T17:00:00.000Z");
const FAILING = "adapt-fail-user";
const OK = "adapt-ok-user";

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
  process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 9).toString("base64");
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
});

function athlete(userId: string): {
  plan: Plan;
  today: Session;
  tomorrow: Session;
  feedback: Feedback;
  log: RunLog;
} {
  insertUser({ id: userId, email: `${userId}@example.com`, createdAt: "2026-09-01T00:00:00.000Z" });
  upsertIntervalsConnection({
    userId,
    athleteId: "i123456",
    connectedAt: "2026-09-01T00:00:00.000Z",
    apiKeyEnc: encryptIntervalsApiKey(`key-${userId}`, userId),
    authType: "apikey",
  });
  const planId = `${userId}-plan`;
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
    id: `${userId}-today`,
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
    id: `${userId}-tomorrow`,
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
    sessionId: today.id,
    kind: "skip",
    createdAt: "2026-09-24T15:00:00.000Z",
  };
  const log: RunLog = {
    id: `${userId}-log`,
    userId,
    sessionId: today.id,
    planId,
    distanceKm: 8,
    timeSec: 2400,
    paceSecPerKm: 300,
    createdAt: "2026-09-24T15:00:00.000Z",
    source: "intervals",
  };
  return { plan, today, tomorrow, feedback, log };
}

describe("adapt account failure", () => {
  it("counts a thrown account as skipped and still adapts the other account", async () => {
    delete process.env.ADAPT_LLM_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    const failing = athlete(FAILING);
    const ok = athlete(OK);
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [failing.plan, ok.plan],
        sessions: [failing.today, failing.tomorrow, ok.today, ok.tomorrow],
        feedbacks: [failing.feedback, ok.feedback],
        runLogs: [failing.log, ok.log],
        adaptationEvents: [],
      },
      "replace",
    );

    const lines: string[] = [];
    mock.method(console, "error", (line: string) => {
      lines.push(String(line));
    });
    const loadRunEffort = mock.fn(async (userId: string) => {
      if (userId === FAILING) throw new Error("effort down");
      return null;
    });
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));

    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(result.processed, 2);
    assert.equal(result.written, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.patched, 1);
    assert.match(adaptRunLogLine(result), /skipped=1/);
    assert.equal(adaptRunLogLine(result).includes(FAILING), false);
    assert.equal(lines.some((line) => line.includes("[intervals] adapt account failed")), true);

    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents.some((event) => event.userId === FAILING), false);
    assert.equal(snapshot.adaptationEvents.some((event) => event.userId === OK), true);
    assert.equal(snapshot.sessions.find((session) => session.id === `${FAILING}-tomorrow`)?.distanceKm, 10);
    assert.equal(snapshot.sessions.find((session) => session.id === `${OK}-tomorrow`)?.distanceKm, 8);
    assert.equal(upsertPlannedRuns.mock.calls.length, 1);
  });
});
