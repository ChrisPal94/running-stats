import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { getUserById, insertUser } from "./db.ts";
import {
  connectIntervals,
  INTERVALS_API_KEY_NOT_CONFIGURED,
  INTERVALS_CONNECT_ERROR,
} from "./intervals.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-connect-"));
process.env.AUTH_DATA_DIR = dataDir;

const KEY_ENV = "INTERVALS_ICU_API_KEY";
const OWNER_EMAIL = "owner-connect@example.com";
const originalKey = process.env[KEY_ENV];
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalFetch = globalThis.fetch;

function allowOwner(userId: string): void {
  process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
  if (!getUserById(userId)) {
    insertUser({
      id: userId,
      email: OWNER_EMAIL,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = originalKey;
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
});

describe("connectIntervals errors", () => {
  it("returns API key not configured when the env key is missing or empty", async () => {
    allowOwner("user-connect-test");
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

  it("returns Couldn’t connect. Try again. when Intervals HTTP fails", async () => {
    allowOwner("user-connect-test");
    process.env[KEY_ENV] = "dummy-intervals-key";
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

    const result = await connectIntervals("user-connect-test");
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_ERROR });
    assert.equal(INTERVALS_CONNECT_ERROR, "Couldn’t connect. Try again.");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.includes("dummy-intervals-key"), false);
    }
  });

  it("returns Couldn’t connect. Try again. when the network fails", async () => {
    allowOwner("user-connect-test");
    process.env[KEY_ENV] = "dummy-intervals-key";
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const result = await connectIntervals("user-connect-test");
    assert.deepEqual(result, { ok: false, error: INTERVALS_CONNECT_ERROR });
    if (!result.ok) {
      assert.equal(result.error.includes("dummy-intervals-key"), false);
    }
  });
});
