import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it, mock } from "node:test";
import { transform } from "@astrojs/compiler-rs";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import { appTodayYmd } from "./calendar.ts";
import { getIntervalsConnection as getStoredConnection, insertUser, loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import { decryptIntervalsApiKey } from "./intervals-crypto.ts";
import {
  INTERVALS_CONNECT_INPUT,
  INTERVALS_CONNECT_REJECTED,
  INTERVALS_RECONNECT_ERROR,
  INTERVALS_USER_AGENT,
  connectIntervals,
  disconnectIntervals,
  getIntervalsConnection,
  getIntervalsConnectionView,
  intervalsBasicAuthHeader,
  upsertPlannedRuns,
} from "./intervals.ts";
import { adaptRunLogLine } from "./adapt-cron.ts";
import { runNocturnalAdaptation } from "./adapt.ts";
import { handleSettingsPost, type Feedback, type Plan, type RunLog, type Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-user-key-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  INTERVALS_ICU_API_KEY: process.env.INTERVALS_ICU_API_KEY,
  INTERVALS_ICU_ATHLETE_ID: process.env.INTERVALS_ICU_ATHLETE_ID,
  INTERVALS_OWNER_EMAILS: process.env.INTERVALS_OWNER_EMAILS,
  INTERVALS_OWNER_ENV_FALLBACK: process.env.INTERVALS_OWNER_ENV_FALLBACK,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
};

const SECRET = Buffer.alloc(32, 8).toString("base64");
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = SECRET;

const KEY_A = "user-a-intervals-key-do-not-leak";
const KEY_B = "user-b-intervals-key-do-not-leak";
const ENV_KEY = "owner-env-intervals-key-do-not-leak";
const ATHLETE_A = "i111111";
const ATHLETE_B = "i222222";
const ATHLETE_ENV = "i704884";

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  mock.restoreAll();
  process.env.AUTH_DATA_DIR = dataDir;
  process.env.INTERVALS_KEY_ENC_SECRET = SECRET;
  delete process.env.INTERVALS_ICU_API_KEY;
  delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
  delete process.env.INTERVALS_OWNER_EMAILS;
  delete process.env.ADAPT_LLM_API_KEY;
});

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

function dbContains(needle: string): boolean {
  return readdirSync(dataDir).some((name) => readFileSync(join(dataDir, name)).includes(Buffer.from(needle)));
}

function athleteResponse(id: string): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let connectedAppsRender: Promise<(props: Record<string, unknown>) => Promise<string>> | undefined;

/** Render the Settings Intervals card. tsx cannot import `.astro`, so compile it first. */
function renderConnectedApps(props: Record<string, unknown>): Promise<string> {
  connectedAppsRender ??= (async () => {
    const sourceUrl = new URL("../components/ConnectedApps.astro", import.meta.url);
    const compiled = transform(readFileSync(sourceUrl, "utf8"), {
      filename: "ConnectedApps.astro",
      resolvePath: (specifier) => specifier,
    });
    const errors = compiled.diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((item) => item.text).join("\n"));
    const code = compiled.code
      .replaceAll(
        'from "../lib/intervals"',
        `from ${JSON.stringify(new URL("./intervals.ts", import.meta.url).href)}`,
      )
      .replaceAll(
        'from "astro/runtime/server/index.js"',
        `from ${JSON.stringify(new URL("../../node_modules/astro/dist/runtime/server/index.js", import.meta.url).href)}`,
      );
    const file = join(dataDir, "ConnectedApps.compiled.mts");
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as { default: AstroComponentFactory };
    const { experimental_AstroContainer: AstroContainer } = await import("astro/container");
    const container = await AstroContainer.create();
    return (next: Record<string, unknown>) => container.renderToString(mod.default, { props: next });
  })();
  return connectedAppsRender.then((render) => render(props));
}

