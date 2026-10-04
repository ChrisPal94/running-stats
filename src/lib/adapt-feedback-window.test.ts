import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptFeedbackWindow } from "./adapt.ts";

describe("adaptFeedbackWindow", () => {
  it("daily window is yesterday through today", () => {
    assert.deepEqual(adaptFeedbackWindow("daily", "2026-09-30"), {
      start: "2026-09-29",
      end: "2026-09-30",
    });
  });

  it("daily lookback is exactly one day, not unbounded", () => {
    assert.equal(adaptFeedbackWindow("daily", "2026-10-01").start, "2026-09-30");

    // A feedback from several days ago must stay outside the window: the
    // nightly adaptation should not plan from a stale run.
    assert.equal(adaptFeedbackWindow("daily", "2026-10-05").start, "2026-10-04");
    assert.equal(adaptFeedbackWindow("daily", "2026-10-05").end, "2026-10-05");
  });

  it("daily window crosses month boundaries via the calendar helper", () => {
    assert.equal(adaptFeedbackWindow("daily", "2026-10-01").start, "2026-09-30");
    assert.equal(adaptFeedbackWindow("daily", "2026-09-01").start, "2026-08-31");
  });

  it("weekly window is unchanged: Monday of the current week through today", () => {
    // 2026-09-30 is a Wednesday; the week started Monday 2026-09-28.
    assert.deepEqual(adaptFeedbackWindow("weekly", "2026-09-30"), {
      start: "2026-09-28",
      end: "2026-09-30",
    });
  });

  it("monthly window is unchanged: first of the month through today", () => {
    assert.deepEqual(adaptFeedbackWindow("monthly", "2026-09-30"), {
      start: "2026-09-01",
      end: "2026-09-30",
    });
  });
});