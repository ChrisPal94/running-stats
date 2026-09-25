import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AstroCookies } from "astro";
import {
  connectIntervalsOAuth,
  INTERVALS_CONNECT_UNAVAILABLE,
  INTERVALS_OAUTH_CALENDAR_SCOPE,
  INTERVALS_OAUTH_CONNECT_ERROR,
  INTERVALS_USER_AGENT,
} from "./intervals";
import { intervalsEncryptionReady } from "./intervals-crypto";
import { publicOrigin } from "./public-origin";

/**
 * Intervals.icu OAuth2 authorization-code flow.
 *
 * Source: https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
 * Authorize: GET https://intervals.icu/oauth/authorize
 *   query: client_id, redirect_uri, scope, state
 * Token: POST https://intervals.icu/api/oauth/token
 *   form: client_id, client_secret, code
 *   JSON: access_token, scope, athlete.id, athlete.name
 *
 * One scope per area. ACTIVITY:READ,CALENDAR:WRITE — WRITE implies READ.
 * READ and WRITE on the same area fails with "Duplicate scope".
 */
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
export const INTERVALS_OAUTH_SCOPE = "ACTIVITY:READ,CALENDAR:WRITE";
export const INTERVALS_OAUTH_CALLBACK_PATH = "/auth/intervals/callback";
export const INTERVALS_OAUTH_STATE_TTL_SEC = 10 * 60;

const OAUTH_COOKIE = "rs_intervals_oauth";
const FETCH_TIMEOUT_MS = 15_000;
const OAUTH_ATHLETE_ID = /^i\d{1,12}$/;
let loggedMissingPublicOrigin = false;

type OAuthStatePayload = {
  state: string;
  sub: string;
  exp: number;
};

export type IntervalsOAuthFinish =
  | { kind: "connected" }
  | { kind: "cancelled" }
  | { kind: "csrf" }
  | { kind: "error"; message: string };

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function configuredIntervalsOrigin(): string | null {
  const site = (import.meta.env as { SITE?: unknown } | undefined)?.SITE;
  const candidates = [envValue("PUBLIC_ORIGIN"), site];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      continue;
    }
  }
  return null;
}

export function isIntervalsOAuthConfigured(): boolean {
  if (!envValue("INTERVALS_CLIENT_ID") || !envValue("INTERVALS_CLIENT_SECRET")) return false;
  if (configuredIntervalsOrigin()) return true;
  if (process.env.NODE_ENV === "production") {
    if (!loggedMissingPublicOrigin) {
      loggedMissingPublicOrigin = true;
      console.error("[intervals] PUBLIC_ORIGIN is not configured");
    }
    return false;
  }
  return true;
}

export function intervalsOAuthCallbackUrl(request: Request): string {
  const origin = configuredIntervalsOrigin();
  if (origin) return `${origin}${INTERVALS_OAUTH_CALLBACK_PATH}`;
  if (process.env.NODE_ENV === "production") return INTERVALS_OAUTH_CALLBACK_PATH;
  return `${publicOrigin(request)}${INTERVALS_OAUTH_CALLBACK_PATH}`;
}

function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return import.meta.env.PROD;
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;
  if (!import.meta.env.PROD) return "dev-only-auth-secret-change-me";
  throw new Error("AUTH_SECRET must be set to a random string of at least 16 characters.");
}

