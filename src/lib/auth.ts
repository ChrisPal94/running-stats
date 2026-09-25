import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AstroCookies } from "astro";
import {
  enqueueWrite,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  insertUser,
  verifyUserEmail,
  withTransaction,
  type UserRecord,
} from "./db";
import { loadLocalEnv } from "./load-env";
import { isSameOrigin } from "./public-origin";

export { isSameOrigin, publicOrigin } from "./public-origin";

loadLocalEnv();

const scrypt = promisify(scryptCallback);

const SESSION_COOKIE = "rs_session";
const SESSION_DAYS = 30;
const GOOGLE_OAUTH_COOKIE = "rs_google_oauth";
const GOOGLE_OAUTH_MINUTES = 10;
const PASSWORD_KEYLEN = 64;
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export const GOOGLE_AUTH_ERROR =
  "Couldn’t connect to Google. Try email or try again.";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
  emailVerifiedAt?: string;
};

type StoredUser = AuthUser & {
  passwordHash?: string;
  googleId?: string;
  sessionEpoch?: number;
};

type SessionPayload = {
  sub: string;
  exp: number;
  epoch: number;
};

export type AuthFormResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: string; email: string };

export type GoogleOAuthFrom = "login" | "signup";

export type GoogleOAuthState = {
  nonce: string;
  from: GoogleOAuthFrom;
  verifier: string;
};

export type UpsertGoogleUserResult = {
  user: AuthUser;
  created: boolean;
};

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (secret && secret.length >= 16) {
    return secret;
  }

  if (import.meta.env.DEV) {
    console.warn(
      "[auth] AUTH_SECRET is missing or shorter than 16 characters. Using a development-only default. Set AUTH_SECRET before deploying.",
    );
    return "dev-only-auth-secret-change-me";
  }

  throw new Error("AUTH_SECRET must be set to a random string of at least 16 characters.");
}

function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return import.meta.env.PROD;
}

