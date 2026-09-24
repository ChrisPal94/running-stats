import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { insertUser, listMagicTokensByEmail, saveTrainingSnapshot } from "./db.ts";
import {
  consumeMagicLink,
  hashMagicToken,
  isMagicLinkIntent,
  issueMagicLinkToken,
  MAGIC_INVALID_EMAIL,
  MAGIC_LINK_RESEND_MS,
  MAGIC_LINK_SUBJECT,
  MAGIC_LINK_TTL_MS,
  MAGIC_SEND_ERROR,
  magicExpiredLoginPath,
  magicLinkContinuePath,
  magicLinkExpiredToast,
  magicSignInUrl,
  requestMagicLink,
} from "./magic-link.ts";
import type { Plan } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-magic-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16+";
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
delete process.env.RESEND_API_KEY;
delete process.env.MAIL_FROM;
delete process.env.MAGIC_LINK_FROM;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

afterEach(() => {
  mock.restoreAll();
  process.env.NODE_ENV = "test";
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  delete process.env.MAGIC_LINK_FROM;
});

function captureLogs(): string[] {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  mock.method(console, "info", write);
  mock.method(console, "error", write);
  mock.method(console, "warn", write);
  mock.method(console, "log", write);
  return lines;
}

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function postRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function seedPlan(userId: string): Plan {
  const plan: Plan = {
    id: `${userId}-plan`,
    userId,
    version: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["mon", "wed", "fri"],
    feedbackCadence: "daily",
  };
  saveTrainingSnapshot({
    onboarding: [],
    plans: [plan],
    sessions: [],
    feedbacks: [],
    runLogs: [],
    adaptationEvents: [],
  });
  return plan;
}