function signState(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", authSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readState(token: string | undefined): OAuthStatePayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = createHmac("sha256", authSecret()).update(body).digest("base64url");
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload;
    if (!data.state || !data.sub || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function clearIntervalsOAuthState(cookies: AstroCookies): void {
  cookies.delete(OAUTH_COOKIE, { path: "/" });
}

export function startIntervalsOAuth(
  request: Request,
  cookies: AstroCookies,
  userId: string,
): { location: string } {
  try {
    if (!isIntervalsOAuthConfigured() || !intervalsEncryptionReady()) {
      return { location: "/settings" };
    }
    const state = randomBytes(32).toString("base64url");
    cookies.set(
      OAUTH_COOKIE,
      signState({
        state,
        sub: userId,
        exp: Date.now() + INTERVALS_OAUTH_STATE_TTL_SEC * 1000,
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: cookieSecure(),
        maxAge: INTERVALS_OAUTH_STATE_TTL_SEC,
      },
    );
    const url = new URL(INTERVALS_AUTHORIZE_URL);
    url.searchParams.set("client_id", envValue("INTERVALS_CLIENT_ID"));
    url.searchParams.set("redirect_uri", intervalsOAuthCallbackUrl(request));
    url.searchParams.set("scope", INTERVALS_OAUTH_SCOPE);
    url.searchParams.set("state", state);
    return { location: url.toString() };
  } catch {
    console.error("[intervals] oauth start failed");
    return { location: "/settings?toast=intervals-error" };
  }
}

function athleteIdFrom(value: unknown): string | null {
  let raw = "";
  if (typeof value === "number" && Number.isFinite(value)) raw = String(Math.trunc(value));
  else if (typeof value === "string") raw = value.trim();
  else return null;
  if (/^\d{1,12}$/.test(raw)) raw = `i${raw}`;
  if (!OAUTH_ATHLETE_ID.test(raw)) return null;
  return raw;
}

function grantedScope(
  record: Record<string, unknown>,
): { ok: true; scope: string } | { ok: false; missingCalendar: boolean } {
  if (!("scope" in record) || typeof record.scope !== "string") return { ok: true, scope: INTERVALS_OAUTH_SCOPE };
  const scopeRaw = record.scope.trim().slice(0, 200);
  if (!scopeRaw) return { ok: true, scope: INTERVALS_OAUTH_SCOPE };
  const granted = new Set(scopeRaw.split(/[\s,]+/).filter((part) => part.length > 0));
  if (!granted.has("CALENDAR:WRITE")) return { ok: false, missingCalendar: true };
  if (!granted.has("ACTIVITY:READ")) return { ok: false, missingCalendar: false };
  return { ok: true, scope: scopeRaw };
}

function parseTokenPayload(value: unknown):
  | {
      kind: "ok";
      accessToken: string;
      athleteId: string;
      athleteName?: string;
      scope: string;
    }
  | { kind: "calendar" }
  | { kind: "invalid" } {
  if (!value || typeof value !== "object") return { kind: "invalid" };
  const record = value as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : "";
  if (!accessToken || accessToken.length > 512) return { kind: "invalid" };
  const athlete = record.athlete;
  if (!athlete || typeof athlete !== "object") return { kind: "invalid" };
  const athleteId = athleteIdFrom((athlete as Record<string, unknown>).id);
  if (!athleteId) return { kind: "invalid" };
  const nameRaw = (athlete as Record<string, unknown>).name;
  const athleteName = typeof nameRaw === "string" ? nameRaw.trim().slice(0, 120) : "";
  const scope = grantedScope(record);
  if (!scope.ok) return scope.missingCalendar ? { kind: "calendar" } : { kind: "invalid" };
  return {
    kind: "ok",
    accessToken,
    athleteId,
    athleteName: athleteName || undefined,
    scope: scope.scope,
  };
}

export async function finishIntervalsOAuth(
  request: Request,
  cookies: AstroCookies,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IntervalsOAuthFinish> {
  const url = new URL(request.url);
  const presented = url.searchParams.get("state");
  const stored = readState(cookies.get(OAUTH_COOKIE)?.value);
  clearIntervalsOAuthState(cookies);

  if (url.searchParams.get("error")) return { kind: "cancelled" };

  const stateOk = Boolean(
    stored &&
      stored.sub === userId &&
      presented &&
      safeEqual(stored.state, presented),
  );
  if (!stateOk) return { kind: "csrf" };

  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code || code.length > 512) return { kind: "error", message: INTERVALS_OAUTH_CONNECT_ERROR };
  if (!isIntervalsOAuthConfigured() || !intervalsEncryptionReady()) {
    return { kind: "error", message: INTERVALS_CONNECT_UNAVAILABLE };
  }

  try {
    const response = await fetchImpl(INTERVALS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": INTERVALS_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: envValue("INTERVALS_CLIENT_ID"),
        client_secret: envValue("INTERVALS_CLIENT_SECRET"),
        code,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[intervals] oauth token exchange HTTP ${response.status}`);
      return { kind: "error", message: INTERVALS_OAUTH_CONNECT_ERROR };
    }
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      console.error("[intervals] oauth token exchange failed");
      return { kind: "error", message: INTERVALS_OAUTH_CONNECT_ERROR };
    }
    const parsed = parseTokenPayload(payload);
    if (parsed.kind === "calendar") return { kind: "error", message: INTERVALS_OAUTH_CALENDAR_SCOPE };
    if (parsed.kind !== "ok") {
      console.error("[intervals] oauth token exchange failed");
      return { kind: "error", message: INTERVALS_OAUTH_CONNECT_ERROR };
    }
    const saved = await connectIntervalsOAuth(userId, parsed);
    if (!saved.ok) return { kind: "error", message: saved.error };
    return { kind: "connected" };
  } catch {
    console.error("[intervals] oauth token exchange failed");
    return { kind: "error", message: INTERVALS_OAUTH_CONNECT_ERROR };
  }
}
