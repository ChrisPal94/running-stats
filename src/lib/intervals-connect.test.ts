import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { getUserById, insertUser } from "./db.ts";
import {
  connectIntervals,
  INTERVALS_API_KEY_NOT_CONFIGURED,
  INTERVALS_ATHLETE_ID_INVALID,
  INTERVALS_CONNECT_ERROR,
  INTERVALS_CONNECT_INPUT,
  INTERVALS_CONNECT_REJECTED,
  INTERVALS_ENC_NOT_CONFIGURED,
  INTERVALS_USER_AGENT,
  intervalsBasicAuthHeader,
  intervalsEncryptionReady,
  normalizeIntervalsAthleteId,
} from "./intervals.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-connect-"));
process.env.AUTH_DATA_DIR = dataDir;

const KEY_ENV = "INTERVALS_ICU_API_KEY";
const OWNER_EMAIL = "owner-connect@example.com";
const originalKey = process.env[KEY_ENV];
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalFallback = process.env.INTERVALS_OWNER_ENV_FALLBACK;
const originalSecret = process.env.INTERVALS_KEY_ENC_SECRET;
const originalAthlete = process.env.INTERVALS_ICU_ATHLETE_ID;
const originalFetch = globalThis.fetch;

function allowOwner(userId: string): void {
  process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
  if (!getUserById(userId)) {
    insertUser({
      id: userId,
      email: OWNER_EMAIL,
      createdAt: "2026-09-01T00:00:00.000Z",
      emailVerifiedAt: "2026-09-01T00:00:00.000Z",
    });
  }
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = originalKey;
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
  if (originalFallback === undefined) delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
  else process.env.INTERVALS_OWNER_ENV_FALLBACK = originalFallback;
  if (originalSecret === undefined) delete process.env.INTERVALS_KEY_ENC_SECRET;
  else process.env.INTERVALS_KEY_ENC_SECRET = originalSecret;
  if (originalAthlete === undefined) delete process.env.INTERVALS_ICU_ATHLETE_ID;
  else process.env.INTERVALS_ICU_ATHLETE_ID = originalAthlete;
});

describe("connectIntervals errors", () => {
  it("does not use the env key unless the owner fallback flag is on", async () => {
    allowOwner("user-connect-test");
    delete process.env.INTERVALS_OWNER_ENV_FALLBACK;
    process.env[KEY_ENV] = "dummy-intervals-key";
    process.env.INTERVALS_ICU_ATHLETE_ID = "i704884";
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("no", { status: 401 });
    };

    const result = await connectIntervals("user-connect-test");
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_INPUT });
    assert.equal(fetchCalled, false);
  });

  it("returns API key not configured when owner fallback is on and the env key is missing", async () => {
    allowOwner("user-connect-test");
    process.env.INTERVALS_OWNER_ENV_FALLBACK = "true";
    process.env.INTERVALS_ICU_ATHLETE_ID = "i704884";
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = value;

      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("no", { status: 401 });
      };

      const result = await connectIntervals("user-connect-test");
      assert.deepEqual(result, { ok: false, error: INTERVALS_API_KEY_NOT_CONFIGURED });
      assert.equal(INTERVALS_API_KEY_NOT_CONFIGURED, "API key not configured");
      assert.equal(fetchCalled, false);
    }
  });

  it("returns a clear rejection when the athlete endpoint rejects the key", async () => {
    process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 4).toString("base64");
    const apiKey = "dummy-intervals-key";
    let auth = "";
    let agent = "";
    let url = "";
    globalThis.fetch = async (input, init) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization") ?? "";
      agent = headers.get("user-agent") ?? "";
      return new Response("unauthorized", { status: 401 });
    };

    const result = await connectIntervals("user-connect-test", { apiKey, athleteId: "i704884" });
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_REJECTED });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.includes(apiKey), false);
    assert.equal(url.endsWith("/athlete/i704884"), true);
    assert.equal(auth, intervalsBasicAuthHeader(apiKey));
    assert.equal(agent, INTERVALS_USER_AGENT);
  });

  it("returns Couldn’t connect. Try again. when the network fails", async () => {
    process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 4).toString("base64");
    const apiKey = "dummy-intervals-key";
    globalThis.fetch = async () => {
      throw new Error(`network down ${apiKey}`);
    };

    const result = await connectIntervals("user-connect-test", { apiKey, athleteId: "i704884" });
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_ERROR });
    if (!result.ok) assert.equal(result.error.includes(apiKey), false);
  });

  it("fails closed when the encryption secret is missing", async () => {
    delete process.env.INTERVALS_KEY_ENC_SECRET;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const result = await connectIntervals("user-connect-test", {
      apiKey: "dummy-intervals-key",
      athleteId: "i704884",
    });
    assert.deepEqual(result, { ok: false, error: INTERVALS_ENC_NOT_CONFIGURED });
    assert.equal(fetchCalled, false);
  });

  it("rejects athlete ids that contain ../, ?, or %2F before calling Intervals", async () => {
    process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 4).toString("base64");
    for (const athleteId of ["../i1", "i1?x", "i1%2F2", "i704884/../x", "%2F"]) {
      assert.equal(normalizeIntervalsAthleteId(athleteId), null);
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      };
      const result = await connectIntervals("user-connect-test", {
        apiKey: "dummy-intervals-key",
        athleteId,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, INTERVALS_ATHLETE_ID_INVALID);
      assert.equal(fetchCalled, false);
    }
  });

  it("treats a non-32-byte secret as missing, logs once, and does not crash", async () => {
    const lines: string[] = [];
    mock.method(console, "error", (line: string) => {
      lines.push(String(line));
    });
    process.env.INTERVALS_KEY_ENC_SECRET = "ab".repeat(32);
    const before = lines.length;
    assert.equal(intervalsEncryptionReady(), false);
    assert.equal(intervalsEncryptionReady(), false);
    const added = lines.slice(before);
    assert.equal(added.length, 1);
    assert.equal(added[0]?.includes("ab".repeat(32)), false);
    assert.match(added[0] ?? "", /encryption secret is not configured/);
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const result = await connectIntervals("user-connect-test", {
      apiKey: "dummy-intervals-key",
      athleteId: "i704884",
    });
    assert.deepEqual(result, { ok: false, error: INTERVALS_ENC_NOT_CONFIGURED });
    assert.equal(fetchCalled, false);
    mock.restoreAll();
  });
});
