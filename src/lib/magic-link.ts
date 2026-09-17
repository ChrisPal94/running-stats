import { createHash, randomBytes } from "node:crypto";
import type { AstroCookies } from "astro";
import { postAuthPath } from "./app-session";
import {
  isSameOrigin,
  isValidEmail,
  normalizeEmail,
  setSessionCookie,
  upsertPasswordlessUser,
  type AuthUser,
} from "./auth";
import {
  deleteMagicToken,
  enqueueWrite,
  getMagicTokenByHash,
  insertMagicToken,
  invalidateUnusedMagicTokens,
  latestMagicTokenForEmail,
  markMagicTokenUsed,
  pruneMagicTokens,
} from "./db";
import { loadLocalEnv } from "./load-env";
import { publicOrigin } from "./public-origin";

loadLocalEnv();

const RESEND_URL = "https://api.resend.com/emails";
const FETCH_TIMEOUT_MS = 10_000;
const TOKEN_BYTES = 32;

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const MAGIC_LINK_RESEND_MS = 30 * 1000;
export const MAGIC_LINK_SUBJECT = "Your Running Stats sign-in link";
export const MAGIC_SEND_ERROR = "Couldn’t send the link. Try again.";
export const MAGIC_INVALID_EMAIL = "Enter a valid email";
export const MAGIC_EXPIRED_TOAST = "That link expired. Request a new one.";
export const MAGIC_EXPIRED_TOAST_PARAM = "magic-expired";
export const MAGIC_CSRF_ERROR = "This request could not be verified. Try again.";

export type MagicLinkRequestResult =
  | { ok: true; email: string; sent: boolean; cooldownRemainingMs: number }
  | { ok: false; error: string; email: string };

export type ConsumeMagicLinkResult =
  | { ok: true; user: AuthUser; created: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" };

export type IssuedMagicLink = {
  raw: string;
  hash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
};

function resendApiKey(): string {
  return process.env.RESEND_API_KEY?.trim() || "";
}

/** Prefer `MAIL_FROM`; `MAGIC_LINK_FROM` is a one-release fallback. */
export function mailFromAddress(): string {
  return process.env.MAIL_FROM?.trim() || process.env.MAGIC_LINK_FROM?.trim() || "";
}

export function isProductionRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production") return true;
  if (nodeEnv === "development" || nodeEnv === "test") return false;
  return import.meta.env.PROD === true;
}

export function isMagicMailConfigured(): boolean {
  return Boolean(resendApiKey() && mailFromAddress());
}

function fromHeader(): string {
  const from = mailFromAddress();
  if (from.includes("<")) return from;
  return `Running Stats <${from}>`;
}

export function hashMagicToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function magicSignInUrl(request: Request, token: string): string {
  const url = new URL("/auth/magic", `${publicOrigin(request)}/`);
  url.searchParams.set("token", token);
  return url.href;
}

export function magicExpiredLoginPath(): string {
  return `/login?toast=${MAGIC_EXPIRED_TOAST_PARAM}`;
}

export function magicLinkExpiredToast(url: URL): string {
  return url.searchParams.get("toast") === MAGIC_EXPIRED_TOAST_PARAM ? MAGIC_EXPIRED_TOAST : "";
}

export function isMagicLinkIntent(formData: FormData): boolean {
  return String(formData.get("intent") ?? "") === "magic";
}

export async function magicLinkContinuePath(
  created: boolean,
  userId: string,
): Promise<"/today" | "/onboarding"> {
  if (created) return "/onboarding";
  return postAuthPath(userId);
}

export function issueMagicLinkToken(
  email: string,
  options: { now?: number; ttlMs?: number } = {},
): IssuedMagicLink {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MAGIC_LINK_TTL_MS;
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = hashMagicToken(raw);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  pruneMagicTokens(createdAt);
  insertMagicToken({
    tokenHash: hash,
    email,
    createdAt,
    expiresAt,
  });
  return { raw, hash, email, createdAt, expiresAt };
}

