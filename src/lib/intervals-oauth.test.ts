import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it, mock } from "node:test";
import { transform } from "@astrojs/compiler-rs";
import type { AstroCookies } from "astro";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import type { Feedback, Plan, RunLog, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-oauth-"));
const SECRET = Buffer.alloc(32, 8).toString("base64");
const OTHER_SECRET = Buffer.alloc(32, 3).toString("base64");
const CLIENT_ID = "stride-lab-client";
const CLIENT_SECRET = "intervals-client-secret-do-not-leak";
const TOKEN_A = "oauth-token-user-a-do-not-leak";
const TOKEN_B = "oauth-token-user-b-do-not-leak";
const KEY_B = "user-b-intervals-key-do-not-leak";
const ATHLETE_A = "i2049151";
const ATHLETE_B = "i222222";
const NAME_A = "Ada Runner";

process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-0123456789";
process.env.AUTH_COOKIE_SECURE = "true";
process.env.INTERVALS_KEY_ENC_SECRET = SECRET;
process.env.INTERVALS_CLIENT_ID = CLIENT_ID;
process.env.INTERVALS_CLIENT_SECRET = CLIENT_SECRET;
delete process.env.INTERVALS_ICU_API_KEY;
delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
delete process.env.INTERVALS_OWNER_EMAILS;
delete process.env.ADAPT_LLM_API_KEY;

const { getIntervalsConnection: getStoredConnection, insertUser, saveTrainingSnapshot, upsertIntervalsConnection } =
  await import("./db.ts");
const {
  decryptIntervalsApiKey,
  encryptIntervalsApiKey,
  IntervalsDecryptError,
  intervalsEncryptionKey,
  intervalsEncryptionReady,
} = await import("./intervals-crypto.ts");
const {
  INTERVALS_ACCESS_EXPIRED,
  INTERVALS_ATHLETE_ID_INVALID,
  INTERVALS_ATHLETE_ID_PLACEHOLDER,
  INTERVALS_CONNECT_REJECTED,
  INTERVALS_CONNECT_UNAVAILABLE,
  INTERVALS_RECONNECT_LINK_LABEL,
  INTERVALS_RECONNECT_NOTICE,
  INTERVALS_UNAVAILABLE_HELPER_ID,
  INTERVALS_CONNECTED_TOAST,
  INTERVALS_CSRF_ERROR,
  INTERVALS_OAUTH_CALENDAR_SCOPE,
  INTERVALS_SYNC_NEEDS_CONNECT,
  INTERVALS_OAUTH_CONNECT_BUTTON,
  INTERVALS_OAUTH_CONNECT_ERROR,
  INTERVALS_OAUTH_CONNECT_LINE,
  INTERVALS_RECONNECT_ERROR,
  connectIntervals,
  denyIntervalsPostCsrf,
  intervalsCsrfDeniedResponse,
  disconnectIntervals,
  getIntervalsConnectionView,
  intervalsOAuthSettingsError,
  intervalsAuthorizationHeader,
  intervalsBasicAuthHeader,
  loadIntervalsRoute,
  loadIntervalsRunsForSync,
  openIntervalsCredentials,
  refreshIntervalsConnectionView,
  upsertPlannedRuns,
} = await import("./intervals.ts");
const {
  INTERVALS_AUTHORIZE_URL,
  INTERVALS_OAUTH_SCOPE,
  INTERVALS_OAUTH_STATE_TTL_SEC,
  INTERVALS_TOKEN_URL,
  finishIntervalsOAuth,
  intervalsOAuthCallbackUrl,
  isIntervalsOAuthConfigured,
  startIntervalsOAuth,
} = await import("./intervals-oauth.ts");
const { astroBuild, isProductionRuntime } = await import("./public-origin.ts");
const { setSessionCookie } = await import("./auth.ts");
const { GET: startRoute } = await import("../pages/auth/intervals/start.ts");
const { GET: callbackRoute } = await import("../pages/auth/intervals/callback.ts");
const { runNocturnalAdaptation } = await import("./adapt.ts");
const { adaptRunLogLine } = await import("./adapt-cron.ts");

const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;

type CookieCall = { name: string; value: string; options?: { httpOnly?: boolean; sameSite?: string; secure?: boolean; maxAge?: number; path?: string } };

function cookieJar(): { cookies: AstroCookies; calls: CookieCall[] } {
  const values = new Map<string, string>();
  const calls: CookieCall[] = [];
  const cookies = {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    set(name: string, value: string, options?: CookieCall["options"]) {
      values.set(name, value);
      calls.push({ name, value, options });
    },
    delete(name: string) {
      values.delete(name);
    },
  };
  return { cookies: cookies as unknown as AstroCookies, calls };
}

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

function dbContains(needle: string): boolean {
  return readdirSync(dataDir).some((name) => {
    if (!name.endsWith(".db") && !name.includes("app.db")) return false;
    return readFileSync(join(dataDir, name)).includes(Buffer.from(needle));
  });
}

function logText(logged: unknown[][]): string {
  return JSON.stringify(logged, (_key, value) => (value instanceof Error ? value.message : value));
}

function prodRequest(path: string): Request {
  return new Request(`http://127.0.0.1:4321${path}`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "running-stats-production.up.railway.app",
    },
  });
}