describe("magic link request", () => {
  it("rejects an invalid email", async () => {
    const result = await requestMagicLink(
      postRequest("http://localhost:4321/login"),
      formData({ intent: "magic", email: "not-an-email" }),
    );
    assert.deepEqual(result, {
      ok: false,
      error: MAGIC_INVALID_EMAIL,
      email: "not-an-email",
    });
    assert.equal(MAGIC_INVALID_EMAIL, "Enter a valid email");
  });

  it("rejects a cross-site Origin", async () => {
    const result = await requestMagicLink(
      postRequest("http://localhost:4321/login", { origin: "https://evil.example" }),
      formData({ intent: "magic", email: "runner@example.com" }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /could not be verified/i);
    }
  });

  it("shows success and logs the sign-in URL when mail env is unset outside production", async () => {
    process.env.NODE_ENV = "development";
    const email = uniqueEmail("log");
    const lines = captureLogs();

    const request = postRequest("https://running-stats-production.up.railway.app/login", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "running-stats-production.up.railway.app",
    });
    const result = await requestMagicLink(request, formData({ intent: "magic", email }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sent, true);
      assert.equal(result.cooldownRemainingMs, MAGIC_LINK_RESEND_MS);
    }

    const logged = lines.find((line) => line.includes("/auth/magic?token="));
    assert.ok(logged, "expected the sign-in URL to be logged for QA");
    assert.match(logged, /^\[auth\] Magic sign-in URL for /);
    assert.match(logged, /https:\/\/running-stats-production\.up\.railway\.app\/auth\/magic\?token=/);
    assert.doesNotMatch(logged, /RESEND_API_KEY=|re_/);
    assert.equal(listMagicTokensByEmail(email).length, 1);
    assert.equal(listMagicTokensByEmail(email)[0]?.usedAt, undefined);
  });

  it("fails in production when mail is unset and never logs the token or link", async () => {
    process.env.NODE_ENV = "production";
    const email = uniqueEmail("prod-leak");
    const lines = captureLogs();

    const result = await requestMagicLink(
      postRequest("https://running-stats-production.up.railway.app/login", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "running-stats-production.up.railway.app",
      }),
      formData({ intent: "magic", email }),
    );

    assert.deepEqual(result, { ok: false, error: MAGIC_SEND_ERROR, email });
    assert.equal(MAGIC_SEND_ERROR, "Couldn’t send the link. Try again.");
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /token=/);
    assert.doesNotMatch(joined, /\/auth\/magic/);
    assert.doesNotMatch(joined, /RESEND_API_KEY=|re_/);
    assert.equal(listMagicTokensByEmail(email).length, 0);
  });

  it("stores a hash instead of the raw token", () => {
    const email = uniqueEmail("hash");
    const issued = issueMagicLinkToken(email);
    const stored = listMagicTokensByEmail(email)[0];
    assert.ok(stored);
    assert.equal(stored.tokenHash, hashMagicToken(issued.raw));
    assert.notEqual(stored.tokenHash, issued.raw);
  });

  it("enforces a 30s resend cooldown without issuing a second token", async () => {
    captureLogs();
    const email = uniqueEmail("cool");
    const now = Date.parse("2026-09-16T15:00:00.000Z");
    const request = postRequest("http://localhost:4321/login");
    const first = await requestMagicLink(request, formData({ intent: "magic", email }), { now });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.sent, true);

    const second = await requestMagicLink(request, formData({ intent: "magic", email }), {
      now: now + 5_000,
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.sent, false);
      assert.equal(second.cooldownRemainingMs, MAGIC_LINK_RESEND_MS - 5_000);
    }
    assert.equal(listMagicTokensByEmail(email).length, 1);
  });

  it("issues a new token after the cooldown and retires the previous unused one", async () => {
    captureLogs();
    const email = uniqueEmail("after-cool");
    const now = Date.parse("2026-09-16T16:00:00.000Z");
    const request = postRequest("http://localhost:4321/login");
    await requestMagicLink(request, formData({ intent: "magic", email }), { now });
    const firstHash = listMagicTokensByEmail(email)[0]?.tokenHash;
    const second = await requestMagicLink(request, formData({ intent: "magic", email }), {
      now: now + MAGIC_LINK_RESEND_MS,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.sent, true);
    const tokens = listMagicTokensByEmail(email);
    assert.equal(tokens.length, 2);
    const previous = tokens.find((token) => token.tokenHash === firstHash);
    const latest = tokens[0];
    assert.ok(previous?.usedAt);
    assert.equal(latest?.usedAt, undefined);
    assert.notEqual(latest?.tokenHash, firstHash);
  });

  it("returns Couldn’t send the link. Try again. when Resend fails", async () => {
    const lines = captureLogs();
    const email = uniqueEmail("fail");
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "coach@example.com";
    mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

    const result = await requestMagicLink(
      postRequest("http://localhost:4321/login"),
      formData({ intent: "magic", email }),
    );
    assert.deepEqual(result, { ok: false, error: MAGIC_SEND_ERROR, email });
    assert.equal(MAGIC_SEND_ERROR, "Couldn’t send the link. Try again.");
    assert.equal(listMagicTokensByEmail(email).length, 0);
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /token=/);
    assert.doesNotMatch(joined, /re_test_key/);
  });

  it("sends a Sign in mail through Resend when MAIL_FROM is set", async () => {
    captureLogs();
    const email = uniqueEmail("mail");
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "coach@example.com";
    process.env.MAGIC_LINK_FROM = "legacy@example.com";
    const bodies: unknown[] = [];
    mock.method(globalThis, "fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    });

    const result = await requestMagicLink(
      postRequest("http://localhost:4321/login"),
      formData({ intent: "magic", email }),
    );
    assert.equal(result.ok, true);
    const payload = bodies[0] as { subject?: string; html?: string; to?: string[]; from?: string };
    assert.equal(payload.subject, MAGIC_LINK_SUBJECT);
    assert.equal(MAGIC_LINK_SUBJECT, "Your Stride Lab sign-in link");
    assert.equal(payload.to?.[0], email);
    assert.equal(payload.from, "Stride Lab <coach@example.com>");
    assert.match(String(payload.html), />Sign in</);
    assert.match(String(payload.html), /\/auth\/magic\?token=/);
  });

  it("falls back to MAGIC_LINK_FROM when MAIL_FROM is unset", async () => {
    captureLogs();
    const email = uniqueEmail("legacy-from");
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAGIC_LINK_FROM = "legacy@example.com";
    const bodies: unknown[] = [];
    mock.method(globalThis, "fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    });

    const result = await requestMagicLink(
      postRequest("http://localhost:4321/login"),
      formData({ intent: "magic", email }),
    );
    assert.equal(result.ok, true);
    const payload = bodies[0] as { from?: string };
    assert.equal(payload.from, "Stride Lab <legacy@example.com>");
  });
});