async function sendMagicLinkEmail(to: string, signInUrl: string): Promise<void> {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromHeader(),
      to: [to],
      subject: MAGIC_LINK_SUBJECT,
      html: magicLinkHtml(signInUrl),
      text: magicLinkText(signInUrl),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Resend request failed (${response.status})`);
  }
}

function magicLinkHtml(signInUrl: string): string {
  const safeUrl = escapeHtml(signInUrl);
  return `<!doctype html>
<html>
  <body style="font-family:Arial,sans-serif;background:#05090b;color:#f4f7f2;padding:24px;">
    <p>Sign in to Running Stats. This link expires in 15 minutes and can only be used once.</p>
    <p>
      <a href="${safeUrl}" style="display:inline-block;background:#b8f52c;color:#05090b;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:999px;">Sign in</a>
    </p>
    <p style="color:#b5beb5;font-size:12px;">If the button doesn’t work, paste this URL into your browser:<br>${safeUrl}</p>
  </body>
</html>`;
}

function magicLinkText(signInUrl: string): string {
  return `Sign in to Running Stats:\n${signInUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cooldownRemainingMs(createdAt: string, now: number): number {
  const sentAt = Date.parse(createdAt);
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, sentAt + MAGIC_LINK_RESEND_MS - now);
}

export async function requestMagicLink(
  request: Request,
  formData: FormData,
  options: { now?: number } = {},
): Promise<MagicLinkRequestResult> {
  const email = normalizeEmail(formData.get("email"));
  const now = options.now ?? Date.now();

  if (!isSameOrigin(request)) {
    return { ok: false, error: MAGIC_CSRF_ERROR, email };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: MAGIC_INVALID_EMAIL, email };
  }

  if (!isMagicMailConfigured() && isProductionRuntime()) {
    console.error("[auth] Magic link mail is not configured");
    return { ok: false, error: MAGIC_SEND_ERROR, email };
  }

  try {
    return await enqueueWrite(async () => {
      const latest = latestMagicTokenForEmail(email);
      const remaining = latest ? cooldownRemainingMs(latest.createdAt, now) : 0;
      if (remaining > 0) {
        return { ok: true as const, email, sent: false, cooldownRemainingMs: remaining };
      }

      const issued = issueMagicLinkToken(email, { now });
      const signInUrl = magicSignInUrl(request, issued.raw);

      try {
        if (isMagicMailConfigured()) {
          await sendMagicLinkEmail(email, signInUrl);
        } else {
          console.info(
            `[auth] Magic sign-in URL for ${email} (RESEND_API_KEY / MAIL_FROM unset): ${signInUrl}`,
          );
        }
      } catch (error) {
        deleteMagicToken(issued.hash);
        throw error;
      }

      invalidateUnusedMagicTokens(email, issued.hash, issued.createdAt);

      return {
        ok: true as const,
        email,
        sent: true,
        cooldownRemainingMs: MAGIC_LINK_RESEND_MS,
      };
    });
  } catch (error) {
    console.error("[auth] magic link send failed", error);
    return { ok: false, error: MAGIC_SEND_ERROR, email };
  }
}

export async function consumeMagicLink(
  rawToken: string,
  options: { now?: number } = {},
): Promise<ConsumeMagicLinkResult> {
  const token = rawToken.trim();
  if (!token) return { ok: false, reason: "invalid" };

  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const hash = hashMagicToken(token);

  return enqueueWrite(async () => {
    const stored = getMagicTokenByHash(hash);
    if (!stored) return { ok: false as const, reason: "invalid" as const };
    if (stored.usedAt) return { ok: false as const, reason: "used" as const };
    if (stored.expiresAt <= nowIso) return { ok: false as const, reason: "expired" as const };

    markMagicTokenUsed(stored.tokenHash, nowIso);
    const result = upsertPasswordlessUser(stored.email);
    return { ok: true as const, user: result.user, created: result.created };
  });
}

export async function finishMagicLink(
  request: Request,
  cookies: AstroCookies,
): Promise<{ location: string }> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await consumeMagicLink(token);
  if (!result.ok) {
    return { location: magicExpiredLoginPath() };
  }
  setSessionCookie(cookies, result.user.id);
  return { location: await magicLinkContinuePath(result.created, result.user.id) };
}
