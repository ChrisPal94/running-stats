import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it, mock } from "node:test";
import type { AstroCookies } from "astro";
import {
  authPageError,
  getCurrentUser,
  GOOGLE_AUTH_ERROR,
  loginFromForm,
  setGoogleOAuthState,
  SIGN_IN_ERROR,
  signupFromForm,
} from "./auth.ts";
import {
  dbPath,
  getDb,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  insertUser,
  migrateAppDatabase,
  verifyUserEmail,
  withTransaction,
} from "./db.ts";
import { finishGoogleOAuth } from "./google-oauth.ts";
import {
  canUseIntervals,
  INTERVALS_NOT_FOR_ACCOUNT,
  INTERVALS_UNAVAILABLE_STATUS,
  intervalsOwnerDeniedResponse,
  intervalsSettingsControls,
} from "./intervals.ts";
import { consumeMagicLink, finishMagicLink, issueMagicLinkToken } from "./magic-link.ts";
import { handleSettingsPost } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-verified-email-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16chars";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.NODE_ENV = "test";

mkdirSync(dataDir, { recursive: true });
const legacy = new DatabaseSync(dbPath());
legacy.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL,
    passwordHash TEXT,
    googleId TEXT UNIQUE
  );
`);
legacy
  .prepare("INSERT INTO users (id, email, createdAt, passwordHash) VALUES (?, ?, ?, ?)")
  .run("legacy-user", "legacy-owner@example.com", "2026-09-01T00:00:00.000Z", "scrypt:legacy");
legacy.close();

const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalKey = process.env.INTERVALS_ICU_API_KEY;
const originalGoogleId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
const originalGoogleCallback = process.env.GOOGLE_CALLBACK_URL;
const originalCookieSecure = process.env.AUTH_COOKIE_SECURE;
const originalFetch = globalThis.fetch;

const OWNER_EMAIL = "crispal94@gmail.com";
const PASSWORD = "correct-horse";

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
  if (originalKey === undefined) delete process.env.INTERVALS_ICU_API_KEY;
  else process.env.INTERVALS_ICU_API_KEY = originalKey;
  if (originalGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleId;
  if (originalGoogleSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalGoogleSecret;
  if (originalGoogleCallback === undefined) delete process.env.GOOGLE_CALLBACK_URL;
  else process.env.GOOGLE_CALLBACK_URL = originalGoogleCallback;
  process.env.AUTH_COOKIE_SECURE = originalCookieSecure ?? "false";
});

function cookieJar(): { cookies: AstroCookies; get(name: string): string | undefined } {
  const values = new Map<string, string>();
  const cookies = {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    set(name: string, value: string) {
      values.set(name, String(value));
    },
    delete(name: string) {
      values.delete(name);
    },
  };
  return {
    cookies: cookies as unknown as AstroCookies,
    get(name: string) {
      return values.get(name);
    },
  };
}

function post(url: string): Request {
  return new Request(url, { method: "POST" });
}

function passwordForm(email: string, password = PASSWORD): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

function configureGoogle(): void {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
}

function mockGoogleFetch(options: {
  email: string;
  sub: string;
  emailVerified?: boolean | string;
  omitUserinfoVerified?: boolean;
  idTokenClaims?: Record<string, unknown>;
}): void {
  const profile: Record<string, unknown> = { sub: options.sub, email: options.email };
  if (!options.omitUserinfoVerified) profile.email_verified = options.emailVerified ?? true;
  const idToken = options.idTokenClaims
    ? `hdr.${Buffer.from(JSON.stringify(options.idTokenClaims)).toString("base64url")}.sig`
    : undefined;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token")) {
      return Response.json({ access_token: "access-token", ...(idToken ? { id_token: idToken } : {}) });
    }
    if (url.includes("userinfo")) return Response.json(profile);
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function finishGoogle(options: {
  email: string;
  sub: string;
  emailVerified?: boolean | string;
  omitUserinfoVerified?: boolean;
  idTokenClaims?: Record<string, unknown>;
}): Promise<{ location: string; jar: ReturnType<typeof cookieJar> }> {
  configureGoogle();
  const jar = cookieJar();
  const nonce = setGoogleOAuthState(jar.cookies, "login", "pkce-verifier-value");
  mockGoogleFetch(options);
  const request = new Request(
    `http://localhost:4321/auth/google/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
  );
  const { location } = await finishGoogleOAuth(request, jar.cookies);
  return { location, jar };
}

