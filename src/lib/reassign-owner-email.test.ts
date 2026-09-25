import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import type { AstroCookies } from "astro";
import { setGoogleOAuthState } from "./auth.ts";
import {
  getDb,
  getMagicTokenByHash,
  getUserByGoogleId,
  getUserById,
  insertMagicToken,
  insertUser,
  upsertIntervalsConnection,
} from "./db.ts";
import { finishGoogleOAuth } from "./google-oauth.ts";
import { reassignOwnerEmail } from "./reassign-owner-email.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-reassign-owner-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16chars";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.NODE_ENV = "test";

const originalGoogleId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
const originalGoogleCallback = process.env.GOOGLE_CALLBACK_URL;
const originalFetch = globalThis.fetch;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  if (originalGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleId;
  if (originalGoogleSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalGoogleSecret;
  if (originalGoogleCallback === undefined) delete process.env.GOOGLE_CALLBACK_URL;
  else process.env.GOOGLE_CALLBACK_URL = originalGoogleCallback;
});

function captureLogs(): string[] {
  const lines: string[] = [];
  mock.method(console, "error", (line: string) => {
    lines.push(String(line));
  });
  mock.method(console, "log", (line: string) => {
    lines.push(String(line));
  });
  return lines;
}

function userRow(id: string): {
  email: string;
  emailVerifiedAt: string | null;
  passwordHash: string | null;
  googleId: string | null;
} {
  return getDb()
    .prepare("SELECT email, emailVerifiedAt, passwordHash, googleId FROM users WHERE id = ?")
    .get(id) as {
    email: string;
    emailVerifiedAt: string | null;
    passwordHash: string | null;
    googleId: string | null;
  };
}

function userCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return Number(row.n);
}

function ownedIds(table: string, userId: string): string[] {
  const idColumn = table === "onboarding" || table === "intervals_connections" ? "userId" : "id";
  const rows = getDb().prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE userId = ?`).all(userId) as {
    id: string;
  }[];
  return rows.map((row) => row.id).sort();
}

function seedUser(id: string, email: string, extra: { passwordHash?: string; googleId?: string; emailVerifiedAt?: string } = {}): void {
  insertUser({
    id,
    email,
    createdAt: "2026-09-01T00:00:00.000Z",
    passwordHash: extra.passwordHash,
    googleId: extra.googleId,
    emailVerifiedAt: extra.emailVerifiedAt ?? null,
  });
}

function seedFromData(userId: string): void {
  const database = getDb();
  database
    .prepare("INSERT INTO onboarding (userId, updatedAt, planId) VALUES (?, ?, ?)")
    .run(userId, "2026-09-01T00:00:00.000Z", `${userId}-plan`);
  database
    .prepare(
      `INSERT INTO plans (id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson, feedbackCadence)
       VALUES (?, ?, 1, ?, '5k', NULL, 'beginner', '["mon"]', NULL, 'daily')`,
    )
    .run(`${userId}-plan`, userId, "2026-09-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO sessions (id, planId, userId, date, weekday, weekIndex, kind, title, cue, distanceKm)
       VALUES (?, ?, ?, '2026-09-01', 'mon', 0, 'easy', 'Easy', 'Stay easy', 6)`,
    )
    .run(`${userId}-session`, `${userId}-plan`, userId);
  database
    .prepare(
      "INSERT INTO feedbacks (id, userId, planId, sessionId, kind, createdAt) VALUES (?, ?, ?, ?, 'done', ?)",
    )
    .run(`${userId}-feedback`, userId, `${userId}-plan`, `${userId}-session`, "2026-09-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO run_logs (id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, createdAt, source)
       VALUES (?, ?, ?, ?, 6, 2100, 350, ?, 'manual')`,
    )
    .run(`${userId}-log`, userId, `${userId}-session`, `${userId}-plan`, "2026-09-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO adaptation_events (id, userId, planId, sessionId, date, title, summary, reason, createdAt)
       VALUES (?, ?, ?, ?, '2026-09-02', 'Plan adjusted', 'Shorter', 'Fatigue', ?)`,
    )
    .run(`${userId}-event`, userId, `${userId}-plan`, `${userId}-session`, "2026-09-02T00:00:00.000Z");
  upsertIntervalsConnection({
    userId,
    athleteId: "i123456",
    connectedAt: "2026-09-01T00:00:00.000Z",
  });
}