describe("magic link consume", () => {
  it("rejects a missing or unknown token", async () => {
    assert.deepEqual(await consumeMagicLink(""), { ok: false, reason: "invalid" });
    assert.deepEqual(await consumeMagicLink("not-a-real-token"), { ok: false, reason: "invalid" });
  });
  it("rejects an expired token", async () => {
    const email = uniqueEmail("exp");
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const issued = issueMagicLinkToken(email, { now, ttlMs: MAGIC_LINK_TTL_MS });
    const result = await consumeMagicLink(issued.raw, { now: now + MAGIC_LINK_TTL_MS + 1 });
    assert.deepEqual(result, { ok: false, reason: "expired" });
  });

  it("is one-time use", async () => {
    const email = uniqueEmail("once");
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const issued = issueMagicLinkToken(email, { now });
    const first = await consumeMagicLink(issued.raw, { now: now + 1_000 });
    assert.equal(first.ok, true);
    const second = await consumeMagicLink(issued.raw, { now: now + 2_000 });
    assert.deepEqual(second, { ok: false, reason: "used" });
  });

  it("routes a new user to onboarding", async () => {
    const email = uniqueEmail("new");
    const issued = issueMagicLinkToken(email);
    const result = await consumeMagicLink(issued.raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.created, true);
      assert.equal(await magicLinkContinuePath(result.created, result.user.id), "/onboarding");
    }
  });

  it("routes a returning user without a plan to onboarding", async () => {
    const email = uniqueEmail("return-no-plan");
    insertUser({
      id: `user-${email}`,
      email,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const issued = issueMagicLinkToken(email);
    const result = await consumeMagicLink(issued.raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.created, false);
      assert.equal(await magicLinkContinuePath(result.created, result.user.id), "/onboarding");
    }
  });

  it("routes a returning user with a plan to /today", async () => {
    const email = uniqueEmail("return-plan");
    const userId = `user-${email}`;
    insertUser({
      id: userId,
      email,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    seedPlan(userId);
    const issued = issueMagicLinkToken(email);
    const result = await consumeMagicLink(issued.raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.created, false);
      assert.equal(await magicLinkContinuePath(result.created, result.user.id), "/today");
    }
  });
});

describe("magic link helpers", () => {
  it("builds HTTPS Railway sign-in URLs from publicOrigin", () => {
    const request = new Request("http://10.0.0.1:8080/login", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "running-stats-production.up.railway.app",
      },
    });
    assert.equal(
      magicSignInUrl(request, "tok_abc"),
      "https://running-stats-production.up.railway.app/auth/magic?token=tok_abc",
    );
  });

  it("maps used/expired clicks to the login toast", () => {
    assert.equal(magicExpiredLoginPath(), "/login?toast=magic-expired");
    const url = new URL("https://example.com/login?toast=magic-expired");
    assert.equal(magicLinkExpiredToast(url), "That link expired. Request a new one.");
  });

  it("detects the magic form intent", () => {
    assert.equal(isMagicLinkIntent(formData({ intent: "magic" })), true);
    assert.equal(isMagicLinkIntent(formData({ intent: "password" })), false);
    assert.equal(isMagicLinkIntent(formData({})), false);
  });
});
