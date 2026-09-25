import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import {
  cleanupNonOwnerIntervalsRunLogs,
  parseCleanupCliArgs,
  PER_USER_INTERVALS_SINCE,
} from "./cleanup-intervals-nonowners.ts";
import {
  getDb,
  getUserById,
  insertUser,
  loadTrainingSnapshot,
  saveTrainingSnapshot,
  upsertIntervalsConnection,
  verifyUserEmail,
} from "./db.ts";
import type { RunLog } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-cleanup-intervals-"));
process.env.AUTH_DATA_DIR = dataDir;

const OWNER_ID = "cleanup-owner";
const OTHER_ID = "cleanup-other";
const UNVERIFIED_ID = "cleanup-unverified";
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;

function runLog(id: string, userId: string, source: "intervals" | "manual"): RunLog {
  return {
    id,
    userId,
    sessionId: `${id}-session`,
    planId: `${userId}-plan`,
    distanceKm: 5,
    timeSec: 1800,
    paceSecPerKm: 360,
    createdAt: "2026-09-01T00:00:00.000Z",
    source,
  };
}

function seedLogs(): void {
  if (!getUserById(OWNER_ID)) {
    insertUser({
      id: OWNER_ID,
      email: "  CrisPal94@gmail.com ",
      createdAt: "2026-09-01T00:00:00.000Z",
      emailVerifiedAt: "2026-09-02T00:00:00.000Z",
    });
  }
  if (!getUserById(OTHER_ID)) {
    insertUser({
      id: OTHER_ID,
      email: "Runner@Example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  if (!getUserById(UNVERIFIED_ID)) {
    insertUser({
      id: UNVERIFIED_ID,
      email: "second-owner@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: [],
      sessions: [],
      feedbacks: [],
      runLogs: [
        runLog("owner-intervals", OWNER_ID, "intervals"),
        runLog("owner-manual", OWNER_ID, "manual"),
        runLog("other-intervals-a", OTHER_ID, "intervals"),
        runLog("other-intervals-b", OTHER_ID, "intervals"),
        runLog("other-manual", OTHER_ID, "manual"),
        runLog("unverified-intervals", UNVERIFIED_ID, "intervals"),
      ],
      adaptationEvents: [],
    },
    "replace",
  );
}

function ids(): string[] {
  return loadTrainingSnapshot()
    .runLogs.map((entry) => entry.id)
    .sort();
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
});

function captureLogs(): string[] {
  const lines: string[] = [];
  mock.method(console, "error", (line: string) => {
    lines.push(line);
  });
  mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  return lines;
}

describe("cleanupNonOwnerIntervalsRunLogs", () => {
  it("aborts without deleting when INTERVALS_OWNER_EMAILS is unset or empty", () => {
    seedLogs();
    const before = ids();
    for (const value of [undefined, "", "   ", ",", " , "]) {
      for (const apply of [false, true]) {
        if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
        else process.env.INTERVALS_OWNER_EMAILS = value;
        const lines = captureLogs();
        const result = cleanupNonOwnerIntervalsRunLogs({ apply });
        assert.equal(result.aborted, true);
        assert.equal(result.apply, apply);
        assert.deepEqual(result.rows, []);
        assert.equal(lines.some((line) => line.includes("aborted") && line.includes("unset or empty")), true);
        assert.equal(lines.some((line) => line.includes("wouldDelete=")), false);
        mock.restoreAll();
      }
    }
    assert.deepEqual(ids(), before);
  });

  it("dry run reports per-user counts and --apply deletes only non-owner intervals RunLogs", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "CRISPAL94@gmail.com";
    const before = ids();
    const lines = captureLogs();

    const dry = cleanupNonOwnerIntervalsRunLogs();
    assert.equal(dry.aborted, false);
    assert.equal(dry.apply, false);
    const row = (userId: string) => dry.rows.find((entry) => entry.userId === userId);
    assert.equal(row(OTHER_ID)?.email, "Runner@Example.com");
    assert.equal(row(OTHER_ID)?.verified, false);
    assert.equal(row(OTHER_ID)?.wouldDelete, 2);
    assert.equal(row(OWNER_ID)?.email, "CrisPal94@gmail.com");
    assert.equal(row(OWNER_ID)?.verified, true);
    assert.equal(row(OWNER_ID)?.wouldDelete, 0);
    assert.equal(row(UNVERIFIED_ID)?.email, "second-owner@example.com");
    assert.equal(row(UNVERIFIED_ID)?.verified, false);
    assert.equal(row(UNVERIFIED_ID)?.wouldDelete, 1);
    assert.equal(dry.rows.reduce((sum, entry) => sum + entry.wouldDelete, 0), 3);
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] dry-run userId=${OTHER_ID} email=Runner@Example.com verified=no wouldDelete=2`,
      ),
      true,
    );
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] dry-run userId=${OWNER_ID} email=CrisPal94@gmail.com verified=yes wouldDelete=0`,
      ),
      true,
    );
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] dry-run userId=${UNVERIFIED_ID} email=second-owner@example.com verified=no wouldDelete=1`,
      ),
      true,
    );
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run total=3"), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run: nothing deleted"), true);
    assert.deepEqual(ids(), before);

    lines.length = 0;
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.apply, true);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(applied.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === UNVERIFIED_ID)?.wouldDelete, 1);
    const wouldAt = lines.findIndex((line) => line.includes(`userId=${OTHER_ID}`) && line.includes("wouldDelete=2"));
    const deletedAt = lines.findIndex((line) => line.includes(`userId=${OTHER_ID}`) && line.includes("deleted=2"));
    assert.equal(wouldAt >= 0 && deletedAt > wouldAt, true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=3"), true);
    assert.equal(lines.some((line) => line.startsWith("[cleanup:intervals-nonowners] apply") && line.includes("email=")), false);
    assert.equal(lines.some((line) => line.startsWith("[cleanup:intervals-nonowners] apply") && line.includes("@")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);

    lines.length = 0;
    const again = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(again.aborted, false);
    assert.equal(again.rows.every((row) => row.wouldDelete === 0), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=0"), true);
    assert.equal(
      lines.includes(`[cleanup:intervals-nonowners] apply userId=${OWNER_ID} wouldDelete=0`),
      true,
    );
    assert.equal(
      lines.includes(`[cleanup:intervals-nonowners] apply userId=${OWNER_ID} deleted=0`),
      true,
    );
    assert.equal(lines.some((line) => line.includes("email=")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);
  });

  it("leaves an account with its own connection, logs at the cutoff, and the owner untouched", () => {
    seedLogs();
    const connectedId = "cleanup-connected";
    if (!getUserById(connectedId)) {
      insertUser({
        id: connectedId,
        email: "connected@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    }
    upsertIntervalsConnection({
      userId: connectedId,
      athleteId: "i222222",
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: "v1:own-secret",
      authType: "apikey",
    });
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [],
        sessions: [],
        feedbacks: [],
        runLogs: [
          runLog("owner-intervals", OWNER_ID, "intervals"),
          runLog("owner-manual", OWNER_ID, "manual"),
          runLog("connected-old", connectedId, "intervals"),
          { ...runLog("other-old", OTHER_ID, "intervals"), createdAt: "2026-09-24T23:59:59.000Z" },
          { ...runLog("other-cutoff", OTHER_ID, "intervals"), createdAt: PER_USER_INTERVALS_SINCE },
          { ...runLog("other-after", OTHER_ID, "intervals"), createdAt: "2026-09-26T00:00:00.000Z" },
          runLog("other-manual", OTHER_ID, "manual"),
        ],
        adaptationEvents: [],
      },
      "replace",
    );
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const lines = captureLogs();
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.rows.find((row) => row.userId === connectedId)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 1);
    assert.equal(lines.some((line) => line.includes("wouldDelete=1")), true);
    assert.equal(lines.some((line) => line.includes("deleted=1")), true);
    assert.deepEqual(ids(), [
      "connected-old",
      "other-after",
      "other-cutoff",
      "other-manual",
      "owner-intervals",
      "owner-manual",
    ]);
  });

  it("honors --before and aborts on an invalid cutoff without deleting", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const before = ids();
    const kept = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: "2026-01-01T00:00:00.000Z" });
    assert.equal(kept.aborted, false);
    assert.equal(kept.rows.every((row) => row.wouldDelete === 0), true);
    assert.deepEqual(ids(), before);

    const lines = captureLogs();
    const bad = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: "yesterday" });
    assert.equal(bad.aborted, true);
    assert.deepEqual(bad.rows, []);
    assert.equal(lines.some((line) => line.includes("--before") && line.includes("no RunLogs deleted")), true);
    assert.deepEqual(ids(), before);
  });

  it("rejects impossible and future --before values and accepts a round-tripped YYYY-MM-DD", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const before = ids();
    for (const value of ["2026-02-30", "2026-02-30T00:00:00.000Z", "2026-02-29", "2026-04-31T00:00:00.000Z"]) {
      const lines = captureLogs();
      const bad = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: value });
      assert.equal(bad.aborted, true);
      assert.deepEqual(bad.rows, []);
      assert.equal(
        lines.some((line) => line.includes("YYYY-MM-DD") && line.includes("no RunLogs deleted")),
        true,
      );
      mock.restoreAll();
    }
    for (const value of ["2099-01-01", "2099-01-01T00:00:00.000Z"]) {
      const lines = captureLogs();
      const future = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: value });
      assert.equal(future.aborted, true);
      assert.deepEqual(future.rows, []);
      assert.equal(lines.some((line) => line.includes("in the future") && line.includes("no RunLogs deleted")), true);
      mock.restoreAll();
    }
    assert.deepEqual(ids(), before);

    const kept = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: "2026-01-01" });
    assert.equal(kept.aborted, false);
    assert.equal(kept.rows.every((row) => row.wouldDelete === 0), true);
    assert.deepEqual(ids(), before);

    const leap = cleanupNonOwnerIntervalsRunLogs({ before: "2024-02-29" });
    assert.equal(leap.aborted, false);

    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/jobs/cleanup-intervals-nonowners.ts", "--before", "2026-02-30"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUTH_DATA_DIR: dataDir,
          INTERVALS_OWNER_EMAILS: "crispal94@gmail.com",
        },
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 1);
    assert.match(`${cli.stderr}`, /YYYY-MM-DD/);
    assert.match(`${cli.stderr}`, /no RunLogs deleted/);
    assert.deepEqual(ids(), before);
  });

  it("accepts --before=YYYY-MM-DD and exits 1 on an unknown or malformed flag", () => {
    assert.deepEqual(parseCleanupCliArgs(["--before", "2026-01-01"]), {
      ok: true,
      apply: false,
      before: "2026-01-01",
    });
    assert.deepEqual(parseCleanupCliArgs(["--apply", "--before=2026-09-25T00:00:00.000Z"]), {
      ok: true,
      apply: true,
      before: "2026-09-25T00:00:00.000Z",
    });
    assert.deepEqual(parseCleanupCliArgs([]), { ok: true, apply: false, before: undefined });
    for (const argv of [["--before"], ["--before="], ["--before", "--apply"], ["--bogus"], ["--apply", "--bogus"]]) {
      assert.deepEqual(parseCleanupCliArgs(argv), { ok: false });
    }

    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const before = ids();
    const spawnCli = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/jobs/cleanup-intervals-nonowners.ts", ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUTH_DATA_DIR: dataDir,
          INTERVALS_OWNER_EMAILS: "crispal94@gmail.com",
        },
        encoding: "utf8",
      });

    const accepted = spawnCli(["--apply", "--before=2026-01-01"]);
    assert.equal(accepted.status, 0);
    assert.deepEqual(ids(), before);

    const impossible = spawnCli(["--apply", "--before=2026-02-30"]);
    assert.equal(impossible.status, 1);
    assert.match(`${impossible.stderr}`, /YYYY-MM-DD/);
    assert.match(`${impossible.stderr}`, /no RunLogs deleted/);
    assert.equal(`${impossible.stderr}`.includes("unknown or malformed"), false);
    assert.deepEqual(ids(), before);

    for (const args of [["--before"], ["--before="], ["--bogus"], ["--apply", "--not-a-flag"]]) {
      const rejected = spawnCli(args);
      assert.equal(rejected.status, 1);
      assert.match(`${rejected.stderr}`, /unknown or malformed/);
      assert.match(`${rejected.stderr}`, /no RunLogs deleted/);
      assert.deepEqual(ids(), before);
    }
  });

  it("logs deleted= from sqlite changes when a planned row is not removed", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    getDb().exec(`
      CREATE TRIGGER skip_raced_intervals BEFORE DELETE ON run_logs
      WHEN OLD.id = 'other-intervals-a'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    try {
      const lines = captureLogs();
      const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
      assert.equal(applied.aborted, false);
      assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
      assert.equal(lines.includes(`[cleanup:intervals-nonowners] apply userId=${OTHER_ID} wouldDelete=2`), true);
      assert.equal(lines.includes(`[cleanup:intervals-nonowners] apply userId=${OTHER_ID} deleted=1`), true);
      assert.equal(lines.includes(`[cleanup:intervals-nonowners] apply userId=${OTHER_ID} deleted=2`), false);
      assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=2"), true);
      assert.equal(ids().includes("other-intervals-a"), true);
      assert.equal(ids().includes("other-intervals-b"), false);
      assert.equal(ids().includes("unverified-intervals"), false);
    } finally {
      getDb().exec("DROP TRIGGER IF EXISTS skip_raced_intervals");
    }
  });

  it("aborts apply when an allowlisted account is unverified and deletes nothing", () => {
    seedPendingOwner();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com, pending-owner@example.com";
    const before = ids();
    const lines = captureLogs();
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, true);
    assert.equal(applied.apply, true);
    assert.deepEqual(applied.rows, []);
    assert.deepEqual(lines, [
      `[cleanup:intervals-nonowners] aborted: allowlisted account userId=${PENDING_ID} is not verified yet. Sign in with Google first. No RunLogs deleted.`,
    ]);
    assert.equal(lines.some((line) => line.includes("@")), false);
    assert.equal(lines.some((line) => line.includes("wouldDelete=") || line.includes("deleted=")), false);
    assert.deepEqual(ids(), before);
    assert.equal(before.includes("other-intervals-a"), true);
    assert.equal(before.includes("pending-intervals"), true);
  });

  it("dry-run warns and omits a pending owner's logs", () => {
    seedPendingOwner();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com, pending-owner@example.com";
    const before = ids();
    const lines = captureLogs();
    const dry = cleanupNonOwnerIntervalsRunLogs();
    assert.equal(dry.aborted, false);
    assert.equal(dry.apply, false);
    assert.equal(dry.rows.some((row) => row.userId === PENDING_ID), false);
    assert.equal(dry.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(dry.rows.find((row) => row.userId === UNVERIFIED_ID)?.wouldDelete, 1);
    assert.equal(dry.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(dry.rows.reduce((sum, row) => sum + row.wouldDelete, 0), 3);
    const warningAt = lines.findIndex((line) => line.startsWith("[cleanup:intervals-nonowners] warning:"));
    const rowAt = lines.findIndex((line) => line.includes("dry-run userId="));
    assert.equal(
      lines[warningAt],
      `[cleanup:intervals-nonowners] warning: allowlisted account userId=${PENDING_ID} is not verified yet. --apply will abort until that account is verified.`,
    );
    assert.equal(warningAt >= 0 && rowAt > warningAt, true);
    assert.equal(lines.some((line) => line.includes(PENDING_ID) && line.includes("wouldDelete=")), false);
    assert.equal(lines[warningAt]?.includes("@"), false);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run total=3"), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run: nothing deleted"), true);
    assert.deepEqual(ids(), before);
  });

  it("does not abort when an allowlisted email has no account", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com, missing-owner@example.com";
    const lines = captureLogs();
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.apply, true);
    assert.equal(lines.some((line) => line.includes("not verified yet")), false);
    assert.equal(lines.some((line) => line.includes("missing-owner@example.com")), false);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(applied.rows.find((row) => row.userId === UNVERIFIED_ID)?.wouldDelete, 1);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=3"), true);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);
  });

  it("applies normally after the pending owner is verified", () => {
    seedPendingOwner();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com, pending-owner@example.com";
    assert.equal(verifyUserEmail(PENDING_ID, "2026-09-25T12:00:00.000Z"), true);
    const lines = captureLogs();
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.apply, true);
    assert.equal(applied.rows.find((row) => row.userId === PENDING_ID)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === PENDING_ID)?.verified, true);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(applied.rows.find((row) => row.userId === UNVERIFIED_ID)?.wouldDelete, 1);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=3"), true);
    assert.equal(lines.some((line) => line.includes("not verified yet")), false);
    assert.equal(ids().includes("pending-intervals"), true);
    assert.equal(ids().includes("owner-intervals"), true);
    assert.equal(ids().includes("other-intervals-a"), false);
    assert.equal(ids().includes("unverified-intervals"), false);
  });
});

const PENDING_ID = "cleanup-pending";

function seedPendingOwner(): void {
  seedLogs();
  if (!getUserById(PENDING_ID)) {
    insertUser({
      id: PENDING_ID,
      email: "  Pending-Owner@Example.com ",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  const snapshot = loadTrainingSnapshot();
  saveTrainingSnapshot(
    {
      ...snapshot,
      runLogs: [...snapshot.runLogs, runLog("pending-intervals", PENDING_ID, "intervals")],
    },
    "replace",
  );
}