describe("email verification migration", () => {
  it("adds nullable emailVerifiedAt without backfill and is idempotent", () => {
    const database = getDb();
    migrateAppDatabase(database);
    migrateAppDatabase(database);
    const columns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    assert.equal(columns.filter((column) => column.name === "emailVerifiedAt").length, 1);
    const row = database
      .prepare("SELECT emailVerifiedAt, passwordHash, sessionEpoch FROM users WHERE id = ?")
      .get("legacy-user") as { emailVerifiedAt: string | null; passwordHash: string; sessionEpoch: number };
    assert.equal(row.emailVerifiedAt, null);
    assert.equal(row.passwordHash, "scrypt:legacy");
    assert.equal(row.sessionEpoch, 0);
    assert.equal(getUserById("legacy-user")?.emailVerifiedAt, null);
    assert.equal(canUseIntervals(getUserById("legacy-user")), false);

    const sql: string[] = [];
    const originalExec = database.exec.bind(database);
    database.exec = ((source: string) => {
      sql.push(source);
      return originalExec(source);
    }) as typeof database.exec;
    try {
      migrateAppDatabase(database);
    } finally {
      database.exec = originalExec;
    }
    assert.equal(sql.some((source) => source.includes("CREATE") || source.includes("ALTER")), false);
  });
});

describe("withTransaction reentrancy", () => {
  it("issues one BEGIN when verifyUserEmail runs inside an open transaction", () => {
    const id = "nested-verify-user";
    insertUser({
      id,
      email: "nested-verify@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
      passwordHash: "scrypt:nested",
    });
    const database = getDb();
    const sql: string[] = [];
    const originalExec = database.exec.bind(database);
    database.exec = ((source: string) => {
      sql.push(source);
      return originalExec(source);
    }) as typeof database.exec;
    try {
      withTransaction(() => {
        verifyUserEmail(id, "2026-09-25T00:00:00.000Z", "nested-verify-sub");
      });
    } finally {
      database.exec = originalExec;
    }
    assert.deepEqual(sql.filter((source) => source.includes("BEGIN")), ["BEGIN IMMEDIATE"]);
    assert.deepEqual(sql.filter((source) => source === "COMMIT"), ["COMMIT"]);
    const user = getUserById(id);
    assert.equal(user?.emailVerifiedAt, "2026-09-25T00:00:00.000Z");
    assert.equal(user?.googleId, "nested-verify-sub");
    assert.equal(user?.passwordHash, undefined);
  });

  it("rolls back the outer transaction when a nested withTransaction throws", () => {
    const id = "nested-rollback-user";
    insertUser({
      id,
      email: "nested-rollback@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    assert.throws(() => {
      withTransaction(() => {
        getDb().prepare("UPDATE users SET email = ? WHERE id = ?").run("changed-nested@example.com", id);
        withTransaction(() => {
          throw new Error("inner");
        });
      });
    }, /inner/);
    assert.equal(getUserById(id)?.email, "nested-rollback@example.com");
  });
});