function addBlocker(kind: string, userId: string): void {
  const database = getDb();
  const stamp = "2026-09-03T00:00:00.000Z";
  if (kind === "onboarding") {
    database.prepare("INSERT INTO onboarding (userId, updatedAt) VALUES (?, ?)").run(userId, stamp);
    return;
  }
  if (kind === "plans") {
    database
      .prepare(
        `INSERT INTO plans (id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson, feedbackCadence)
         VALUES (?, ?, 1, ?, '5k', NULL, 'beginner', '[]', NULL, 'daily')`,
      )
      .run(`${userId}-plan`, userId, stamp);
    return;
  }
  if (kind === "sessions") {
    database
      .prepare(
        `INSERT INTO sessions (id, planId, userId, date, weekday, weekIndex, kind, title, cue, distanceKm)
         VALUES (?, 'plan', ?, '2026-09-03', 'tue', 0, 'easy', 'Easy', 'Cue', 3)`,
      )
      .run(`${userId}-session`, userId);
    return;
  }
  if (kind === "feedbacks") {
    database
      .prepare(
        "INSERT INTO feedbacks (id, userId, planId, sessionId, kind, createdAt) VALUES (?, ?, 'plan', 'session', 'skip', ?)",
      )
      .run(`${userId}-feedback`, userId, stamp);
    return;
  }
  if (kind === "runLogs") {
    database
      .prepare(
        `INSERT INTO run_logs (id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, createdAt, source)
         VALUES (?, ?, 'session', 'plan', 4, 1600, 400, ?, 'intervals')`,
      )
      .run(`${userId}-log`, userId, stamp);
    return;
  }
  if (kind === "adaptationEvents") {
    database
      .prepare(
        `INSERT INTO adaptation_events (id, userId, planId, date, title, summary, reason, createdAt)
         VALUES (?, ?, 'plan', '2026-09-03', 'Plan adjusted', 'Same', 'Note', ?)`,
      )
      .run(`${userId}-event`, userId, stamp);
    return;
  }
  upsertIntervalsConnection({ userId, athleteId: "i1", connectedAt: stamp });
}

