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
legacy
  .prepare(
    `INSERT INTO intervals_connections (userId, athleteId, connectedAt) VALUES (?, ?, ?)`,
  )
  .run("legacy-user", "i704884", "2026-09-01T00:00:00.000Z");
legacy.close();

const { ensureIntervalsConnectionColumns, getDb, getIntervalsConnection } = await import("./db.ts");

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
  it("adds oauth columns idempotently and keeps an existing row usable", () => {
    ensureIntervalsConnectionColumns(getDb());
    for (const name of ["apiKeyEnc", "needsReconnect", "authType", "scope", "athleteName"]) {
      assert.equal(columnNames().has(name), true);
    }
    ensureIntervalsConnectionColumns(getDb());
    for (const name of ["apiKeyEnc", "needsReconnect", "authType", "scope", "athleteName"]) {
      assert.equal(columnNames().has(name), true);
    }
    const stored = getIntervalsConnection("legacy-user");
    assert.equal(stored?.athleteId, "i704884");
    assert.equal(stored?.authType, "apikey");
    assert.equal(stored?.athleteName, undefined);
    assert.equal(stored?.apiKeyEnc, undefined);
  });
});