describe("password signup does not verify an owner email", () => {
  it("rejects Intervals for a password account whose email matches the allowlist", async () => {
    process.env.INTERVALS_OWNER_EMAILS = `  ${OWNER_EMAIL.toUpperCase()}  `;
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    });

    const jar = cookieJar();
    const signed = await signupFromForm(
      post("http://localhost/signup"),
      jar.cookies,
      passwordForm(`  ${OWNER_EMAIL.toUpperCase()}  `),
    );
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    assert.equal(signed.user.email, OWNER_EMAIL);
    assert.equal(signed.user.emailVerifiedAt, undefined);

    const stored = getUserByEmail(OWNER_EMAIL);
    assert.ok(stored?.passwordHash);
    assert.equal(stored?.emailVerifiedAt, null);
    assert.equal(canUseIntervals(stored), false);
    assert.equal(canUseIntervals(signed.user), false);

    const logged = await loginFromForm(
      post("http://localhost/login"),
      cookieJar().cookies,
      passwordForm(`  ${OWNER_EMAIL.toUpperCase()}  `),
    );
    assert.equal(logged.ok, true);
    if (logged.ok) assert.equal(logged.user.emailVerifiedAt, undefined);
    assert.equal(getUserByEmail(OWNER_EMAIL)?.emailVerifiedAt, null);

    const controls = intervalsSettingsControls({
      available: canUseIntervals(stored),
      connection: {
        connected: true,
        athleteId: "i704884",
        statusLabel: "Connected · i704884",
        lastSyncLabel: null,
      },
    });
    assert.equal(controls.statusLabel, "Not available for your account");
    assert.equal(controls.statusLabel, INTERVALS_UNAVAILABLE_STATUS);
    assert.equal(controls.showConnect, false);
    assert.equal(controls.showSync, false);

    for (const intent of ["intervals-connect", "intervals-sync", "intervals-pick-run", "intervals-skip-pick"]) {
      const denied = intervalsOwnerDeniedResponse(stored, intent);
      assert.ok(denied);
      assert.equal(denied.status, 403);
      assert.equal(await denied.text(), INTERVALS_NOT_FOR_ACCOUNT);
      const form = new FormData();
      form.set("intent", intent);
      const result = await handleSettingsPost(stored!.id, form);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 403);
    }
    assert.equal(fetched, false);
  });
});