describe("per-user Intervals key", () => {
  it("validates with GET athlete, stores ciphertext, and round-trips", async () => {
    const userId = "connect-a";
    insertUser({ id: userId, email: "a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const calls: Array<{ url: string; authorization: string; userAgent: string; method: string }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization") ?? "",
        userAgent: headers.get("user-agent") ?? "",
        method: init?.method ?? "GET",
      });
      return athleteResponse(ATHLETE_A);
    });

    const result = await connectIntervals(userId, { apiKey: KEY_A, athleteId: "I111111" });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url.endsWith(`/athlete/${ATHLETE_A}`), true);
    assert.equal(calls[0]?.authorization, intervalsBasicAuthHeader(KEY_A));
    assert.equal(calls[0]?.userAgent, INTERVALS_USER_AGENT);

    const stored = getStoredConnection(userId);
    assert.ok(stored?.apiKeyEnc);
    assert.notEqual(stored?.apiKeyEnc, KEY_A);
    assert.equal(stored?.apiKeyEnc.includes(KEY_A), false);
    assert.equal(decryptIntervalsApiKey(stored?.apiKeyEnc ?? ""), KEY_A);
    assert.equal(stored?.athleteId, ATHLETE_A);
    assert.equal(dbContains(KEY_A), false);

    const view = getIntervalsConnectionView(userId);
    const publicRow = getIntervalsConnection(userId);
    assert.equal(JSON.stringify(view).includes(KEY_A), false);
    assert.equal(JSON.stringify(publicRow).includes(KEY_A), false);
    assert.equal(JSON.stringify(view).includes(stored?.apiKeyEnc ?? "missing"), false);
  });

  it("rejects a bad key without saving and without a 500", async () => {
    const userId = "connect-bad";
    insertUser({ id: userId, email: "bad@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => new Response("nope", { status: 401 }));
    const result = await connectIntervals(userId, { apiKey: KEY_A, athleteId: ATHLETE_A });
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_REJECTED });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.includes(KEY_A), false);
    assert.equal(getStoredConnection(userId), null);

    const form = new FormData();
    form.set("intent", "intervals-connect");
    form.set("intervalsApiKey", KEY_A);
    form.set("intervalsAthleteId", ATHLETE_A);
    const posted = await handleSettingsPost(userId, form);
    assert.equal(JSON.stringify(posted).includes(KEY_A), false);
    assert.equal(getStoredConnection(userId), null);
  });

  it("does not put the key in the settings connection view", async () => {
    const userId = "html-user";
    insertUser({ id: userId, email: "html@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_A));
    await connectIntervals(userId, { apiKey: KEY_A, athleteId: ATHLETE_A });
    const stored = getStoredConnection(userId);
    const view = getIntervalsConnectionView(userId);
    const connectedHtml = await renderConnectedApps({
      connection: view,
      error: "",
      intervalsAvailable: true,
      athleteIdDraft: ATHLETE_A,
    });
    assert.equal(connectedHtml.includes(KEY_A), false);
    assert.equal(connectedHtml.includes(stored?.apiKeyEnc ?? KEY_A), false);

    const formHtml = await renderConnectedApps({
      connection: { ...view, needsReconnect: true },
      error: "",
      intervalsAvailable: true,
      athleteIdDraft: ATHLETE_A,
    });
    assert.equal(formHtml.includes(KEY_A), false);
    assert.equal(formHtml.includes(stored?.apiKeyEnc ?? KEY_A), false);
    assert.equal(formHtml.includes('type="password"'), true);
    assert.equal(formHtml.includes('name="intervalsApiKey"'), true);
    assert.equal(/name="intervalsApiKey"[^>]*value=/.test(formHtml), false);
    assert.equal(formHtml.includes(`value="${ATHLETE_A}"`), true);
  });

  it("sync, pick, and adapt use only that user's key and athlete", async () => {
    delete process.env.INTERVALS_ICU_API_KEY;
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    delete process.env.ADAPT_LLM_API_KEY;
    const userA = "iso-a";
    const userB = "iso-b";
    insertUser({ id: userA, email: "iso-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "iso-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_A));
    await connectIntervals(userA, { apiKey: KEY_A, athleteId: ATHLETE_A });
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_B));
    await connectIntervals(userB, { apiKey: KEY_B, athleteId: ATHLETE_B });
    mock.restoreAll();

    const calls: Array<{ url: string; authorization: string }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get("authorization") ?? "" });
      if (url.includes("/activities")) {
        const athlete = url.includes(ATHLETE_A) ? ATHLETE_A : ATHLETE_B;
        const id = athlete === ATHLETE_A ? "act-a" : "act-b";
        return new Response(
          JSON.stringify([
            {
              id,
              start_date_local: "2026-09-14T07:15:00",
              distance: 8000,
              moving_time: 2400,
              type: "Run",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const day = "2026-09-14";
    function planFor(userId: string): { plan: Plan; session: Session } {
      const plan: Plan = {
        id: `${userId}-plan`,
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
        id: `${userId}-session`,
        planId: plan.id,
        userId,
        date: day,
        weekday: "mon",
        weekIndex: 0,
        kind: "easy",
        title: "Easy run · 8 km",
        cue: "Keep it conversational",
        distanceKm: 8,
      };
      return { plan, session };
    }
    const a = planFor(userA);
    const b = planFor(userB);
    saveTrainingSnapshot(
      { onboarding: [], plans: [a.plan, b.plan], sessions: [a.session, b.session], feedbacks: [], runLogs: [], adaptationEvents: [] },
      "replace",
    );

    const syncA = new FormData();
    syncA.set("intent", "intervals-sync");
    await handleSettingsPost(userA, syncA);
    const syncB = new FormData();
    syncB.set("intent", "intervals-sync");
    await handleSettingsPost(userB, syncB);

    const logs = loadTrainingSnapshot().runLogs;
    assert.equal(logs.find((entry) => entry.userId === userA)?.distanceKm, 8);
    assert.equal(logs.find((entry) => entry.userId === userB)?.distanceKm, 8);
    assert.equal(logs.filter((entry) => entry.userId === userA).every((entry) => entry.id !== "act-b"), true);
    const aCalls = calls.filter((call) => call.authorization === intervalsBasicAuthHeader(KEY_A));
    const bCalls = calls.filter((call) => call.authorization === intervalsBasicAuthHeader(KEY_B));
    assert.equal(aCalls.length > 0, true);
    assert.equal(bCalls.length > 0, true);
    assert.equal(aCalls.every((call) => call.url.includes(`/athlete/${ATHLETE_A}/`) || call.url.includes("/activity/act-a/")), true);
    assert.equal(bCalls.every((call) => call.url.includes(`/athlete/${ATHLETE_B}/`) || call.url.includes("/activity/act-b/")), true);
    assert.equal(calls.some((call) => call.authorization === intervalsBasicAuthHeader(ENV_KEY)), false);
    assert.equal(JSON.stringify(logs).includes(KEY_A), false);
    assert.equal(JSON.stringify(logs).includes(KEY_B), false);
  });

  it("skips a user without a connection in adapt and logs only the count", async () => {
    delete process.env.ADAPT_LLM_API_KEY;
    delete process.env.INTERVALS_ICU_API_KEY;
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    process.env.INTERVALS_ICU_API_KEY = ENV_KEY;
    const connected = "adapt-connected";
    const absent = "adapt-absent";
    insertUser({ id: connected, email: "adapt-connected@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: absent, email: "adapt-absent@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_A));
    await connectIntervals(connected, { apiKey: KEY_A, athleteId: ATHLETE_A });
    mock.restoreAll();

    const now = new Date("2026-09-24T17:00:00.000Z");
    function install(userId: string) {
      const plan: Plan = {
        id: `${userId}-plan`,
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
        planId: plan.id,
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
        planId: plan.id,
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
        planId: plan.id,
        sessionId: today.id,
        kind: "skip",
        createdAt: "2026-09-24T15:00:00.000Z",
      };
      const log: RunLog = {
        id: `${userId}-log`,
        userId,
        sessionId: today.id,
        planId: plan.id,
        distanceKm: 8,
        timeSec: 2400,
        paceSecPerKm: 300,
        createdAt: "2026-09-24T15:00:00.000Z",
        source: "intervals",
      };
      return { plan, today, tomorrow, feedback, log };
    }
    const left = install(connected);
    const right = install(absent);
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [left.plan, right.plan],
        sessions: [left.today, left.tomorrow, right.today, right.tomorrow],
        feedbacks: [left.feedback, right.feedback],
        runLogs: [left.log, right.log],
        adaptationEvents: [],
      },
      "replace",
    );

    const calls: Array<{ url: string; authorization: string }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? "" });
      if (String(input).includes("/activities")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    });

    const result = await runNocturnalAdaptation(now);
    const line = adaptRunLogLine(result);
    assert.equal(result.noConnection, 1);
    assert.match(line, /noConnection=1/);
    assert.equal(line.includes(absent), false);
    assert.equal(line.includes(connected), false);
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((call) => call.authorization === intervalsBasicAuthHeader(KEY_A)), true);
    assert.equal(calls.some((call) => call.url.includes(ATHLETE_B) || call.authorization === intervalsBasicAuthHeader(ENV_KEY)), false);
    assert.equal(
      loadTrainingSnapshot().sessions.find((session) => session.id === `${absent}-tomorrow`)?.distanceKm,
      8,
    );
  });

  it("uses the env key only for an allowlisted owner when the flag is on", async () => {
    const owner = "fallback-owner";
    const other = "fallback-other";
    insertUser({
      id: owner,
      email: "Owner@Example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
      emailVerifiedAt: "2026-09-01T00:00:00.000Z",
    });
    insertUser({ id: other, email: "other@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    process.env.INTERVALS_ICU_API_KEY = ENV_KEY;
    process.env.INTERVALS_ICU_ATHLETE_ID = ATHLETE_ENV;
    process.env.INTERVALS_OWNER_EMAILS = "owner@example.com";
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;

    let fetches = 0;
    mock.method(globalThis, "fetch", async () => {
      fetches += 1;
      return athleteResponse(ATHLETE_ENV);
    });
    const blocked = await connectIntervals(owner);
    assert.deepEqual(blocked, { ok: false, error: INTERVALS_CONNECT_INPUT });
    assert.equal(fetches, 0);

    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    const denied = await connectIntervals(other);
    assert.deepEqual(denied, { ok: false, error: INTERVALS_CONNECT_INPUT });
    assert.equal(fetches, 0);

    const allowed = await connectIntervals(owner);
    assert.deepEqual(allowed, { ok: true });
    assert.equal(fetches, 1);
    const stored = getStoredConnection(owner);
    assert.equal(stored?.apiKeyEnc, undefined);
    assert.equal(stored?.athleteId, ATHLETE_ENV);
    assert.equal(dbContains(ENV_KEY), false);

    const auths: string[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("[]", { status: 200 });
    });
    const form = new FormData();
    form.set("intent", "intervals-sync");
    await handleSettingsPost(owner, form);
    assert.equal(auths.some((header) => header === intervalsBasicAuthHeader(ENV_KEY)), true);

    process.env.INTERVALS_OWNER_ENV_FALLBACK = "false";
    auths.length = 0;
    await handleSettingsPost(other, form);
    assert.equal(auths.length, 0);
  });

  it("disconnect clears the stored key and a revoked key asks to reconnect", async () => {
    const userId = "disconnect-user";
    insertUser({ id: userId, email: "disconnect@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_A));
    await connectIntervals(userId, { apiKey: KEY_A, athleteId: ATHLETE_A });
    assert.ok(getStoredConnection(userId)?.apiKeyEnc);
    await disconnectIntervals(userId);
    assert.equal(getStoredConnection(userId), null);
    assert.equal(dbContains(KEY_A), false);

    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => athleteResponse(ATHLETE_A));
    await connectIntervals(userId, { apiKey: KEY_A, athleteId: ATHLETE_A });
    mock.restoreAll();
    let fetches = 0;
    mock.method(globalThis, "fetch", async () => {
      fetches += 1;
      return new Response("revoked", { status: 401 });
    });
    const form = new FormData();
    form.set("intent", "intervals-sync");
    const today = appTodayYmd();
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [],
        sessions: [],
        feedbacks: [],
        runLogs: [],
        adaptationEvents: [],
      },
      "replace",
    );
    const result = await handleSettingsPost(userId, form);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, INTERVALS_RECONNECT_ERROR);
    assert.equal(result.error.includes(KEY_A), false);
    assert.equal(getStoredConnection(userId)?.needsReconnect, true);
    const again = await handleSettingsPost(userId, form);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error, INTERVALS_RECONNECT_ERROR);
    assert.equal(fetches, 1);
    assert.equal(JSON.stringify(result).includes(KEY_A), false);
    void today;
  });

  it("upserts planned runs with the caller-supplied athlete, not the env key", async () => {
    process.env.INTERVALS_ICU_API_KEY = ENV_KEY;
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? "" });
      return new Response("[]", { status: 200 });
    };
    await upsertPlannedRuns(
      [
        {
          externalId: "session-1",
          date: "2026-09-25",
          name: "Easy run · 8 km",
          description: "Keep it conversational",
          distanceKm: 8,
        },
      ],
      { apiKey: KEY_A, athletePathId: ATHLETE_A, fetchImpl },
    );
    assert.equal(calls[0]?.url.includes(`/athlete/${ATHLETE_A}/events/bulk`), true);
    assert.equal(calls[0]?.authorization, intervalsBasicAuthHeader(KEY_A));
    assert.notEqual(calls[0]?.authorization, intervalsBasicAuthHeader(ENV_KEY));
  });
});