describe("reassignOwnerEmail", () => {
  it("dry run prints the plan and changes nothing", () => {
    const fromId = "reassign-dry-from";
    const toId = "reassign-dry-to";
    const fromEmail = "owner.real@example.com";
    const toEmail = "owner.target@example.com";
    seedUser(fromId, "  Owner.Real@example.com ", {
      passwordHash: "scrypt:from",
      googleId: "dry-from-sub",
      emailVerifiedAt: "2026-09-02T00:00:00.000Z",
    });
    seedUser(toId, toEmail, { passwordHash: "scrypt:to", googleId: "dry-to-sub" });
    seedFromData(fromId);
    insertMagicToken({
      tokenHash: "dry-to-token",
      email: `  ${toEmail.toUpperCase()}  `,
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    insertMagicToken({
      tokenHash: "dry-from-token",
      email: fromEmail,
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    const beforeFrom = userRow(fromId);
    const beforeTo = userRow(toId);
    const beforeLogs = ownedIds("run_logs", fromId);
    const lines = captureLogs();

    const result = reassignOwnerEmail({
      from: "  OWNER.REAL@example.com ",
      to: "  Owner.Target@example.com ",
    });

    assert.equal(result.aborted, false);
    assert.equal(result.apply, false);
    assert.equal(result.fromId, fromId);
    assert.equal(result.toId, toId);
    assert.deepEqual(userRow(fromId), beforeFrom);
    assert.deepEqual(userRow(toId), beforeTo);
    assert.deepEqual(ownedIds("run_logs", fromId), beforeLogs);
    assert.equal(ownedIds("plans", toId).length, 0);
    assert.ok(getMagicTokenByHash("dry-to-token"));
    assert.ok(getMagicTokenByHash("dry-from-token"));
    assert.equal(lines.some((line) => line.includes(`from id=${fromId}`) && line.includes("plans=1") && line.includes("sessions=1") && line.includes("runLogs=1")), true);
    assert.equal(lines.some((line) => line.includes(`to id=${toId}`) && line.includes("deletable=yes") && line.includes("magicTokens=1")), true);
    assert.equal(
      lines.some((line) => line.includes("moveRows=no") && line.includes("emailVerifiedAt=null") && line.includes("googleId=unchanged")),
      true,
    );
    assert.equal(lines.includes("[reassign-owner-email] dry-run: nothing changed"), true);
    assert.equal(lines.some((line) => line.includes("schema migration")), false);
  });

  it("apply renames the from user, deletes an empty to user, and leaves the renamed user unverified", () => {
    const fromId = "reassign-apply-from";
    const toId = "reassign-apply-to";
    const toEmail = "apply-target@example.com";
    seedUser(fromId, "apply-real@example.com", {
      passwordHash: "scrypt:kept",
      googleId: "apply-old-sub",
      emailVerifiedAt: "2026-09-04T00:00:00.000Z",
    });
    seedUser(toId, "  Apply-Target@example.com ", {
      passwordHash: "scrypt:empty",
      googleId: "apply-to-sub",
    });
    seedFromData(fromId);
    insertMagicToken({
      tokenHash: "apply-to-token",
      email: "  APPLY-TARGET@example.com ",
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    insertMagicToken({
      tokenHash: "apply-from-token",
      email: "apply-real@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });

    const lines = captureLogs();
    const result = reassignOwnerEmail({
      from: "  Apply-Real@example.com ",
      to: "  Apply-Target@example.com ",
      apply: true,
    });

    assert.equal(result.aborted, false);
    assert.equal(result.apply, true);
    assert.equal(getUserById(toId), null);
    assert.equal(getUserByGoogleId("apply-to-sub"), null);
    assert.equal(getMagicTokenByHash("apply-to-token"), null);
    assert.ok(getMagicTokenByHash("apply-from-token"));
    const renamed = userRow(fromId);
    assert.equal(renamed.email, toEmail);
    assert.equal(renamed.emailVerifiedAt, null);
    assert.equal(renamed.passwordHash, "scrypt:kept");
    assert.equal(renamed.googleId, "apply-old-sub");
    assert.deepEqual(ownedIds("plans", fromId), [`${fromId}-plan`]);
    assert.deepEqual(ownedIds("sessions", fromId), [`${fromId}-session`]);
    assert.deepEqual(ownedIds("feedbacks", fromId), [`${fromId}-feedback`]);
    assert.deepEqual(ownedIds("run_logs", fromId), [`${fromId}-log`]);
    assert.deepEqual(ownedIds("adaptation_events", fromId), [`${fromId}-event`]);
    assert.deepEqual(ownedIds("onboarding", fromId), [fromId]);
    assert.deepEqual(ownedIds("intervals_connections", fromId), [fromId]);
    assert.equal(ownedIds("plans", toId).length, 0);
    assert.equal(lines.some((line) => line.includes(`deletedTo=${toId}`) && line.includes("magicTokens=1")), true);
    assert.equal(lines.some((line) => line.includes(`renamedUser=${fromId}`) && line.includes("emailVerifiedAt=null")), true);
  });

  it("aborts when the to user owns any userId table and leaves both accounts unchanged", () => {
    const kinds = ["onboarding", "plans", "sessions", "feedbacks", "runLogs", "adaptationEvents", "intervalsConnections"] as const;
    for (const kind of kinds) {
      for (const apply of [false, true]) {
        const fromId = `reassign-block-from-${kind}-${apply}`;
        const toId = `reassign-block-to-${kind}-${apply}`;
        const fromEmail = `block-from-${kind}-${apply}@example.com`;
        const toEmail = `block-to-${kind}-${apply}@example.com`;
        seedUser(fromId, fromEmail, { passwordHash: "scrypt:from", emailVerifiedAt: "2026-09-01T00:00:00.000Z" });
        seedUser(toId, toEmail, { passwordHash: "scrypt:to" });
        addBlocker(kind, toId);
        const beforeFrom = userRow(fromId);
        const beforeTo = userRow(toId);
        const lines = captureLogs();
        const result = reassignOwnerEmail({
          from: `  ${fromEmail.toUpperCase()}  `,
          to: `  ${toEmail.toUpperCase()}  `,
          apply,
        });
        assert.equal(result.aborted, true, kind);
        assert.equal(result.toId, toId);
        assert.deepEqual(userRow(fromId), beforeFrom);
        assert.deepEqual(userRow(toId), beforeTo);
        assert.equal(
          lines.some((line) => line.includes("aborted: to user is not empty") && line.includes(`${kind}=1`)),
          true,
          lines.join("\n"),
        );
        assert.equal(lines.includes("[reassign-owner-email] nothing changed"), true);
        mock.restoreAll();
      }
    }
  });

  it("aborts when the from user is missing", () => {
    const before = userCount();
    const lines = captureLogs();
    const result = reassignOwnerEmail({
      from: "  Missing.Owner@example.com ",
      to: "still-missing@example.com",
      apply: true,
    });
    assert.equal(result.aborted, true);
    assert.equal(result.fromId, null);
    assert.equal(userCount(), before);
    assert.equal(getUserById("still-missing@example.com"), null);
    assert.equal(lines.some((line) => line.includes("from user not found email=missing.owner@example.com")), true);
    assert.equal(lines.includes("[reassign-owner-email] nothing changed"), true);
  });

  it("aborts when from and to normalize to the same email", () => {
    const id = "reassign-same";
    seedUser(id, "same-owner@example.com", { passwordHash: "scrypt:same", emailVerifiedAt: "2026-09-01T00:00:00.000Z" });
    const before = userRow(id);
    const lines = captureLogs();
    const result = reassignOwnerEmail({
      from: "  Same-Owner@example.com ",
      to: "same-owner@example.com",
      apply: true,
    });
    assert.equal(result.aborted, true);
    assert.deepEqual(userRow(id), before);
    assert.equal(lines.some((line) => line.includes("same email")), true);
    assert.equal(lines.includes("[reassign-owner-email] nothing changed"), true);
  });

  it("verifies the renamed user on a later Google sign-in with the target email and keeps training rows", async () => {
    const fromId = "reassign-google-from";
    const toId = "reassign-google-to";
    const toEmail = "google-target@example.com";
    seedUser(fromId, "google-real@example.com", {
      passwordHash: "scrypt:kept",
      googleId: "google-old-sub",
      emailVerifiedAt: "2026-08-01T00:00:00.000Z",
    });
    seedUser(toId, toEmail, { passwordHash: "scrypt:shell", googleId: "google-owner-sub" });
    seedFromData(fromId);

    const applied = reassignOwnerEmail({
      from: "Google-Real@example.com",
      to: `  ${toEmail.toUpperCase()}  `,
      apply: true,
    });
    assert.equal(applied.aborted, false);
    assert.equal(userRow(fromId).email, toEmail);
    assert.equal(userRow(fromId).emailVerifiedAt, null);
    assert.equal(userRow(fromId).googleId, "google-old-sub");
    assert.equal(getUserById(toId), null);

    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
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
    } as unknown as AstroCookies;
    const nonce = setGoogleOAuthState(cookies, "login", "pkce-verifier-value");
    const profile = {
      sub: "google-owner-sub",
      email: `  ${toEmail.toUpperCase()}  `,
      email_verified: true,
    };
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/token")) return Response.json({ access_token: "access-token" });
      if (url.includes("userinfo")) return Response.json(profile);
      throw new Error(`unexpected fetch ${url}`);
    });
    const request = new Request(
      `http://localhost:4321/auth/google/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
    );
    const { location } = await finishGoogleOAuth(request, cookies);

    assert.equal(location, "/today");
    const verified = userRow(fromId);
    assert.equal(verified.email, toEmail);
    assert.ok(verified.emailVerifiedAt);
    assert.equal(verified.passwordHash, null);
    assert.equal(verified.googleId, "google-owner-sub");
    assert.equal(getUserById(toId), null);
    assert.equal(getUserByGoogleId("google-old-sub"), null);
    assert.equal(getUserByGoogleId("google-owner-sub")?.id, fromId);
    const emailHits = getDb()
      .prepare("SELECT id FROM users WHERE lower(trim(email)) = ?")
      .all(toEmail) as { id: string }[];
    assert.deepEqual(emailHits.map((row) => row.id), [fromId]);
    assert.deepEqual(ownedIds("plans", fromId), [`${fromId}-plan`]);
    assert.deepEqual(ownedIds("sessions", fromId), [`${fromId}-session`]);
    assert.deepEqual(ownedIds("run_logs", fromId), [`${fromId}-log`]);
    assert.deepEqual(ownedIds("feedbacks", fromId), [`${fromId}-feedback`]);
    assert.deepEqual(ownedIds("adaptation_events", fromId), [`${fromId}-event`]);
    assert.deepEqual(ownedIds("onboarding", fromId), [fromId]);
    assert.deepEqual(ownedIds("intervals_connections", fromId), [fromId]);
    const distance = getDb().prepare("SELECT distanceKm FROM sessions WHERE id = ?").get(`${fromId}-session`) as {
      distanceKm: number;
    };
    assert.equal(distance.distanceKm, 6);
  });
});