describe("Google callback verification", () => {
  it("marks the email verified and allows Intervals when email_verified is true", async () => {
    const email = "google-verified-owner@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const { location, jar } = await finishGoogle({ email, sub: "google-verified-sub", emailVerified: true });
    assert.equal(location, "/onboarding");
    const user = getUserByEmail(email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(canUseIntervals(user), true);
    assert.equal(intervalsOwnerDeniedResponse(user, "intervals-connect"), null);
    assert.ok(await getCurrentUser(jar.cookies));
  });

  it("marks verified from an id token when userinfo omits email_verified", async () => {
    const email = "id-token-owner@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const { location } = await finishGoogle({
      email,
      sub: "id-token-sub",
      omitUserinfoVerified: true,
      idTokenClaims: { email_verified: true },
    });
    assert.equal(location, "/onboarding");
    const user = getUserByEmail(email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(canUseIntervals(user), true);
  });

  it("does not mark verified when Google reports email_verified false", async () => {
    const email = "google-unverified-owner@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    const hash = getUserByEmail(email)?.passwordHash;
    assert.ok(hash);

    const { location } = await finishGoogle({
      email,
      sub: "google-unverified-sub",
      emailVerified: false,
      idTokenClaims: { email_verified: true },
    });
    assert.match(location, /error=google/);
    const user = getUserByEmail(email);
    assert.equal(user?.emailVerifiedAt, null);
    assert.equal(user?.passwordHash, hash);
    assert.equal(canUseIntervals(user), false);
    assert.ok(await getCurrentUser(jar.cookies));

    const missing = "never-google@example.com";
    const unseen = await finishGoogle({ email: missing, sub: "missing-sub", emailVerified: false });
    assert.match(unseen.location, /error=google/);
    assert.equal(getUserByEmail(missing), null);
  });

  it("does not mark verified when email_verified is missing or not boolean true", async () => {
    const email = "google-missing-claim@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    const hash = getUserByEmail(email)?.passwordHash;
    assert.ok(hash);

    const missingClaim = await finishGoogle({
      email,
      sub: "google-missing-claim-sub",
      omitUserinfoVerified: true,
    });
    assert.match(missingClaim.location, /error=google/);
    assert.equal(getUserByEmail(email)?.emailVerifiedAt, null);
    assert.equal(getUserByEmail(email)?.passwordHash, hash);
    assert.equal(canUseIntervals(getUserByEmail(email)), false);
    assert.ok(await getCurrentUser(jar.cookies));

    const stringTrue = await finishGoogle({
      email,
      sub: "google-string-true-sub",
      emailVerified: "true",
    });
    assert.match(stringTrue.location, /error=google/);
    assert.equal(getUserByEmail(email)?.emailVerifiedAt, null);
    assert.equal(getUserByEmail(email)?.passwordHash, hash);
    assert.ok(await getCurrentUser(jar.cookies));
  });

  it("verifies when the Google subject matches and the email matches", async () => {
    const email = "subject-same@example.com";
    process.env.INTERVALS_OWNER_EMAILS = `  ${email.toUpperCase()}  `;
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    getDb().prepare("UPDATE users SET googleId = ? WHERE id = ?").run("subject-same-sub", signed.user.id);
    const hash = getUserById(signed.user.id)?.passwordHash;
    assert.ok(hash);

    const { jar } = await finishGoogle({
      email: `  ${email.toUpperCase()}  `,
      sub: "subject-same-sub",
      emailVerified: true,
    });
    const user = getUserById(signed.user.id);
    assert.equal(user?.email, email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(user?.googleId, "subject-same-sub");
    assert.equal(user?.passwordHash, undefined);
    assert.equal(canUseIntervals(user), true);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);
  });

  it("does not verify when the Google subject matches a different email", async () => {
    const stored = "subject-diff-owner@example.com";
    const googleEmail = "subject-diff-google@example.com";
    process.env.INTERVALS_OWNER_EMAILS = stored;
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(stored));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    getDb().prepare("UPDATE users SET googleId = ? WHERE id = ?").run("subject-diff-sub", signed.user.id);
    const before = getUserById(signed.user.id);
    assert.ok(before?.passwordHash);

    const { jar } = await finishGoogle({
      email: `  ${googleEmail.toUpperCase()}  `,
      sub: "subject-diff-sub",
      emailVerified: true,
    });
    const user = getUserById(signed.user.id);
    assert.equal(user?.email, stored);
    assert.equal(user?.emailVerifiedAt, null);
    assert.equal(user?.passwordHash, before.passwordHash);
    assert.equal(user?.googleId, "subject-diff-sub");
    assert.equal(user?.sessionEpoch, before.sessionEpoch);
    assert.equal(canUseIntervals(user), false);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);
    assert.equal(getUserByEmail(googleEmail), null);
  });

  it("logs into the subject account and leaves the email account untouched", async () => {
    const emailA = "subject-account-a@example.com";
    const emailB = "subject-account-b@example.com";
    process.env.INTERVALS_OWNER_EMAILS = `${emailA},${emailB}`;
    const signedA = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(emailA));
    const signedB = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(emailB, "other-secret"),
    );
    assert.equal(signedA.ok, true);
    assert.equal(signedB.ok, true);
    if (!signedA.ok || !signedB.ok) return;
    getDb().prepare("UPDATE users SET googleId = ? WHERE id = ?").run("subject-a-sub", signedA.user.id);
    const beforeA = getUserById(signedA.user.id);
    const beforeB = getUserById(signedB.user.id);
    assert.ok(beforeA?.passwordHash);
    assert.ok(beforeB?.passwordHash);

    const { jar } = await finishGoogle({
      email: `  ${emailB.toUpperCase()}  `,
      sub: "subject-a-sub",
      emailVerified: true,
    });
    assert.equal((await getCurrentUser(jar.cookies))?.id, signedA.user.id);

    const accountA = getUserById(signedA.user.id);
    const accountB = getUserById(signedB.user.id);
    assert.equal(accountA?.email, emailA);
    assert.equal(accountA?.emailVerifiedAt, null);
    assert.equal(accountA?.googleId, "subject-a-sub");
    assert.equal(accountA?.passwordHash, beforeA.passwordHash);
    assert.equal(accountA?.sessionEpoch, beforeA.sessionEpoch);
    assert.equal(accountB?.email, emailB);
    assert.equal(accountB?.emailVerifiedAt, null);
    assert.equal(accountB?.googleId, undefined);
    assert.equal(accountB?.passwordHash, beforeB.passwordHash);
    assert.equal(accountB?.sessionEpoch, beforeB.sessionEpoch);
    assert.equal(canUseIntervals(accountA), false);
    assert.equal(canUseIntervals(accountB), false);
    assert.equal(countUsers(emailB), 1);
  });

  it("rejects a verified account whose googleId differs and does not overwrite it", async () => {
    const email = "verified-other-google@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const verifiedAt = "2026-09-19T00:00:00.000Z";
    getDb()
      .prepare("UPDATE users SET googleId = ?, emailVerifiedAt = ? WHERE id = ?")
      .run("verified-old-sub", verifiedAt, signed.user.id);
    const before = getUserById(signed.user.id);
    assert.ok(before?.passwordHash);
    const warnings: string[] = [];
    const errors: string[] = [];
    mock.method(console, "warn", (line: string) => {
      warnings.push(String(line));
    });
    mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.map((arg) => (arg instanceof Error ? arg.name : String(arg))).join(" "));
    });

    const { location, jar } = await finishGoogle({
      email: `  ${email.toUpperCase()}  `,
      sub: "verified-new-sub",
      emailVerified: true,
    });
    assert.match(location, /error=google/);
    assert.equal(jar.get("rs_session"), undefined);
    const user = getUserById(signed.user.id);
    assert.equal(user?.googleId, "verified-old-sub");
    assert.equal(user?.email, email);
    assert.equal(user?.emailVerifiedAt, verifiedAt);
    assert.equal(user?.passwordHash, before.passwordHash);
    assert.equal(user?.sessionEpoch, before.sessionEpoch);
    assert.equal(warnings.length, 0);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] ?? "").includes(signed.user.id), true);
    assert.equal((errors[0] ?? "").includes(email), false);
    assert.equal((errors[0] ?? "").includes("@"), false);
    assert.equal(getUserByGoogleId("verified-new-sub"), null);
  });

  it("overwrites googleId on an unverified account and warns with the user id only", async () => {
    const email = "unverified-other-google@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    getDb().prepare("UPDATE users SET googleId = ? WHERE id = ?").run("unverified-old-sub", signed.user.id);
    const warnings: string[] = [];
    mock.method(console, "warn", (line: string) => {
      warnings.push(String(line));
    });

    const { jar } = await finishGoogle({
      email: `  ${email.toUpperCase()}  `,
      sub: "unverified-new-sub",
      emailVerified: true,
    });
    const user = getUserById(signed.user.id);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);
    assert.equal(user?.email, email);
    assert.equal(user?.googleId, "unverified-new-sub");
    assert.ok(user?.emailVerifiedAt);
    assert.equal(user?.passwordHash, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", new RegExp(signed.user.id));
    assert.equal((warnings[0] ?? "").includes(email), false);
    assert.equal((warnings[0] ?? "").includes("@"), false);
    assert.equal(getUserById(signed.user.id)?.googleId, "unverified-new-sub");
  });
});

