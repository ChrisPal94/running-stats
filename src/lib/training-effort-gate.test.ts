import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { appTodayYmd } from "./calendar.ts";
import { insertUser, saveTrainingSnapshot } from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import { intervalsBasicAuthHeader } from "./intervals.ts";
import { handleTodayPost, type Plan, type RunLog, type Session } from "./training.ts";
import { upsertIntervalsConnection } from "./db.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-effort-gate-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  INTERVALS_ICU_API_KEY: process.env.INTERVALS_ICU_API_KEY,
  INTERVALS_OWNER_ENV_FALLBACK: process.env.INTERVALS_OWNER_ENV_FALLBACK,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
};
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 6).toString("base64");

const KEY_A = "effort-gate-key-user-a";
const ATHLETE_A = "i111111";
const ATHLETE_B = "i222222";

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  mock.restoreAll();
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.INTERVALS_ICU_API_KEY;
  delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
});

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(userId: string, source: "manual" | "intervals"): void {
  const today = appTodayYmd();
  const plan: Plan = {
    id: `${userId}-plan`,
    userId,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
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
    date: today,
    weekday: "fri",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
  };
  const log: RunLog = {
    id: `${userId}-log`,
    userId,
    sessionId: session.id,
    planId: plan.id,
    distanceKm: 8,
    timeSec: 2400,
    paceSecPerKm: 300,
    createdAt: "2026-09-01T00:00:00.000Z",
    source,
  };
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: [plan],
      sessions: [session],
      feedbacks: [],
      runLogs: [log],
      adaptationEvents: [],
    },
    "replace",
  );
}

describe("training effort gate", () => {
  it("loads Intervals effort only for an intervals RunLog and only with that user's athlete", async () => {
    delete process.env.ADAPT_LLM_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.INTERVALS_ICU_API_KEY;
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    const userId = "effort-user";
    insertUser({ id: userId, email: "effort-user@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    seed(userId, "intervals");
    upsertIntervalsConnection({
      userId,
      athleteId: ATHLETE_A,
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: encryptIntervalsApiKey(KEY_A, userId),
      needsReconnect: false,
    });

    const urls: string[] = [];
    const auths: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const form = new FormData();
    form.set("intent", "generate-feedback");
    const result = await handleTodayPost(userId, form);
    assert.equal(result.ok, false);
    assert.equal(urls.length > 0, true);
    assert.equal(urls.every((url) => url.includes(`/athlete/${ATHLETE_A}/`)), true);
    assert.equal(urls.some((url) => url.includes(ATHLETE_B)), false);
    assert.equal(auths.every((header) => header === intervalsBasicAuthHeader(KEY_A)), true);
    assert.equal(JSON.stringify(result).includes(KEY_A), false);
  });

  it("does not call Intervals for a manual RunLog or an intervals log without a connection", async () => {
    delete process.env.ADAPT_LLM_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    let fetches = 0;
    mock.method(globalThis, "fetch", async () => {
      fetches += 1;
      return new Response("[]", { status: 200 });
    });

    const manualId = "effort-manual";
    insertUser({ id: manualId, email: "effort-manual@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    seed(manualId, "manual");
    upsertIntervalsConnection({
      userId: manualId,
      athleteId: ATHLETE_B,
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: encryptIntervalsApiKey("effort-gate-key-user-b", manualId),
      needsReconnect: false,
    });
    const manualForm = new FormData();
    manualForm.set("intent", "generate-feedback");
    await handleTodayPost(manualId, manualForm);
    assert.equal(fetches, 0);

    const bareId = "effort-bare";
    insertUser({ id: bareId, email: "effort-bare@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    seed(bareId, "intervals");
    const bareForm = new FormData();
    bareForm.set("intent", "generate-feedback");
    await handleTodayPost(bareId, bareForm);
    assert.equal(fetches, 0);
  });
});
