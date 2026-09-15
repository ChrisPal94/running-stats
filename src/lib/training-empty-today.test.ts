import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_TODAY_COPY,
  SEE_THE_WEEK_CTA,
  formatNextRunHint,
  nextSessionAfterToday,
} from "./training.ts";

describe("empty Today copy", () => {
  it("keeps Peach empty-state strings verbatim", () => {
    assert.equal(EMPTY_TODAY_COPY, "No session today");
    assert.equal(SEE_THE_WEEK_CTA, "See the week");
    assert.equal(formatNextRunHint("2026-09-15"), "Next run: Tue");
  });

  it("picks the next Session after today and skips today", () => {
    const next = nextSessionAfterToday(
      [{ date: "2026-09-15" }, { date: "2026-09-17" }, { date: "2026-09-16" }],
      "2026-09-15",
    );
    assert.equal(next?.date, "2026-09-16");
  });

  it("omits a next Session when none exist after today", () => {
    assert.equal(nextSessionAfterToday([{ date: "2026-09-15" }, { date: "2026-09-10" }], "2026-09-15"), null);
    assert.equal(nextSessionAfterToday([], "2026-09-15"), null);
  });
});
