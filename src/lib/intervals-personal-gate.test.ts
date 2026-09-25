import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { runNocturnalAdaptation } from "./adapt.ts";
import { appTodayYmd } from "./calendar.ts";
import {
  getUserById,
  insertUser,
  loadTrainingSnapshot,
  saveTrainingSnapshot,
  upsertIntervalsConnection,
} from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import { intervalsBasicAuthHeader } from "./intervals.ts";
import { handleSettingsPost, type Feedback, type Plan, type RunLog, type Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-personal-gate-"));
const SECRET = Buffer.alloc(32, 7).toString("base64");
const ENV_KEY = "shared-env-key-do-not-use";
const PERSONAL_KEY = "personal-key-do-not-leak";
const USER_ID = "unverified-outsider";
const EMAIL = "outsider@example.com";
const ATHLETE = "i333333";
const NOW = new Date("2026-09-24T17:00:00.000Z");

process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = SECRET;
process.env.INTERVALS_OWNER_EMAILS = "owner-only@example.com";
process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
process.env.INTERVALS_ICU_API_KEY = ENV_KEY;
process.env.INTERVALS_ICU_ATHLETE_ID = "i704884";
delete process.env.ADAPT_LLM_API_KEY;

const originalFetch = globalThis.fetch;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedUser(): void {
  if (getUserById(USER_ID)) return;
  insertUser({
    id: USER_ID,
    email: EMAIL,
    createdAt: "2026-09-01T00:00:00.000Z",
    emailVerifiedAt: null,
  });
}

function training(date: string): void {
  const plan: Plan = {
    id: `${USER_ID}-plan`,
    userId: USER_ID,
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
    id: `${USER_ID}-today`,
    planId: plan.id,
    userId: USER_ID,
    date,
    weekday: "thu",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
  };
  const tomorrow: Session = {
    id: `${USER_ID}-tomorrow`,
    planId: plan.id,
    userId: USER_ID,
    date: "2026-09-25",
    weekday: "fri",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 10 km",
    cue: "Keep it conversational",
    distanceKm: 10,
  };
  const feedback: Feedback = {
    id: `${USER_ID}-fb`,
    userId: USER_ID,
    planId: plan.id,
    sessionId: today.id,
    kind: "skip",
    createdAt: "2026-09-24T15:00:00.000Z",
  };
  const log: RunLog = {
    id: `${USER_ID}-log`,
    userId: USER_ID,
    sessionId: today.id,
    planId: plan.id,
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
      sessions: date === "2026-09-24" ? [today, tomorrow] : [today],
      feedbacks: date === "2026-09-24" ? [feedback] : [],
      runLogs: date === "2026-09-24" ? [log] : [],
      adaptationEvents: [],
    },
    "replace",
  );
}

describe("personal Intervals connection without the owner allowlist", () => {
  it("does not use the env key when an unverified outsider has no connection of their own", async () => {
    seedUser();
    upsertIntervalsConnection({
      userId: USER_ID,
      athleteId: ATHLETE,
      connectedAt: "2026-09-01T00:00:00.000Z",
    });
    training("2026-09-24");
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    });

    const sync = new FormData();
    sync.set("intent", "intervals-sync");
    const denied = await handleSettingsPost(USER_ID, sync);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 403);
    assert.equal(fetched, false);

    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const adapted = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });
    assert.equal(loadRunEffort.mock.calls.length, 0);
    assert.equal(upsertPlannedRuns.mock.calls.length, 0);
    assert.equal(adapted.uploaded, 0);
    assert.equal(JSON.stringify(adapted).includes(ENV_KEY), false);
  });

  it("syncs, picks, and adapts with that user's own key", async () => {
    seedUser();
    upsertIntervalsConnection({
      userId: USER_ID,
      athleteId: ATHLETE,
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: encryptIntervalsApiKey(PERSONAL_KEY, USER_ID),
      authType: "apikey",
      needsReconnect: false,
    });
    training("2026-09-24");
    const loadRunEffort = mock.fn(async () => null);
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));
    const adapted = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });
    assert.equal(loadRunEffort.mock.calls.length, 1);
    assert.equal(upsertPlannedRuns.mock.calls.length, 1);
    assert.equal(adapted.uploaded, 1);

    const today = appTodayYmd();
    training(today);
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push(headers.get("authorization") ?? "");
      const url = String(input);
      if (url.includes("/activities")) {
        return new Response(
          JSON.stringify([
            {
              id: "act-a",
              start_date_local: `${today}T07:00:00`,
              distance: 8000,
              moving_time: 2400,
              type: "Run",
            },
            {
              id: "act-b",
              start_date_local: `${today}T18:00:00`,
              distance: 5000,
              moving_time: 1500,
              type: "Run",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const sync = new FormData();
    sync.set("intent", "intervals-sync");
    const opened = await handleSettingsPost(USER_ID, sync);
    assert.equal(opened.ok, true);
    if (!opened.ok || !("picker" in opened)) {
      assert.fail("expected the Which run? picker");
    }
    assert.equal(calls.some((header) => header === intervalsBasicAuthHeader(PERSONAL_KEY)), true);
    assert.equal(calls.some((header) => header.includes(ENV_KEY)), false);
    assert.equal(calls.some((header) => header === intervalsBasicAuthHeader(ENV_KEY)), false);

    const pick = new FormData();
    pick.set("intent", "intervals-pick-run");
    pick.set("pickerDate", opened.picker.choice.date);
    pick.set("pickerSessionId", opened.picker.choice.sessionId);
    pick.set("pickerSessionDistanceKm", String(opened.picker.choice.sessionDistanceKm));
    pick.set("pickerRuns", JSON.stringify(opened.picker.choice.runs));
    pick.set("pickerRemaining", JSON.stringify(opened.picker.remaining));
    pick.set("skippedNoSession", "0");
    pick.set("imported", "0");
    pick.set("activityId", "act-a");
    const picked = await handleSettingsPost(USER_ID, pick);
    assert.equal(picked.ok, true);
    const logs = loadTrainingSnapshot().runLogs.filter((entry) => entry.userId === USER_ID);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.source, "intervals");
    assert.equal(JSON.stringify(logs).includes(PERSONAL_KEY), false);
    assert.equal(JSON.stringify(logs).includes(ENV_KEY), false);
  });
});
