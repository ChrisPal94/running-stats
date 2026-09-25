import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("schemaIsCurrent covers ensureColumn", () => {
  it("fails when a column ensured in db.ts is missing from schemaIsCurrent", () => {
    const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
    const listMatch = source.match(/const ENSURED_COLUMNS[\s\S]*?=\s*\[([\s\S]*?)\];/);
    assert.ok(listMatch, "ENSURED_COLUMNS list missing");
    const listed = [...listMatch[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    );
    assert.ok(listed.length > 0);

    const schemaStart = source.indexOf("function schemaIsCurrent");
    const schemaEnd = source.indexOf("function applySchema");
    assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
    const schemaFn = source.slice(schemaStart, schemaEnd);
    assert.match(schemaFn, /ENSURED_COLUMNS\.every\(\(\[table, column\]\)/);

    const calls = [...source.matchAll(/ensureColumn\(\s*database\s*,([^)]*)\)/g)].map((match) =>
      match[1].replace(/\s+/g, " ").trim(),
    );
    assert.ok(calls.length > 0);
    for (const call of calls) {
      const literal = call.match(/^"([^"]+)",\s*"([^"]+)"/);
      if (literal) {
        const key = `${literal[1]}.${literal[2]}`;
        assert.equal(listed.includes(key), true, `${key} is ensured but missing from schemaIsCurrent`);
        continue;
      }
      assert.equal(call, "table, column, ddl");
    }

    const applyStart = source.indexOf("function applySchema");
    const applyEnd = source.indexOf("export function migrateAppDatabase");
    assert.ok(applyStart >= 0 && applyEnd > applyStart);
    const applyFn = source.slice(applyStart, applyEnd);
    assert.match(applyFn, /for \(const \[table, column, ddl\] of ENSURED_COLUMNS\)/);
    assert.match(applyFn, /ensureColumn\(database, table, column, ddl\)/);
  });
});