describe("login page sign-in failures", () => {
  function showsOnlyGeneric(location: string, email: string): void {
    assert.equal(location.startsWith("/login?"), true);
    assert.equal(location.includes(email), false);
    assert.equal(location.includes("missing a verified email"), false);
    assert.equal(location.includes("missing a valid email"), false);
    assert.equal(location.includes("could not be linked"), false);
    assert.equal(location.includes("account"), false);
    const shown = authPageError(new URL(`https://example.com${location}`), "");
    assert.equal(shown, "Couldn’t sign in. Try again or use another method.");
    assert.equal(shown, SIGN_IN_ERROR);
    assert.equal(shown.includes(email), false);
    assert.equal(shown.includes("@"), false);
  }

  it("shows only the generic copy for Google and magic-link failures", async () => {
    const missingEmail = await finishGoogle({
      email: "not-an-email",
      sub: "missing-verified-email-sub",
      emailVerified: true,
    });
    showsOnlyGeneric(missingEmail.location, "not-an-email");

    const issued = issueMagicLinkToken("not-a-magic-email");
    const magic = await finishMagicLink(
      new Request(`http://localhost/auth/magic?token=${encodeURIComponent(issued.raw)}`),
      cookieJar().cookies,
    );
    showsOnlyGeneric(magic.location, "not-a-magic-email");

    const email = "login-copy-verified@example.com";
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    getDb()
      .prepare("UPDATE users SET googleId = ?, emailVerifiedAt = ? WHERE id = ?")
      .run("login-copy-old-sub", "2026-09-18T00:00:00.000Z", signed.user.id);
    const rejected = await finishGoogle({
      email: `  ${email.toUpperCase()}  `,
      sub: "login-copy-new-sub",
      emailVerified: true,
    });
    showsOnlyGeneric(rejected.location, email);
    assert.equal(getUserById(signed.user.id)?.googleId, "login-copy-old-sub");
    assert.equal(getUserById(signed.user.id)?.emailVerifiedAt, "2026-09-18T00:00:00.000Z");

    const leakedQuery = authPageError(
      new URL("https://example.com/login?error=Google%20account%20is%20missing%20a%20verified%20email."),
      "Magic link is missing a valid email.",
    );
    assert.equal(leakedQuery, SIGN_IN_ERROR);
    assert.equal(authPageError(new URL("https://example.com/login"), "Google sign-in could not be linked to this account."), SIGN_IN_ERROR);
    assert.equal(authPageError(new URL("https://example.com/signup?error=google"), ""), GOOGLE_AUTH_ERROR);
  });
});