export function normalizeEmail(value: FormDataEntryValue | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function readPassword(value: FormDataEntryValue | null): string {
  return String(value ?? "");
}

export function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateCredentials(email: string, password: string): string | null {
  if (!isValidEmail(email)) return "Enter a valid email.";
  if (password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} characters.`;
  }
  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, PASSWORD_KEYLEN)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split(":");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function publicUser(user: UserRecord): AuthUser {
  const auth: AuthUser = { id: user.id, email: user.email, createdAt: user.createdAt };
  if (typeof user.emailVerifiedAt === "string" && user.emailVerifiedAt) {
    auth.emailVerifiedAt = user.emailVerifiedAt;
  }
  return auth;
}

function signSession(userId: string, epoch: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
      epoch,
    } satisfies SessionPayload),
  ).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readSession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (!data.sub || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    const epoch = typeof data.epoch === "number" && Number.isFinite(data.epoch) ? data.epoch : 0;
    return { sub: data.sub, exp: data.exp, epoch };
  } catch {
    return null;
  }
}

export function setSessionCookie(cookies: AstroCookies, userId: string): void {
  const epoch = getUserById(userId)?.sessionEpoch ?? 0;
  cookies.set(SESSION_COOKIE, signSession(userId, epoch), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cookieSecure(),
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: "/" });
}

export async function getCurrentUser(cookies: AstroCookies): Promise<AuthUser | null> {
  const session = readSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = getUserById(session.sub);
  if (!user) return null;
  if ((user.sessionEpoch ?? 0) !== session.epoch) return null;
  return publicUser(user);
}

export async function signupFromForm(
  request: Request,
  cookies: AstroCookies,
  formData?: FormData,
): Promise<AuthFormResult> {
  const data = formData ?? (await request.formData());
  const email = normalizeEmail(data.get("email"));
  const password = readPassword(data.get("password"));

  if (!isSameOrigin(request)) {
    return { ok: false, error: "This request could not be verified. Try again.", email };
  }

  const invalid = validateCredentials(email, password);
  if (invalid) return { ok: false, error: invalid, email };

  try {
    return await enqueueWrite(async () => {
      if (getUserByEmail(email)) {
        return {
          ok: false,
          error: "An account with this email already exists. Log in to continue.",
          email,
        };
      }

      const user: StoredUser = {
        id: randomBytes(16).toString("base64url"),
        email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      insertUser(user);
      setSessionCookie(cookies, user.id);
      return { ok: true, user: publicUser(user) };
    });
  } catch (error) {
    console.error("[auth] signup failed", error);
    return { ok: false, error: "Something went wrong. Try again.", email };
  }
}

export async function loginFromForm(
  request: Request,
  cookies: AstroCookies,
  formData?: FormData,
): Promise<AuthFormResult> {
  const data = formData ?? (await request.formData());
  const email = normalizeEmail(data.get("email"));
  const password = readPassword(data.get("password"));

  if (!isSameOrigin(request)) {
    return { ok: false, error: "This request could not be verified. Try again.", email };
  }

  const invalid = validateCredentials(email, password);
  if (invalid) return { ok: false, error: "Email or password is incorrect.", email };

  try {
    const user = getUserByEmail(email);
    const matches = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !matches) {
      return { ok: false, error: "Email or password is incorrect.", email };
    }

    setSessionCookie(cookies, user.id);
    return { ok: true, user: publicUser(user) };
  } catch (error) {
    console.error("[auth] login failed", error);
    return { ok: false, error: "Something went wrong. Try again.", email };
  }
}

export function parseGoogleOAuthFrom(value: string | null): GoogleOAuthFrom {
  return value === "login" ? "login" : "signup";
}

export function googleAuthErrorPath(from: GoogleOAuthFrom): string {
  return `/${from}?error=google`;
}

/** Google subject does not match an already-verified account. Shown as the generic Google error. */
export class GoogleAccountLinkError extends Error {
  constructor() {
    super("Google sign-in could not be linked to this account.");
    this.name = "GoogleAccountLinkError";
  }
}

export function authPageError(url: URL, formError: string): string {
  if (formError) return formError;
  if (url.searchParams.get("error") === "google") return GOOGLE_AUTH_ERROR;
  return "";
}

type GoogleOAuthCookiePayload = GoogleOAuthState & { exp: number };

function signGoogleOAuthState(state: GoogleOAuthCookiePayload): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readGoogleOAuthCookie(token: string | undefined): GoogleOAuthCookiePayload | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as GoogleOAuthCookiePayload;
    if (
      !data.nonce ||
      !data.verifier ||
      (data.from !== "login" && data.from !== "signup") ||
      typeof data.exp !== "number" ||
      data.exp < Date.now()
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function setGoogleOAuthState(
  cookies: AstroCookies,
  from: GoogleOAuthFrom,
  verifier: string,
): string {
  const nonce = randomBytes(16).toString("base64url");
  cookies.set(
    GOOGLE_OAUTH_COOKIE,
    signGoogleOAuthState({
      nonce,
      from,
      verifier,
      exp: Date.now() + GOOGLE_OAUTH_MINUTES * 60 * 1000,
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: cookieSecure(),
      maxAge: GOOGLE_OAUTH_MINUTES * 60,
    },
  );
  return nonce;
}

export type TakenGoogleOAuthState =
  | { ok: true; state: GoogleOAuthState }
  | { ok: false; from: GoogleOAuthFrom | null };

export function takeGoogleOAuthState(
  cookies: AstroCookies,
  nonce: string | null,
): TakenGoogleOAuthState {
  const data = readGoogleOAuthCookie(cookies.get(GOOGLE_OAUTH_COOKIE)?.value);
  cookies.delete(GOOGLE_OAUTH_COOKIE, { path: "/" });
  if (!data) return { ok: false, from: null };
  if (!nonce || data.nonce !== nonce) return { ok: false, from: data.from };
  return { ok: true, state: { nonce: data.nonce, from: data.from, verifier: data.verifier } };
}

export async function upsertGoogleUser(
  googleId: string,
  email: string,
): Promise<UpsertGoogleUserResult> {
  const normalized = email.trim().toLowerCase();
  if (!googleId || !isValidEmail(normalized)) {
    throw new Error("Google account is missing a verified email.");
  }

  return enqueueWrite(async () => {
    const verifiedAt = new Date().toISOString();
    return withTransaction(() => {
      const byGoogle = getUserByGoogleId(googleId);
      if (byGoogle) {
        // Verify only the address Google asserted. A subject match with a different
        // email still signs into this user and does not touch any other account.
        if (byGoogle.email.trim().toLowerCase() === normalized) {
          verifyUserEmail(byGoogle.id, verifiedAt);
        }
        const fresh = getUserById(byGoogle.id);
        if (!fresh) throw new Error("Google account is missing a verified email.");
        return { user: publicUser(fresh), created: false };
      }

      const byEmail = getUserByEmail(normalized);
      if (byEmail) {
        if (byEmail.googleId && byEmail.googleId !== googleId) {
          const verified =
            typeof byEmail.emailVerifiedAt === "string" && byEmail.emailVerifiedAt.trim().length > 0;
          if (verified) {
            throw new GoogleAccountLinkError();
          }
          console.warn(`[auth] replacing googleId on unverified user ${byEmail.id}`);
        }
        verifyUserEmail(byEmail.id, verifiedAt, googleId);
        const fresh = getUserById(byEmail.id);
        if (!fresh) throw new Error("Google account is missing a verified email.");
        return { user: publicUser(fresh), created: false };
      }

      const user: StoredUser = {
        id: randomBytes(16).toString("base64url"),
        email: normalized,
        googleId,
        createdAt: verifiedAt,
        emailVerifiedAt: verifiedAt,
        sessionEpoch: 0,
      };
      insertUser(user);
      return { user: publicUser(user), created: true };
    });
  });
}

/** Find or create a passwordless user. Callers must serialize writes (`enqueueWrite`). */
export function upsertPasswordlessUser(email: string): UpsertGoogleUserResult {
  const normalized = email.trim().toLowerCase();
  if (!isValidEmail(normalized)) {
    throw new Error("Magic link is missing a valid email.");
  }

  const verifiedAt = new Date().toISOString();
  const existing = getUserByEmail(normalized);
  if (existing) {
    verifyUserEmail(existing.id, verifiedAt);
    const fresh = getUserById(existing.id);
    if (!fresh) throw new Error("Magic link is missing a valid email.");
    return { user: publicUser(fresh), created: false };
  }

  const user: StoredUser = {
    id: randomBytes(16).toString("base64url"),
    email: normalized,
    createdAt: verifiedAt,
    emailVerifiedAt: verifiedAt,
    sessionEpoch: 0,
  };
  insertUser(user);
  return { user: publicUser(user), created: true };
}
