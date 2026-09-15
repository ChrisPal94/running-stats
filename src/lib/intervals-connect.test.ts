import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  connectIntervals,
  INTERVALS_API_KEY_NOT_CONFIGURED,
  INTERVALS_CONNECT_ERROR,
} from "./intervals.ts";

const KEY_ENV = "INTERVALS_ICU_API_KEY";
const originalKey = process.env[KEY_ENV];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = originalKey;
});

describe("connectIntervals errors", () => {
  it("returns API key not configured when the env key is missing or empty", async () => {
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