describe("magic link consume verifies email", () => {
  it("marks a new magic-link account verified", async () => {
    const email = "magic-owner@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const issued = issueMagicLinkToken(email);
    const result = await consumeMagicLink(issued.raw);
    assert.equal(result.ok, true);
    const user = getUserByEmail(email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(user?.passwordHash, undefined);
    assert.equal(canUseIntervals(user), true);
  });

  it("clears a password and other sessions when an unverified account consumes a magic link", async () => {
    const email = "magic-hijack@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const oldJar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), oldJar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    assert.ok(await getCurrentUser(oldJar.cookies));
    assert.ok(getUserByEmail(email)?.passwordHash);

    const issued = issueMagicLinkToken(email);
    const magicJar = cookieJar();
    const finished = await finishMagicLink(
      new Request(`http://localhost/auth/magic?token=${encodeURIComponent(issued.raw)}`),
      magicJar.cookies,
    );
    assert.equal(finished.location, "/onboarding");
    const user = getUserByEmail(email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(user?.passwordHash, undefined);
    assert.equal(canUseIntervals(user), true);
    const newToken = magicJar.get("rs_session");
    assert.ok(newToken);
    assert.ok(sessionEpoch(newToken) > sessionEpoch(oldJar.get("rs_session")));
    assert.equal(await getCurrentUser(oldJar.cookies), null);
    assert.ok(await getCurrentUser(magicJar.cookies));
  });
});

describe("unverified password account then Google login", () => {
  it("clears the password hash and invalidates other sessions", async () => {
    const email = "hijack-owner@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const signupJar = cookieJar();
    const signed = await signupFromForm(
      post("http://localhost/signup"),
      signupJar.cookies,
      passwordForm(`  ${email.toUpperCase()}  `),
    );
    assert.equal(signed.ok, true);
    const loginJar = cookieJar();
    const logged = await loginFromForm(post("http://localhost/login"), loginJar.cookies, passwordForm(email));
    assert.equal(logged.ok, true);
    assert.ok(getUserByEmail(email)?.passwordHash);
    assert.ok(await getCurrentUser(signupJar.cookies));
    assert.ok(await getCurrentUser(loginJar.cookies));

    const { location, jar } = await finishGoogle({ email, sub: "hijack-google-sub", emailVerified: true });
    assert.equal(location, "/onboarding");
    const user = getUserByEmail(email);
    assert.ok(user?.emailVerifiedAt);
    assert.equal(user?.passwordHash, undefined);
    assert.equal(canUseIntervals(user), true);
    assert.equal(await getCurrentUser(signupJar.cookies), null);
    assert.equal(await getCurrentUser(loginJar.cookies), null);
    assert.ok(await getCurrentUser(jar.cookies));

    const newToken = jar.get("rs_session");
    assert.ok(newToken);
    const oldEpoch = sessionEpoch(signupJar.get("rs_session"));
    const newEpoch = sessionEpoch(newToken);
    assert.ok(newEpoch > oldEpoch);
    assert.equal(await getCurrentUser(signupJar.cookies), null);
    assert.equal(await getCurrentUser(loginJar.cookies), null);
    assert.ok(await getCurrentUser(jar.cookies));

    const retry = await loginFromForm(post("http://localhost/login"), cookieJar().cookies, passwordForm(email));
    const unknown = await loginFromForm(
      post("http://localhost/login"),
      cookieJar().cookies,
      passwordForm("nobody-hijack@example.com"),
    );
    assert.equal(retry.ok, false);
    assert.equal(unknown.ok, false);
    if (!retry.ok && !unknown.ok) {
      assert.equal(retry.error, "Email or password is incorrect.");
      assert.equal(unknown.error, retry.error);
    }
  });

  it("keeps the password and existing sessions when the account is already verified", async () => {
    const email = "already-verified@example.com";
    process.env.INTERVALS_OWNER_EMAILS = email;
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const verifiedAt = "2026-09-20T00:00:00.000Z";
    getDb().prepare("UPDATE users SET emailVerifiedAt = ? WHERE id = ?").run(verifiedAt, signed.user.id);
    const hash = getUserById(signed.user.id)?.passwordHash;
    assert.ok(hash);

    const { jar: googleJar } = await finishGoogle({ email, sub: "already-sub", emailVerified: true });
    const user = getUserById(signed.user.id);
    assert.equal(user?.emailVerifiedAt, verifiedAt);
    assert.equal(user?.passwordHash, hash);
    assert.ok(await getCurrentUser(jar.cookies));
    assert.ok(await getCurrentUser(googleJar.cookies));
    const retry = await loginFromForm(post("http://localhost/login"), cookieJar().cookies, passwordForm(email));
    assert.equal(retry.ok, true);
    assert.equal(getUserById(signed.user.id)?.emailVerifiedAt, verifiedAt);
    assert.equal(getUserById(signed.user.id)?.passwordHash, hash);
  });
});

function sessionEpoch(token: string | undefined): number {
  assert.ok(token);
  const payload = token.split(".")[0] ?? "";
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { epoch?: number };
  return typeof data.epoch === "number" ? data.epoch : 0;
}

function countUsers(email: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email) as { n: number };
  return Number(row.n);
}

describe("normalized email lookup", () => {
  it("links a mixed-case Google email to the existing lowercase account", async () => {
    const email = "crispal94-google-link@gmail.com";
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    assert.equal(countUsers(email), 1);

    const { location, jar } = await finishGoogle({
      email: "  Crispal94-Google-Link@gmail.com ",
      sub: "google-link-sub",
      emailVerified: true,
    });
    assert.equal(location, "/onboarding");
    assert.equal(countUsers(email), 1);
    const user = getUserById(signed.user.id);
    assert.equal(user?.email, email);
    assert.equal(user?.googleId, "google-link-sub");
    assert.ok(user?.emailVerifiedAt);
    assert.ok(await getCurrentUser(jar.cookies));
    assert.equal(getUserByEmail("CRISPAL94-GOOGLE-LINK@gmail.com")?.id, signed.user.id);
  });

  it("links a mixed-case magic-link email to the existing lowercase account", async () => {
    const email = "crispal94-magic-link@gmail.com";
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const issued = issueMagicLinkToken("  Crispal94-Magic-Link@gmail.com ");
    const result = await consumeMagicLink(issued.raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.created, false);
      assert.equal(result.user.id, signed.user.id);
    }
    assert.equal(countUsers(email), 1);
    assert.equal(getUserByEmail("  crispal94-magic-link@gmail.com ")?.id, signed.user.id);
  });
});

