import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shortWeekdayEn } from "./calendar.ts";

describe("shortWeekdayEn", () => {
  it("returns short EN weekday for a Guayaquil civil date", () => {
    assert.equal(shortWeekdayEn("2026-09-15"), "Tue");
    assert.equal(shortWeekdayEn("2026-09-16"), "Wed");
    assert.equal(shortWeekdayEn("2026-09-20"), "Sun");
    assert.equal(shortWeekdayEn("2026-09-21"), "Mon");
  });
});
