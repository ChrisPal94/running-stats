import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { GET } from "../pages/api/intervals-sync.ts";
import {
  syncAllIntervalsUsers,
  type IntervalsBulkSyncDeps,
  type IntervalsBulkSyncResult,
  type IntervalsSyncResult,
} from "./intervals-sync-all.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-sync-all-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  ADAPT_CRON_SECRET: process.env.ADAPT_CRON_SECRET,
};
process.env.AUTH_DATA_DIR = dataDir;

const CRON_SECRET = "sync-all-cron-secret";

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  process.env.AUTH_DATA_DIR = dataDir;
  if (originalEnv.ADAPT_CRON_SECRET === undefined) delete process.env.ADAPT_CRON_SECRET;
  else process.env.ADAPT_CRON_SECRET = originalEnv.ADAPT_CRON_SECRET;
});

function okSyncResult(imported = 1, skippedNoSession = 0): IntervalsSyncResult {
  return {
    ok: true,
    imported,
    skippedNoSession,
    skippedManual: 0,
    pendingChoices: [],
    cooperResolved: false,
  };
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  }
  return lines;
}

function depsWithSync(
  sync: (userId: string) => Promise<IntervalsSyncResult>,
  userIds: string[],
): IntervalsBulkSyncDeps {
  return { sync, listUserIds: () => userIds };
}

/** Blocks any live Intervals.icu call from inside a test. */
function blockNetwork(): void {
  mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    const error = new Error(`offline fixture blocked ${url}`);
    error.name = "OfflineFixture";
    throw error;
  });
}

async function callSync(body: unknown): Promise<Response> {
  return GET({
    request: new Request("https://stride.test/api/intervals-sync", {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? { authorization: `Bearer ${CRON_SECRET}` }
          : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof GET>[0]);
}

describe("intervals sync-all", { concurrency: false }, () => {
  it("syncs every user, isolates a thrown middle sync, and sums successes", async () => {
    const calls: string[] = [];
    const sync = async (userId: string): Promise<IntervalsSyncResult> => {
      calls.push(userId);
      if (userId === "user-b") throw new Error("intervals down");
      if (userId === "user-a") return okSyncResult(2, 1);
      return okSyncResult(3, 0);
    };
    const lines = captureConsole();
    const result: IntervalsBulkSyncResult = await syncAllIntervalsUsers(
      depsWithSync(sync, ["user-a", "user-b", "user-c"]),
    );
    assert.deepEqual(calls, ["user-a", "user-b", "user-c"]);
    assert.equal(result.processed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.imported, 5);
    assert.equal(result.skippedNoSession, 1);
    assert.equal(lines.filter((line) => line.startsWith("[intervals] sync-all processed=3 imported=5 failed=1")).length, 1);
    assert.equal(lines.some((line) => line.includes("user-b")), false);
  });

  it("counts { ok: false } as failed without aborting the rest", async () => {
    const calls: string[] = [];
    const sync = async (userId: string): Promise<IntervalsSyncResult> => {
      calls.push(userId);
      if (userId === "user-a") return { ok: false, error: "upstream" };
      return okSyncResult(1, 0);
    };
    const result = await syncAllIntervalsUsers(depsWithSync(sync, ["user-a", "user-b"]));
    assert.deepEqual(calls, ["user-a", "user-b"]);
    assert.equal(result.processed, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.imported, 1);
  });

  it("processes 0 users when the list is empty", async () => {
    let called = 0;
    const sync = async (): Promise<IntervalsSyncResult> => {
      called += 1;
      return okSyncResult();
    };
    const result = await syncAllIntervalsUsers(depsWithSync(sync, []));
    assert.equal(called, 0);
    assert.deepEqual(result, { processed: 0, imported: 0, failed: 0, skippedNoSession: 0 });
  });
});

describe("GET/POST /api/intervals-sync", { concurrency: false }, () => {
  it("returns 503 when ADAPT_CRON_SECRET is not configured", async () => {
    delete process.env.ADAPT_CRON_SECRET;
    const response = await callSync(undefined);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()) as Record<string, unknown>, {
      error: "ADAPT_CRON_SECRET is not set",
    });
  });

  it("returns 401 when the bearer secret is wrong", async () => {
    process.env.ADAPT_CRON_SECRET = CRON_SECRET;
    const request = new Request("https://stride.test/api/intervals-sync", {
      method: "GET",
      headers: { authorization: "Bearer not-the-secret" },
    });
    const response = await GET({ request } as Parameters<typeof GET>[0]);
    assert.equal(response.status, 401);
    assert.deepEqual((await response.json()) as Record<string, unknown>, { error: "Unauthorized" });
  });

  it("returns 200 with counts for an authorized GET over an empty user list", async () => {
    process.env.ADAPT_CRON_SECRET = CRON_SECRET;
    blockNetwork();
    const response = await callSync(undefined);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.processed, 0);
    assert.equal(body.imported, 0);
    assert.equal(body.failed, 0);
  });
});
