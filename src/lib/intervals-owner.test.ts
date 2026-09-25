import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { getUserById, insertUser, upsertIntervalsConnection } from "./db.ts";
import {
  canUseIntervals,
  INTERVALS_NOT_FOR_ACCOUNT,
  intervalsOwnerDeniedResponse,
} from "./intervals.ts";
import { handleSettingsPost } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-owner-"));
process.env.AUTH_DATA_DIR = dataDir;

const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalKey = process.env.INTERVALS_ICU_API_KEY;
const originalFetch = globalThis.fetch;

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
});

describe("canUseIntervals", () => {
  it("fails closed when the allowlist is unset, empty, or only whitespace", () => {
    for (const value of [undefined, "", "   ", ",", " , "]) {
      if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
      else process.env.INTERVALS_OWNER_EMAILS = value;
      assert.equal(canUseIntervals({ email: "crispal94@gmail.com" }), false);
      assert.equal(canUseIntervals(null), false);
      assert.equal(canUseIntervals({ email: "  " }), false);
    }
  });

  it("matches allowlisted emails case-insensitively and trims whitespace", () => {
    process.env.INTERVALS_OWNER_EMAILS = "  CrisPal94@gmail.com , other@example.com  ";
    assert.equal(canUseIntervals({ email: "crispal94@gmail.com" }), true);
    assert.equal(canUseIntervals({ email: "  CRISPAL94@gmail.com  " }), true);
    assert.equal(canUseIntervals({ email: "other@example.com" }), true);
    assert.equal(canUseIntervals({ email: "nope@example.com" }), false);
  });
});

describe("connect/sync route", () => {
  it("rejects a non-owner with 403 and does not call Intervals", async () => {
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    process.env.INTERVALS_ICU_API_KEY = "owner-key-do-not-leak";
    const userId = "non-owner-route";
    const email = "runner@example.com";
    if (!getUserById(userId)) {
      insertUser({ id: userId, email, createdAt: "2026-09-01T00:00:00.000Z" });
    }
    upsertIntervalsConnection({
      userId,
      athleteId: "i704884",
      connectedAt: "2026-09-01T00:00:00.000Z",
    });

    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    });

    for (const intent of ["intervals-connect", "intervals-sync"] as const) {
      const denied = intervalsOwnerDeniedResponse({ email }, intent);
      assert.ok(denied);
      assert.equal(denied.status, 403);
      const body = await denied.text();
      assert.equal(body, INTERVALS_NOT_FOR_ACCOUNT);
      assert.equal(body.includes("INTERVALS_OWNER_EMAILS"), false);
      assert.equal(body.includes("INTERVALS_ICU"), false);

      const formData = new FormData();
      formData.set("intent", intent);
      const result = await handleSettingsPost(userId, formData);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.status, 403);
      assert.equal(result.error, INTERVALS_NOT_FOR_ACCOUNT);
      assert.equal(result.section, "intervals");
    }

    assert.equal(fetched, false);
    assert.equal(intervalsOwnerDeniedResponse({ email: "CrisPal94@gmail.com" }, "intervals-connect"), null);
    assert.equal(intervalsOwnerDeniedResponse({ email: "CrisPal94@gmail.com" }, "intervals-sync"), null);
  });
});
