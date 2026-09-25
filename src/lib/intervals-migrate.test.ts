import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "rs-intervals-migrate-"));
process.env.AUTH_DATA_DIR = dataDir;

const legacy = new DatabaseSync(join(dataDir, "app.db"));
legacy.exec(`CREATE TABLE intervals_connections (
  userId TEXT PRIMARY KEY,
  athleteId TEXT NOT NULL,
  connectedAt TEXT NOT NULL,
  lastSyncAt TEXT,
  lastSyncError TEXT
)`);
legacy.close();

const { ensureIntervalsConnectionColumns, getDb } = await import("./db.ts");

function columnNames(): Set<string> {
  return new Set(
    (getDb().prepare("PRAGMA table_info(intervals_connections)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("intervals connection migration", () => {
  it("adds apiKeyEnc and needsReconnect idempotently", () => {
    ensureIntervalsConnectionColumns(getDb());
    assert.equal(columnNames().has("apiKeyEnc"), true);
    assert.equal(columnNames().has("needsReconnect"), true);
    ensureIntervalsConnectionColumns(getDb());
    assert.equal(columnNames().has("apiKeyEnc"), true);
    assert.equal(columnNames().has("needsReconnect"), true);
  });
});