function tokenResponse(token: string, athleteId: string, name?: string): Response {
  return new Response(
    JSON.stringify({
      token_type: "Bearer",
      access_token: token,
      scope: INTERVALS_OAUTH_SCOPE,
      athlete: { id: athleteId, name },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function connectOAuth(userId: string, token: string, athleteId: string, name?: string): Promise<void> {
  const jar = cookieJar();
  const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
  const state = new URL(started.location).searchParams.get("state");
  mock.method(globalThis, "fetch", async () => tokenResponse(token, athleteId, name));
  const result = await finishIntervalsOAuth(
    prodRequest(`/auth/intervals/callback?code=valid-code&state=${state}`),
    jar.cookies,
    userId,
  );
  assert.equal(result.kind, "connected");
  mock.restoreAll();
}

function planBundle(userId: string): { plan: Plan; today: Session; tomorrow: Session; feedback: Feedback; log: RunLog } {
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

let connectedAppsRender: Promise<(props: Record<string, unknown>) => Promise<string>> | undefined;
let noticeRender: Promise<(props: Record<string, unknown>) => Promise<string>> | undefined;

function renderAstro(filename: string, rewriteIntervals: boolean): Promise<(props: Record<string, unknown>) => Promise<string>> {
  return (async () => {
    const sourceUrl = new URL(`../components/${filename}`, import.meta.url);
    const compiled = transform(readFileSync(sourceUrl, "utf8"), {
      filename,
      resolvePath: (specifier) => specifier,
    });
    const errors = compiled.diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((item) => item.text).join("\n"));
    let code = compiled.code;
    if (rewriteIntervals) {
      code = code.replaceAll(
        'from "../lib/intervals"',
        `from ${JSON.stringify(new URL("./intervals.ts", import.meta.url).href)}`,
      );
    }
    code = code.replaceAll(
      'from "astro/runtime/server/index.js"',
      `from ${JSON.stringify(new URL("../../node_modules/astro/dist/runtime/server/index.js", import.meta.url).href)}`,
    );
    const file = join(dataDir, `${filename}.compiled.mts`);
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as { default: AstroComponentFactory };
    const { experimental_AstroContainer: AstroContainer } = await import("astro/container");
    const container = await AstroContainer.create();
    return (props: Record<string, unknown>) => container.renderToString(mod.default, { props });
  })();
}

function renderConnectedApps(props: Record<string, unknown>): Promise<string> {
  connectedAppsRender ??= renderAstro("ConnectedApps.astro", true);
  return connectedAppsRender.then((render) => render(props));
}

function renderNotice(props: Record<string, unknown>): Promise<string> {
  noticeRender ??= renderAstro("IntervalsExpiredNotice.astro", true);
  return noticeRender.then((render) => render(props));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  process.env.AUTH_DATA_DIR = dataDir;
  process.env.INTERVALS_KEY_ENC_SECRET = SECRET;
  process.env.INTERVALS_CLIENT_ID = CLIENT_ID;
  process.env.INTERVALS_CLIENT_SECRET = CLIENT_SECRET;
  process.env.AUTH_COOKIE_SECURE = "true";
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.INTERVALS_ICU_API_KEY;
  delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
  delete process.env.PUBLIC_ORIGIN;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Intervals OAuth", () => {
  it("rejects a missing or mismatched state and does not call Intervals", async () => {
    const userId = "oauth-state";
    insertUser({ id: userId, email: "state@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    let fetches = 0;
    mock.method(globalThis, "fetch", async () => {
      fetches += 1;
      return tokenResponse(TOKEN_A, ATHLETE_A, NAME_A);
    });

    const missing = await finishIntervalsOAuth(
      prodRequest("/auth/intervals/callback?code=abc"),
      cookieJar().cookies,
      userId,
    );
    assert.equal(missing.kind, "csrf");

    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const mismatch = await finishIntervalsOAuth(
      prodRequest("/auth/intervals/callback?code=abc&state=not-the-state"),
      jar.cookies,
      userId,
    );
    assert.equal(mismatch.kind, "csrf");
    assert.equal(fetches, 0);
    assert.equal(getStoredConnection(userId), null);
    assert.equal(started.location.includes(CLIENT_SECRET), false);

    const jarB = cookieJar();
    const startedB = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jarB.cookies, userId);
    const state = new URL(startedB.location).searchParams.get("state") ?? "";
    const otherUser = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=abc&state=${state}`),
      jarB.cookies,
      "someone-else",
    );
    assert.equal(otherUser.kind, "csrf");
    assert.equal(fetches, 0);
  });

  it("returns from a cancelled consent without an error", async () => {
    const userId = "oauth-cancel";
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state");
    let fetches = 0;
    mock.method(globalThis, "fetch", async () => {
      fetches += 1;
      return tokenResponse(TOKEN_A, ATHLETE_A, NAME_A);
    });
    const cancelled = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?error=access_denied&state=${state}`),
      jar.cookies,
      userId,
    );
    assert.deepEqual(cancelled, { kind: "cancelled" });
    assert.equal(fetches, 0);
    assert.equal(getStoredConnection(userId), null);

    const silent = await finishIntervalsOAuth(
      prodRequest("/auth/intervals/callback?error=access_denied"),
      cookieJar().cookies,
      userId,
    );
    assert.equal(silent.kind, "cancelled");
  });

  it("shows a friendly error for an invalid code and never the Intervals body", async () => {
    const userId = "oauth-bad-code";
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state");
    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });
    mock.method(globalThis, "fetch", async () => new Response(`invalid_grant ${CLIENT_SECRET} ${TOKEN_A}`, { status: 400 }));
    const result = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=expired-code&state=${state}`),
      jar.cookies,
      userId,
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.message, INTERVALS_OAUTH_CONNECT_ERROR);
      assert.equal(result.message.includes(CLIENT_SECRET), false);
      assert.equal(result.message.includes("invalid_grant"), false);
      assert.equal(result.message.includes("expired-code"), false);
    }
    assert.equal(getStoredConnection(userId), null);
    const dumped = logText(logged);
    assert.equal(dumped.includes(CLIENT_SECRET), false);
    assert.equal(dumped.includes("invalid_grant"), false);
    assert.equal(dumped.includes(TOKEN_A), false);
  });

  it("stores an encrypted token with athlete id and name from the token response", async () => {
    const userId = "oauth-store";
    insertUser({ id: userId, email: "store@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const authorize = new URL(started.location);
    assert.equal(authorize.origin + authorize.pathname, INTERVALS_AUTHORIZE_URL);
    assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(
      authorize.searchParams.get("redirect_uri"),
      "https://running-stats-production.up.railway.app/auth/intervals/callback",
    );
    assert.equal(authorize.searchParams.get("scope"), "ACTIVITY:READ,CALENDAR:WRITE");
    assert.equal(authorize.searchParams.get("scope"), INTERVALS_OAUTH_SCOPE);
    assert.equal(authorize.searchParams.has("response_type"), false);
    assert.equal(started.location.includes(CLIENT_SECRET), false);
    const cookie = jar.calls[0];
    assert.equal(cookie?.options?.httpOnly, true);
    assert.equal(cookie?.options?.sameSite, "lax");
    assert.equal(cookie?.options?.secure, true);
    assert.equal(cookie?.options?.maxAge, INTERVALS_OAUTH_STATE_TTL_SEC);
    assert.equal(cookie?.options?.maxAge, 600);

    const state = authorize.searchParams.get("state");
    let tokenBody = "";
    let tokenUrl = "";
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      tokenUrl = String(input);
      tokenBody = String(init?.body ?? "");
      return tokenResponse(TOKEN_A, ATHLETE_A, NAME_A);
    });
    const result = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=good-code&state=${state}`),
      jar.cookies,
      userId,
    );
    assert.equal(result.kind, "connected");
    assert.equal(tokenUrl, INTERVALS_TOKEN_URL);
    const params = new URLSearchParams(tokenBody);
    assert.equal(params.get("client_id"), CLIENT_ID);
    assert.equal(params.get("client_secret"), CLIENT_SECRET);
    assert.equal(params.get("code"), "good-code");
    assert.equal(params.has("redirect_uri"), false);
    assert.equal(params.has("grant_type"), false);

    const stored = getStoredConnection(userId);
    assert.equal(stored?.authType, "oauth");
    assert.equal(stored?.athleteId, ATHLETE_A);
    assert.equal(stored?.athleteName, NAME_A);
    assert.equal(stored?.scope, INTERVALS_OAUTH_SCOPE);
    assert.ok(stored?.apiKeyEnc);
    assert.notEqual(stored?.apiKeyEnc, TOKEN_A);
    assert.equal(stored?.apiKeyEnc.includes(TOKEN_A), false);
    assert.equal(decryptIntervalsApiKey(stored?.apiKeyEnc ?? "", userId), TOKEN_A);
    assert.equal(dbContains(TOKEN_A), false);
    assert.equal(dbContains(CLIENT_SECRET), false);

    const again = encryptIntervalsApiKey(TOKEN_A, userId);
    assert.equal(again.startsWith("v2:"), true);
    assert.notEqual(again.split(":")[1], stored?.apiKeyEnc.split(":")[1]);
    const tampered = stored?.apiKeyEnc.split(":") ?? [];
    tampered[2] = Buffer.alloc(16, 9).toString("base64");
    assert.throws(() => decryptIntervalsApiKey(tampered.join(":"), userId), IntervalsDecryptError);

    const view = getIntervalsConnectionView(userId);
    assert.equal(view.connected && view.statusLabel, `Connected as ${NAME_A}`);
    assert.equal(JSON.stringify(view).includes(TOKEN_A), false);
    assert.equal(JSON.stringify(view).includes(stored?.apiKeyEnc ?? TOKEN_A), false);
  });

  it("uses Bearer for oauth and Basic for an API key, and does not cross athletes", async () => {
    const userA = "oauth-iso-a";
    const userB = "oauth-iso-b";
    insertUser({ id: userA, email: "iso-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "iso-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userA, TOKEN_A, ATHLETE_A, NAME_A);
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ id: ATHLETE_B }), { status: 200 }));
    const connectedB = await connectIntervals(userB, { apiKey: KEY_B, athleteId: ATHLETE_B });
    assert.equal(connectedB.ok, true);
    mock.restoreAll();

    assert.equal(intervalsAuthorizationHeader("oauth", TOKEN_A), `Bearer ${TOKEN_A}`);
    assert.equal(intervalsAuthorizationHeader("apikey", KEY_B), intervalsBasicAuthHeader(KEY_B));
    assert.notEqual(intervalsAuthorizationHeader("oauth", TOKEN_A), intervalsBasicAuthHeader(TOKEN_A));

    const calls: Array<{ url: string; authorization: string }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get("authorization") ?? "" });
      if (url.includes("/activities")) {
        return new Response(
          JSON.stringify([
            {
              id: url.includes(ATHLETE_A) ? "act-a" : "act-b",
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

    await loadIntervalsRunsForSync(userA, "2026-09-14", "2026-09-14");
    await loadIntervalsRunsForSync(userB, "2026-09-14", "2026-09-14");
    await loadIntervalsRoute(userA, "act-a");
    await loadIntervalsRoute(userB, "act-b");
    const credsA = await openIntervalsCredentials(userA);
    const credsB = await openIntervalsCredentials(userB);
    assert.equal(credsA.ok && credsA.authType, "oauth");
    assert.equal(credsB.ok && credsB.authType, "apikey");
    if (credsA.ok) {
      await upsertPlannedRuns(
        [{ externalId: "sess-a", date: "2026-09-25", name: "Easy", description: "Easy", distanceKm: 8 }],
        { apiKey: credsA.apiKey, authType: credsA.authType, athletePathId: credsA.athleteId },
      );
    }
    if (credsB.ok) {
      await upsertPlannedRuns(
        [{ externalId: "sess-b", date: "2026-09-25", name: "Easy", description: "Easy", distanceKm: 8 }],
        { apiKey: credsB.apiKey, authType: credsB.authType, athletePathId: credsB.athleteId },
      );
    }

    const bearer = `Bearer ${TOKEN_A}`;
    const basic = intervalsBasicAuthHeader(KEY_B);
    const aCalls = calls.filter((call) => call.authorization === bearer);
    const bCalls = calls.filter((call) => call.authorization === basic);
    assert.equal(aCalls.length > 0, true);
    assert.equal(bCalls.length > 0, true);
    assert.equal(
      aCalls.every((call) => call.url.includes(`/athlete/${ATHLETE_A}/`) || call.url.includes("/activity/act-a/")),
      true,
    );
    assert.equal(
      bCalls.every((call) => call.url.includes(`/athlete/${ATHLETE_B}/`) || call.url.includes("/activity/act-b/")),
      true,
    );
    assert.equal(calls.some((call) => call.authorization === bearer && call.url.includes(ATHLETE_B)), false);
    assert.equal(calls.some((call) => call.authorization === basic && call.url.includes(ATHLETE_A)), false);
    assert.equal(calls.some((call) => call.authorization === `Bearer ${TOKEN_B}`), false);
    assert.equal(JSON.stringify(calls).includes(CLIENT_SECRET), false);
  });

  it("disables connect when the encryption secret is missing and does not throw or store plaintext", async () => {
    const userId = "oauth-no-secret";
    insertUser({ id: userId, email: "nosecret@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userId, TOKEN_A, ATHLETE_A, NAME_A);
    const before = getStoredConnection(userId)?.apiKeyEnc;
    delete process.env.INTERVALS_KEY_ENC_SECRET;
    assert.doesNotThrow(() => intervalsEncryptionReady());
    assert.equal(intervalsEncryptionReady(), false);
    assert.doesNotThrow(() => startIntervalsOAuth(prodRequest("/auth/intervals/start"), cookieJar().cookies, userId));
    assert.equal(startIntervalsOAuth(prodRequest("/auth/intervals/start"), cookieJar().cookies, userId).location, "/settings");
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return tokenResponse(TOKEN_B, ATHLETE_A, NAME_A);
    });
    const posted = await connectIntervals(userId, { apiKey: KEY_B, athleteId: ATHLETE_B });
    assert.equal(posted.ok, false);
    assert.equal(fetchCalled, false);
    const view = await refreshIntervalsConnectionView(userId);
    assert.equal(view.connected, true);
    assert.equal(view.needsReconnect === true, false);
    assert.equal(getStoredConnection(userId)?.apiKeyEnc, before);
    assert.equal(dbContains(KEY_B), false);

    const html = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: true,
      encryptionReady: false,
    });
    assert.equal(html.includes(INTERVALS_OAUTH_CONNECT_BUTTON), true);
    assert.equal(html.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(html.includes("Connecting Intervals.icu isn’t available right now. Try again later."), true);
    assert.match(html, /disabled/);
    const hidden = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      oauthConfigured: true,
      encryptionReady: false,
    });
    assert.equal(hidden.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(hidden.includes("Not available for your account"), false);
    assert.match(hidden, /disabled/);
    const keyDisabled = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: false,
    });
    assert.equal(keyDisabled.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(keyDisabled.includes('name="intervalsApiKey"'), false);
    assert.equal(keyDisabled.includes("Not available for your account"), false);
    assert.equal(keyDisabled.includes("Connect Intervals.icu"), true);
    assert.match(keyDisabled, /<button[^>]*disabled[^>]*>[\s\S]*Connect Intervals\.icu[\s\S]*<\/button>/);
    assert.equal(html.includes(CLIENT_SECRET), false);
    assert.equal(html.includes(TOKEN_A), false);
  });

  it("marks a decrypt failure for reconnect and keeps adapting the other account", async () => {
    const userA = "oauth-decrypt-a";
    const userB = "oauth-decrypt-b";
    insertUser({ id: userA, email: "decrypt-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "decrypt-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userA, TOKEN_A, ATHLETE_A, NAME_A);
    process.env.INTERVALS_KEY_ENC_SECRET = OTHER_SECRET;
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ id: ATHLETE_B }), { status: 200 }));
    assert.equal((await connectIntervals(userB, { apiKey: KEY_B, athleteId: ATHLETE_B })).ok, true);
    mock.restoreAll();

    const left = planBundle(userA);
    const right = planBundle(userB);
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
      if (headers.get("authorization") === intervalsBasicAuthHeader(KEY_B)) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(`revoked ${TOKEN_A}`, { status: 401 });
    });
    const logged: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });

    const result = await runNocturnalAdaptation(new Date("2026-09-24T17:00:00.000Z"));
    assert.equal(INTERVALS_RECONNECT_ERROR, "Intervals access expired");
    assert.equal(result.reconnect, 1);
    assert.match(adaptRunLogLine(result), /reconnect=1/);
    assert.equal(getStoredConnection(userA)?.needsReconnect, true);
    assert.equal(getStoredConnection(userB)?.needsReconnect === true, false);
    assert.equal(calls.some((call) => call.authorization === intervalsBasicAuthHeader(KEY_B)), true);
    assert.equal(calls.some((call) => call.authorization === `Bearer ${TOKEN_A}`), false);
    assert.equal(result.processed >= 1, true);
    const dumped = logText(logged);
    assert.equal(dumped.includes(TOKEN_A), false);
    assert.equal(dumped.includes(KEY_B), false);
    assert.equal(dumped.includes(OTHER_SECRET), false);
    assert.equal(dumped.includes(SECRET), false);
    assert.equal(dumped.includes("aes-256-gcm"), false);
    assert.equal(dumped.includes("auth tag"), false);
    assert.match(dumped, /stored connection could not be read/);

    const expired = await refreshIntervalsConnectionView(userA);
    assert.equal(expired.connected && expired.statusLabel, INTERVALS_ACCESS_EXPIRED);
  });

  it("marks a revoked token and still uploads the other account", async () => {
    const userA = "oauth-revoked-a";
    const userB = "oauth-revoked-b";
    insertUser({ id: userA, email: "revoked-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "revoked-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userA, TOKEN_A, ATHLETE_A, NAME_A);
    await connectOAuth(userB, TOKEN_B, "3091002", "Bea Runner");
    const left = planBundle(userA);
    const right = planBundle(userB);
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
      const authorization = headers.get("authorization") ?? "";
      calls.push({ url: String(input), authorization });
      if (authorization === `Bearer ${TOKEN_A}`) return new Response("revoked token", { status: 401 });
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await runNocturnalAdaptation(new Date("2026-09-24T17:00:00.000Z"));
    assert.equal(getStoredConnection(userA)?.needsReconnect, true);
    assert.equal(calls.some((call) => call.authorization === `Bearer ${TOKEN_B}` && call.url.includes("/athlete/i3091002/")), true);
    assert.equal(calls.some((call) => call.authorization === `Bearer ${TOKEN_B}` && call.url.includes(ATHLETE_A)), false);
  });

  it("deletes the stored secret on disconnect", async () => {
    const userId = "oauth-disconnect";
    insertUser({ id: userId, email: "disconnect-oauth@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userId, TOKEN_A, ATHLETE_A, NAME_A);
    assert.ok(getStoredConnection(userId)?.apiKeyEnc);
    await disconnectIntervals(userId);
    assert.equal(getStoredConnection(userId), null);
    assert.equal(dbContains(TOKEN_A), false);
  });

  it("renders the settings states without secrets", async () => {
    const oauthHtml = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: true,
      encryptionReady: true,
    });
    assert.equal(oauthHtml.includes(INTERVALS_OAUTH_CONNECT_BUTTON), true);
    assert.equal(oauthHtml.includes("Connect Intervals.icu"), true);
    assert.equal(oauthHtml.includes(INTERVALS_OAUTH_CONNECT_LINE), true);
    assert.equal(oauthHtml.includes('href="/auth/intervals/start"'), true);
    assert.equal(oauthHtml.includes('name="intervalsApiKey"'), false);
    assert.equal(oauthHtml.includes("Not available for your account"), false);
    assert.equal(oauthHtml.includes('data-intervals-actions'), true);
    assert.equal(oauthHtml.includes('data-intervals-helper'), true);

    const keyHtml = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: true,
      error: INTERVALS_CONNECT_REJECTED,
    });
    assert.equal(keyHtml.includes('name="intervalsApiKey"'), true);
    assert.equal(keyHtml.includes('name="intervalsAthleteId"'), true);
    assert.equal(keyHtml.includes("https://intervals.icu/settings"), true);
    assert.equal(
      keyHtml.includes("Intervals Settings &gt; Developer") || keyHtml.includes("Intervals Settings > Developer"),
      true,
    );
    assert.equal(keyHtml.includes("Couldn’t connect. Check your API key and athlete ID."), true);
    assert.equal(INTERVALS_ATHLETE_ID_PLACEHOLDER, "i123456");
    assert.equal(INTERVALS_ATHLETE_ID_INVALID, "Enter an athlete ID like i123456.");
    assert.equal(keyHtml.includes(`placeholder="${INTERVALS_ATHLETE_ID_PLACEHOLDER}"`), true);
    assert.equal(keyHtml.includes(`placeholder="${INTERVALS_ATHLETE_ID_INVALID}"`), false);
    assert.equal(keyHtml.includes(INTERVALS_ATHLETE_ID_INVALID), false);
    assert.equal(keyHtml.includes("i704884"), false);
    assert.match(keyHtml, /role="alert"/);
    assert.equal(keyHtml.includes("Not available for your account"), false);
    assert.equal(keyHtml.includes('data-intervals-actions'), true);
    assert.equal(keyHtml.includes('data-intervals-helper'), true);
    assert.equal(keyHtml.includes(CLIENT_SECRET), false);

    const invalidAthlete = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: true,
      athleteIdDraft: "nope",
      error: INTERVALS_ATHLETE_ID_INVALID,
    });
    const athleteInputAt = invalidAthlete.indexOf('name="intervalsAthleteId"');
    const athleteMessageAt = invalidAthlete.indexOf(INTERVALS_ATHLETE_ID_INVALID);
    assert.equal(invalidAthlete.includes(`placeholder="${INTERVALS_ATHLETE_ID_PLACEHOLDER}"`), true);
    assert.equal(invalidAthlete.includes(`placeholder="${INTERVALS_ATHLETE_ID_INVALID}"`), false);
    assert.equal(athleteInputAt >= 0 && athleteMessageAt > athleteInputAt, true);
    assert.equal(invalidAthlete.includes('id="intervals-athlete-error"'), true);
    assert.equal(invalidAthlete.includes('aria-describedby="intervals-athlete-error"'), true);
    assert.equal(invalidAthlete.slice(0, athleteInputAt).includes(INTERVALS_ATHLETE_ID_INVALID), false);

    const connected = await renderConnectedApps({
      connection: {
        connected: true,
        athleteId: ATHLETE_A,
        athleteName: NAME_A,
        authType: "oauth",
        statusLabel: `Connected as ${NAME_A}`,
        lastSyncLabel: null,
      },
      intervalsAvailable: true,
      oauthConfigured: true,
      encryptionReady: true,
    });
    assert.equal(connected.includes(`Connected as ${NAME_A}`), true);
    assert.equal(connected.includes("Sync now"), true);
    assert.equal(connected.includes("Disconnect"), true);
    assert.equal(connected.includes("Not available for your account"), false);
    assert.equal(connected.includes('data-intervals-actions'), true);
    assert.equal(connected.includes('data-intervals-helper'), true);
    assert.equal(connected.includes("Disconnect Intervals.icu?"), true);
    assert.equal(connected.includes(TOKEN_A), false);

    const idOnly = await renderConnectedApps({
      connection: {
        connected: true,
        athleteId: ATHLETE_A,
        authType: "oauth",
        statusLabel: `Connected as ${ATHLETE_A}`,
        lastSyncLabel: null,
      },
      intervalsAvailable: true,
    });
    assert.equal(idOnly.includes(`Connected as ${ATHLETE_A}`), true);

    const expired = await renderConnectedApps({
      connection: {
        connected: true,
        athleteId: ATHLETE_A,
        authType: "oauth",
        needsReconnect: true,
        statusLabel: INTERVALS_ACCESS_EXPIRED,
        lastSyncLabel: null,
      },
      intervalsAvailable: true,
      oauthConfigured: true,
      encryptionReady: true,
    });
    assert.equal(expired.includes("Intervals access expired"), true);
    assert.equal(expired.includes("Reconnect"), true);
    assert.equal(expired.includes('href="/auth/intervals/start"'), true);
    assert.equal(expired.includes("Disconnect"), true);
    assert.equal(expired.includes("Not available for your account"), false);
    assert.equal(expired.includes('data-intervals-actions'), true);
    assert.equal(expired.includes('data-intervals-helper'), true);
    assert.equal(expired.includes(TOKEN_A), false);

    const notice = await renderNotice({ show: true });
    assert.equal(
      INTERVALS_RECONNECT_NOTICE,
      "Intervals access expired. Reconnect to keep your runs and plan in sync.",
    );
    assert.equal(notice.includes("Intervals access expired."), true);
    assert.equal(notice.includes('href="/settings#intervals"'), true);
    assert.match(notice, new RegExp(`>\\s*${INTERVALS_RECONNECT_LINK_LABEL}\\s*<`));
    assert.equal(notice.includes("to keep your runs and plan in sync."), true);
    assert.equal(notice.includes('href="/auth/intervals/start"'), false);
    const hidden = await renderNotice({ show: false });
    assert.equal(hidden.includes("Intervals access expired"), false);
    assert.equal(INTERVALS_CONNECTED_TOAST, "Intervals connected");
    assert.equal(isIntervalsOAuthConfigured(), true);
  });

  it("expires the state cookie and keeps callback failures on a redirect", async () => {
    const userId = "oauth-routes";
    insertUser({ id: userId, email: "routes@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state") ?? "";
    const now = Date.now;
    Date.now = () => now() + 11 * 60 * 1000;
    try {
      const expired = await finishIntervalsOAuth(
        prodRequest(`/auth/intervals/callback?code=late&state=${state}`),
        jar.cookies,
        userId,
      );
      assert.equal(expired.kind, "csrf");
    } finally {
      Date.now = now;
    }

    const anon = await startRoute({
      request: prodRequest("/auth/intervals/start"),
      cookies: cookieJar().cookies,
      redirect: redirectTo,
    } as Parameters<typeof startRoute>[0]);
    assert.equal(anon.headers.get("location"), "/login");

    const session = cookieJar();
    setSessionCookie(session.cookies, userId);
    const authed = await startRoute({
      request: prodRequest("/auth/intervals/start"),
      cookies: session.cookies,
      redirect: redirectTo,
    } as Parameters<typeof startRoute>[0]);
    const location = authed.headers.get("location") ?? "";
    assert.equal(location.startsWith(INTERVALS_AUTHORIZE_URL), true);

    const callbackJar = cookieJar();
    setSessionCookie(callbackJar.cookies, userId);
    const begin = startIntervalsOAuth(prodRequest("/auth/intervals/start"), callbackJar.cookies, userId);
    const callbackState = new URL(begin.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => {
      throw new Error(`boom ${CLIENT_SECRET} ${TOKEN_A}`);
    });
    const failed = await callbackRoute({
      request: prodRequest(`/auth/intervals/callback?code=nope&state=${callbackState}`),
      cookies: callbackJar.cookies,
      redirect: redirectTo,
    } as Parameters<typeof callbackRoute>[0]);
    assert.equal(failed.status, 302);
    assert.equal(failed.headers.get("location"), "/settings?toast=intervals-error");

    const csrfJar = cookieJar();
    setSessionCookie(csrfJar.cookies, userId);
    const csrfDenied = await callbackRoute({
      request: prodRequest("/auth/intervals/callback?code=abc&state=not-the-state"),
      cookies: csrfJar.cookies,
      redirect: redirectTo,
    } as Parameters<typeof callbackRoute>[0]);
    assert.equal(csrfDenied.status, 302);
    assert.equal(csrfDenied.headers.get("location"), "/settings?toast=intervals-error");
    assert.equal(intervalsOAuthSettingsError("intervals-error"), INTERVALS_OAUTH_CONNECT_ERROR);
    assert.equal(csrfDenied.headers.get("content-type"), null);

    const cancelJar = cookieJar();
    setSessionCookie(cancelJar.cookies, userId);
    const beginCancel = startIntervalsOAuth(prodRequest("/auth/intervals/start"), cancelJar.cookies, userId);
    const cancelState = new URL(beginCancel.location).searchParams.get("state") ?? "";
    const cancelled = await callbackRoute({
      request: prodRequest(`/auth/intervals/callback?error=access_denied&state=${cancelState}`),
      cookies: cancelJar.cookies,
      redirect: redirectTo,
    } as Parameters<typeof callbackRoute>[0]);
    assert.equal(cancelled.headers.get("location"), "/settings");
  });

  it("returns 403 for a cross-site Intervals POST and rejects unsafe athlete ids", async () => {
    const cross = new Request("https://running-stats-production.up.railway.app/settings", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    const denied = denyIntervalsPostCsrf(cross, "intervals-connect");
    assert.ok(denied);
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), INTERVALS_CSRF_ERROR);
    assert.equal(denyIntervalsPostCsrf(cross, "save-cadence"), null);
    const disconnectDenied = denyIntervalsPostCsrf(cross, "intervals-disconnect");
    assert.ok(disconnectDenied);
    assert.equal(disconnectDenied.status, 403);
    assert.equal(await disconnectDenied.text(), INTERVALS_CSRF_ERROR);
    const same = new Request("https://running-stats-production.up.railway.app/settings", {
      method: "POST",
      headers: { origin: "https://running-stats-production.up.railway.app" },
    });
    assert.equal(denyIntervalsPostCsrf(same, "intervals-sync"), null);
    assert.equal(denyIntervalsPostCsrf(same, "intervals-disconnect"), null);
    assert.equal(intervalsCsrfDeniedResponse().status, 403);

    const userId = "oauth-bad-athlete";
    insertUser({ id: userId, email: "bad-athlete@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    for (const athleteId of ["../admin", "12?3", "abc%2Fdef"]) {
      const jar = cookieJar();
      const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
      const state = new URL(started.location).searchParams.get("state") ?? "";
      mock.method(globalThis, "fetch", async () => tokenResponse(TOKEN_A, athleteId, NAME_A));
      const result = await finishIntervalsOAuth(
        prodRequest(`/auth/intervals/callback?code=abc&state=${state}`),
        jar.cookies,
        userId,
      );
      assert.equal(result.kind, "error");
      assert.equal(getStoredConnection(userId), null);
      mock.restoreAll();
    }
  });

  it("keeps adapting the other account when one account throws", async () => {
    const userA = "oauth-throw-a";
    const userB = "oauth-throw-b";
    insertUser({ id: userA, email: "throw-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "throw-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userA, TOKEN_A, ATHLETE_A, NAME_A);
    await connectOAuth(userB, TOKEN_B, ATHLETE_B, "Bea Runner");
    const left = planBundle(userA);
    const right = planBundle(userB);
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
    const seen: string[] = [];
    const result = await runNocturnalAdaptation(new Date("2026-09-24T17:00:00.000Z"), {
      loadRunEffort: async (userId) => {
        seen.push(userId);
        if (userId === userA) throw new Error("sqlite locked");
        return null;
      },
    });
    assert.deepEqual(seen.sort(), [userA, userB].sort());
    assert.equal(result.processed >= 1, true);
    assert.equal(result.written >= 1, true);
  });

  it("keeps redirect_uri on PUBLIC_ORIGIN when Host is spoofed", () => {
    process.env.PUBLIC_ORIGIN = "https://running-stats-production.up.railway.app/";
    const userId = "oauth-origin";
    insertUser({ id: userId, email: "origin@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const request = new Request("http://127.0.0.1:4321/auth/intervals/start", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const started = startIntervalsOAuth(request, cookieJar().cookies, userId);
    const redirect = new URL(started.location).searchParams.get("redirect_uri");
    assert.equal(redirect, "https://running-stats-production.up.railway.app/auth/intervals/callback");
    assert.equal(started.location.includes("evil.example"), false);
  });

  it("treats OAuth as unconfigured in production when PUBLIC_ORIGIN is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_ORIGIN;
    const logged: string[] = [];
    mock.method(console, "error", (line: unknown) => {
      logged.push(String(line));
    });
    assert.equal(isIntervalsOAuthConfigured(), false);
    assert.equal(isIntervalsOAuthConfigured(), false);
    assert.equal(logged.filter((line) => line === "[intervals] PUBLIC_ORIGIN is not configured").length, 1);
    const userId = "oauth-no-origin";
    insertUser({ id: userId, email: "no-origin@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const started = startIntervalsOAuth(
      new Request("https://evil.example/auth/intervals/start", { headers: { host: "evil.example" } }),
      cookieJar().cookies,
      userId,
    );
    assert.equal(started.location, "/settings");
    assert.equal(started.location.includes("evil.example"), false);
  });

  it("fails closed on a built server without NODE_ENV or PUBLIC_ORIGIN", () => {
    delete process.env.NODE_ENV;
    delete process.env.PUBLIC_ORIGIN;
    mock.method(astroBuild, "isProd", () => true);
    assert.equal(isProductionRuntime(), true);
    assert.equal(isIntervalsOAuthConfigured(), false);
    const userId = "oauth-built-no-origin";
    insertUser({ id: userId, email: "built-no-origin@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const request = new Request("http://127.0.0.1:4321/auth/intervals/start", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const callback = intervalsOAuthCallbackUrl(request);
    assert.equal(callback, "/auth/intervals/callback");
    assert.equal(callback.includes("evil.example"), false);
    const started = startIntervalsOAuth(request, cookieJar().cookies, userId);
    assert.equal(started.location, "/settings");
    assert.equal(started.location.includes("intervals.icu"), false);
    assert.equal(started.location.includes("redirect_uri"), false);
    assert.equal(started.location.includes("evil.example"), false);
  });

  it("sends a missing-encryption callback to the unavailable line", async () => {
    const userId = "oauth-callback-no-enc";
    insertUser({ id: userId, email: "callback-no-enc@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    setSessionCookie(jar.cookies, userId);
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state") ?? "";
    assert.equal(state.length > 0, true);
    delete process.env.INTERVALS_KEY_ENC_SECRET;
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return tokenResponse(TOKEN_A, ATHLETE_A, NAME_A);
    });
    const response = await callbackRoute({
      request: prodRequest(`/auth/intervals/callback?code=enc-gone&state=${state}`),
      cookies: jar.cookies,
      redirect: redirectTo,
    } as Parameters<typeof callbackRoute>[0]);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/settings?toast=intervals-unavailable");
    assert.equal(intervalsOAuthSettingsError("intervals-unavailable"), INTERVALS_CONNECT_UNAVAILABLE);
    assert.equal(
      INTERVALS_CONNECT_UNAVAILABLE,
      "Connecting Intervals.icu isn’t available right now. Try again later.",
    );
    assert.equal(intervalsOAuthSettingsError("intervals-unavailable") === INTERVALS_OAUTH_CONNECT_ERROR, false);
    const row = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      oauthConfigured: true,
      encryptionReady: false,
      error: intervalsOAuthSettingsError("intervals-unavailable"),
    });
    assert.match(row, /role="alert"/);
    assert.equal(row.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(row.includes("Couldn’t connect to Intervals"), false);
    assert.equal(fetched, false);
    assert.equal(getStoredConnection(userId), null);
  });

  it("prefixes a numeric OAuth athlete id and rejects anything else", async () => {
    const userId = "oauth-numeric-athlete";
    insertUser({ id: userId, email: "numeric@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({ access_token: TOKEN_A, athlete: { id: 2049151, name: NAME_A } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=numeric&state=${state}`),
      jar.cookies,
      userId,
    );
    assert.equal(result.kind, "connected");
    assert.equal(getStoredConnection(userId)?.athleteId, "i2049151");
    mock.restoreAll();

    const jarBad = cookieJar();
    const startedBad = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jarBad.cookies, userId);
    const badState = new URL(startedBad.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => tokenResponse(TOKEN_B, "not-an-athlete", NAME_A));
    const rejected = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=bad-athlete&state=${badState}`),
      jarBad.cookies,
      userId,
    );
    assert.equal(rejected.kind, "error");
    if (rejected.kind === "error") assert.equal(rejected.message, INTERVALS_OAUTH_CONNECT_ERROR);
    assert.equal(getStoredConnection(userId)?.athleteId, "i2049151");
  });

  it("refuses a token whose granted scope omits a required scope and stores nothing new", async () => {
    const userId = "oauth-scope";
    insertUser({ id: userId, email: "scope@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          access_token: TOKEN_A,
          scope: "ACTIVITY:READ",
          athlete: { id: ATHLETE_A, name: NAME_A },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=narrow&state=${state}`),
      jar.cookies,
      userId,
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.message, INTERVALS_OAUTH_CALENDAR_SCOPE);
    assert.equal(getStoredConnection(userId), null);
    mock.restoreAll();

    const readOnly = cookieJar();
    const startedRead = startIntervalsOAuth(prodRequest("/auth/intervals/start"), readOnly.cookies, userId);
    const readState = new URL(startedRead.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          access_token: TOKEN_B,
          scope: "CALENDAR:WRITE",
          athlete: { id: ATHLETE_B, name: NAME_A },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const missingRead = await finishIntervalsOAuth(
      prodRequest(`/auth/intervals/callback?code=no-read&state=${readState}`),
      readOnly.cookies,
      userId,
    );
    assert.equal(missingRead.kind, "error");
    if (missingRead.kind === "error") assert.equal(missingRead.message, INTERVALS_OAUTH_CONNECT_ERROR);
    assert.equal(getStoredConnection(userId), null);
  });

  it("redirects to Settings when calendar write was not granted and stores nothing", async () => {
    const userId = "oauth-calendar-redirect";
    insertUser({ id: userId, email: "calendar-scope@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const jar = cookieJar();
    setSessionCookie(jar.cookies, userId);
    const started = startIntervalsOAuth(prodRequest("/auth/intervals/start"), jar.cookies, userId);
    const state = new URL(started.location).searchParams.get("state") ?? "";
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          access_token: TOKEN_A,
          scope: "ACTIVITY:READ",
          athlete: { id: ATHLETE_A, name: NAME_A },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const response = await callbackRoute({
      request: prodRequest(`/auth/intervals/callback?code=narrow&state=${state}`),
      cookies: jar.cookies,
      redirect: redirectTo,
    } as Parameters<typeof callbackRoute>[0]);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/settings?toast=intervals-calendar");
    assert.equal(intervalsOAuthSettingsError("intervals-calendar"), INTERVALS_OAUTH_CALENDAR_SCOPE);
    assert.equal(
      INTERVALS_OAUTH_CALENDAR_SCOPE,
      "Couldn’t connect. Stride Lab needs permission to add workouts to your Intervals calendar. Try again and allow calendar access.",
    );
    assert.equal(getStoredConnection(userId), null);
    const row = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      oauthConfigured: true,
      encryptionReady: true,
      error: INTERVALS_OAUTH_CALENDAR_SCOPE,
    });
    assert.match(row, /role="alert"/);
    assert.equal(row.includes(INTERVALS_OAUTH_CALENDAR_SCOPE), true);
    assert.equal(row.includes("Not connected"), true);
    assert.equal(row.includes('href="/auth/intervals/start"'), true);
    assert.equal(row.includes("disabled"), false);
    assert.equal(row.includes("Connect Intervals.icu"), true);
    assert.equal(row.includes("border-[#ff8a80]/30"), true);

    const stateError = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      oauthConfigured: true,
      encryptionReady: true,
      error: INTERVALS_OAUTH_CONNECT_ERROR,
    });
    assert.equal(INTERVALS_OAUTH_CONNECT_ERROR, "Couldn’t connect to Intervals. Try again.");
    assert.equal(stateError.includes(INTERVALS_OAUTH_CONNECT_ERROR), true);
    assert.match(stateError, /role="alert"/);
    assert.equal(stateError.includes("Not connected"), true);
    assert.equal(stateError.includes("Intervals access expired"), false);
    assert.equal(stateError.includes('href="/auth/intervals/start"'), true);
    assert.equal(stateError.includes("disabled"), false);
    assert.equal(stateError.includes("border-[#ff8a80]/30"), true);

    const syncPrompt = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      oauthConfigured: true,
      encryptionReady: true,
      error: INTERVALS_SYNC_NEEDS_CONNECT,
    });
    assert.equal(INTERVALS_SYNC_NEEDS_CONNECT, "Connect Intervals.icu to import your runs.");
    assert.equal(syncPrompt.includes('id="intervals"'), true);
    assert.equal(syncPrompt.includes('href="/settings#intervals"'), true);
    assert.equal(syncPrompt.includes("to import your runs."), true);
    assert.match(syncPrompt, /role="alert"/);
    assert.equal(syncPrompt.includes("border-[#ff8a80]/30"), true);
    assert.equal(syncPrompt.includes("your account"), false);
    assert.equal(syncPrompt.includes("isn’t available"), false);
    assert.equal(syncPrompt.includes('href="/auth/intervals/start"'), true);
    assert.equal(syncPrompt.includes("disabled"), false);
    const body = await response.text();
    assert.equal(body.includes(TOKEN_A), false);
    assert.equal(body.includes(CLIENT_SECRET), false);
  });

  it("marks reconnect when one user's ciphertext is copied onto another user", async () => {
    const userA = "oauth-aad-a";
    const userB = "oauth-aad-b";
    insertUser({ id: userA, email: "aad-a@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    insertUser({ id: userB, email: "aad-b@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    await connectOAuth(userA, TOKEN_A, ATHLETE_A, NAME_A);
    const enc = getStoredConnection(userA)?.apiKeyEnc ?? "";
    assert.equal(enc.startsWith("v2:"), true);
    assert.equal(decryptIntervalsApiKey(enc, userA), TOKEN_A);
    assert.throws(() => decryptIntervalsApiKey(enc, userB), IntervalsDecryptError);
    upsertIntervalsConnection({
      userId: userB,
      athleteId: ATHLETE_B,
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: enc,
      authType: "oauth",
      needsReconnect: false,
    });
    const view = await refreshIntervalsConnectionView(userB);
    assert.equal(view.needsReconnect, true);
    assert.equal(view.statusLabel, INTERVALS_ACCESS_EXPIRED);

    const key = intervalsEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("legacy-token", "utf8"), cipher.final()]);
    const v1 = `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
    assert.equal(decryptIntervalsApiKey(v1, userB), "legacy-token");
  });

  it("shows a disabled Connect or Reconnect when nothing is configured, and keeps Disconnect", async () => {
    const unavailable = await renderConnectedApps({
      connection: { connected: false, statusLabel: "Not connected" },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: false,
      envFallbackConnect: false,
    });
    assert.equal(unavailable.includes("Not available for your account"), false);
    assert.equal(unavailable.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(unavailable.includes('id="intervals"'), true);
    assert.equal(unavailable.includes(`aria-describedby="${INTERVALS_UNAVAILABLE_HELPER_ID}"`), true);
    assert.equal(unavailable.includes(`id="${INTERVALS_UNAVAILABLE_HELPER_ID}"`), true);
    assert.equal(unavailable.includes("Connect Intervals.icu"), true);
    assert.match(
      unavailable,
      /<button[^>]*disabled[^>]*>[\s\S]*Connect Intervals\.icu[\s\S]*<\/button>/,
    );
    assert.equal(unavailable.includes('name="intervalsApiKey"'), false);
    assert.equal(unavailable.includes('data-intervals-actions'), true);
    assert.equal(unavailable.includes('data-intervals-helper'), true);

    const connected = await renderConnectedApps({
      connection: {
        connected: true,
        athleteId: ATHLETE_A,
        statusLabel: `Connected as ${ATHLETE_A}`,
        lastSyncLabel: null,
      },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: false,
      envFallbackConnect: false,
    });
    assert.equal(connected.includes("Disconnect"), true);
    assert.equal(connected.includes("Sync now"), true);
    assert.equal(connected.includes(`Connected as ${ATHLETE_A}`), true);
    assert.equal(connected.includes("Not available for your account"), false);
    assert.equal(connected.includes('data-intervals-actions'), true);
    assert.equal(connected.includes('data-intervals-helper'), true);

    const expired = await renderConnectedApps({
      connection: {
        connected: true,
        athleteId: ATHLETE_A,
        needsReconnect: true,
        statusLabel: INTERVALS_ACCESS_EXPIRED,
        lastSyncLabel: null,
      },
      intervalsAvailable: true,
      oauthConfigured: false,
      encryptionReady: false,
      envFallbackConnect: false,
    });
    assert.equal(expired.includes("Intervals access expired"), true);
    assert.equal(expired.includes("Reconnect"), true);
    assert.equal(expired.includes(INTERVALS_CONNECT_UNAVAILABLE), true);
    assert.equal(expired.includes("Disconnect"), true);
    assert.equal(expired.includes("Not available for your account"), false);
    assert.match(expired, /<button[^>]*disabled[^>]*>[\s\S]*Reconnect[\s\S]*<\/button>/);
    assert.equal(expired.includes(`id="${INTERVALS_UNAVAILABLE_HELPER_ID}"`), true);
    assert.match(expired, /<button(?![^>]*disabled)[^>]*>\s*Disconnect\s*<\/button>/);
    assert.equal(expired.includes('href="/auth/intervals/start"'), false);
    assert.equal(expired.includes('data-intervals-actions'), true);
    assert.equal(expired.includes('data-intervals-helper'), true);
  });
});