describe("password signup and login edges", () => {
  it("rejects signup for an existing email without changing verification or the password", async () => {
    const unverifiedEmail = "signup-exists-unverified@example.com";
    const verifiedEmail = "signup-exists-verified@example.com";
    const first = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(unverifiedEmail),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const unverifiedHash = getUserById(first.user.id)?.passwordHash;
    assert.ok(unverifiedHash);

    const verified = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(verifiedEmail, "another-secret"),
    );
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    const verifiedAt = "2026-09-22T00:00:00.000Z";
    getDb().prepare("UPDATE users SET emailVerifiedAt = ? WHERE id = ?").run(verifiedAt, verified.user.id);
    const verifiedHash = getUserById(verified.user.id)?.passwordHash;
    assert.ok(verifiedHash);

    for (const [email, id, hash, verifiedStamp] of [
      [unverifiedEmail, first.user.id, unverifiedHash, null],
      [verifiedEmail, verified.user.id, verifiedHash, verifiedAt],
    ] as const) {
      const jar = cookieJar();
      const again = await signupFromForm(
        post("http://localhost/signup"),
        jar.cookies,
        passwordForm(`  ${email.toUpperCase()}  `, "different-password"),
      );
      assert.equal(again.ok, false);
      if (again.ok) continue;
      assert.equal(
        again.error,
        "Couldn’t create your account. If you already have one, log in or continue with Google.",
      );
      assert.equal(again.error.toLowerCase().includes("already exists"), false);
      assert.equal(jar.get("rs_session"), undefined);
      assert.equal(countUsers(email), 1);
      const stored = getUserById(id);
      assert.equal(stored?.passwordHash, hash);
      assert.equal(stored?.emailVerifiedAt, verifiedStamp);
    }
  });

  it("keeps emailVerifiedAt when a verified account logs in with a password", async () => {
    const email = "verified-password-login@example.com";
    const signed = await signupFromForm(post("http://localhost/signup"), cookieJar().cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const verifiedAt = "2026-09-21T00:00:00.000Z";
    getDb().prepare("UPDATE users SET emailVerifiedAt = ? WHERE id = ?").run(verifiedAt, signed.user.id);
    const hash = getUserById(signed.user.id)?.passwordHash;
    assert.ok(hash);

    const logged = await loginFromForm(
      post("http://localhost/login"),
      cookieJar().cookies,
      passwordForm(`  ${email.toUpperCase()}  `),
    );
    assert.equal(logged.ok, true);
    const user = getUserById(signed.user.id);
    assert.equal(user?.emailVerifiedAt, verifiedAt);
    assert.equal(user?.passwordHash, hash);
  });
});
