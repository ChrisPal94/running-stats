import { createHash, randomBytes } from "node:crypto";
import type { AstroCookies } from "astro";
import {
  googleAuthErrorPath,
  parseGoogleOAuthFrom,
  setGoogleOAuthState,
  setSessionCookie,
  takeGoogleOAuthState,
  upsertGoogleUser,
  type GoogleOAuthFrom,
} from "./auth";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const FETCH_TIMEOUT_MS = 10_000;

type GoogleTokenResponse = {
  access_token?: string;
};

type GoogleUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
};

function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() || "";
}

function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
}

function googleCallbackUrl(): string {
  return process.env.GOOGLE_CALLBACK_URL?.trim() || "";
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(googleClientId() && googleClientSecret() && googleCallbackUrl());
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isEmailVerified(value: unknown): boolean {
  return value === true || value === "true";
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function startGoogleOAuth(
  request: Request,
  cookies: AstroCookies,
): { location: string } {
  const from = parseGoogleOAuthFrom(new URL(request.url).searchParams.get("from"));
  const errorLocation = googleAuthErrorPath(from);

  if (!isGoogleOAuthConfigured()) {
    console.warn(
      "[auth] Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL.",
    );
    return { location: errorLocation };
  }

  const verifier = pkceVerifier();
  const nonce = setGoogleOAuthState(cookies, from, verifier);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", nonce);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  return { location: url.toString() };
}

export async function finishGoogleOAuth(
  request: Request,
  cookies: AstroCookies,
): Promise<{ location: string }> {
  const url = new URL(request.url);
  const taken = takeGoogleOAuthState(cookies, url.searchParams.get("state"));
  const from: GoogleOAuthFrom =
    taken.ok ? taken.state.from : (taken.from ?? parseGoogleOAuthFrom(url.searchParams.get("from")));
  const errorLocation = googleAuthErrorPath(from);

  if (!isGoogleOAuthConfigured()) {
    return { location: errorLocation };
  }

  if (url.searchParams.get("error") || !taken.ok) {
    return { location: errorLocation };
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return { location: errorLocation };
  }

  try {
    const token = await fetchJson<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId(),
        client_secret: googleClientSecret(),
        redirect_uri: googleCallbackUrl(),
        grant_type: "authorization_code",
        code_verifier: taken.state.verifier,
      }),
    });

    if (!token.access_token) {
      return { location: errorLocation };
    }

    const profile = await fetchJson<GoogleUserInfo>(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    if (!profile.sub || !profile.email || !isEmailVerified(profile.email_verified)) {
      return { location: errorLocation };
    }

    const result = await upsertGoogleUser(profile.sub, profile.email);
    setSessionCookie(cookies, result.user.id);
    return { location: result.created ? "/onboarding" : "/today" };
  } catch (error) {
    console.error("[auth] Google OAuth callback failed", error);
    return { location: errorLocation };
  }
}
