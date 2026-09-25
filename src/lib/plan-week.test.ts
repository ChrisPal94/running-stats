import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choosePlanWeek, formatWeekRange, isRealCalendarYmd, planDayHref, planWeekRedirect } from "./plan-week.ts";

const dates = ["2026-09-22", "2026-09-24", "2026-09-26", "2026-10-01"];

describe("choosePlanWeek", () => {
  it("opens the current week on today", () => {
    const week = choosePlanWeek({
      today: "2026-09-24",
      weekParam: null,
      dayParam: null,
      sessionDates: dates,
    });
    assert.equal(week.weekStart, "2026-09-21");
    assert.equal(week.selectedDay, "2026-09-24");
    assert.equal(week.isCurrentWeek, true);
    assert.equal(week.canNext, true);
  });

  it("opens a tapped day inside that week", () => {
    const week = choosePlanWeek({
      today: "2026-09-24",
      weekParam: "2026-09-22",
      dayParam: "2026-09-22",
      sessionDates: dates,
    });
    assert.equal(week.weekStart, "2026-09-21");
    assert.equal(week.selectedDay, "2026-09-22");
  });

  it("moves to the next week and picks its first session", () => {
    const week = choosePlanWeek({
      today: "2026-09-24",
      weekParam: "2026-09-28",
      dayParam: null,
      sessionDates: dates,
    });
    assert.equal(week.weekStart, "2026-09-28");
    assert.equal(week.selectedDay, "2026-10-01");
    assert.equal(week.canNext, false);
    assert.equal(week.canPrev, true);
  });

  it("ignores a week outside the plan", () => {
    const week = choosePlanWeek({
      today: "2026-09-24",
      weekParam: "2020-01-06",
      dayParam: "2020-01-06",
      sessionDates: dates,
    });
    assert.equal(week.weekStart, "2026-09-21");
    assert.equal(week.selectedDay, "2026-09-24");
  });
});

describe("plan labels", () => {
  it("formats a week inside one month", () => {
    assert.equal(formatWeekRange("2026-09-21", "2026-09-27"), "Sep 21 – 27");
  });

  it("links a day to that week", () => {
    assert.equal(planDayHref("2026-09-21", "2026-09-22"), "/plan?week=2026-09-21&day=2026-09-22");
  });
});

describe("plan week query", () => {
  it("rejects dates that are not real calendar days", () => {
    for (const value of ["2026-13-01", "2026-09-32", "2026-00-10", "2026-09-00", "2026-99-99", "00-10", "99-99", "2026-02-29"]) {
      assert.equal(isRealCalendarYmd(value), false, value);
      assert.equal(planWeekRedirect(value, null), "/plan", value);
      assert.equal(planWeekRedirect(null, value), "/plan", value);
    }
  });

  it("accepts a real calendar date and leaves an in-range week alone", () => {
    assert.equal(isRealCalendarYmd("2026-09-24"), true);
    assert.equal(isRealCalendarYmd("2024-02-29"), true);
    assert.equal(planWeekRedirect("2026-09-21", "2026-09-24"), null);
    assert.equal(planWeekRedirect(null, null), null);
  });

  it("does not throw when the week is not a real date and falls back to this week", () => {
    const week = choosePlanWeek({
      today: "2026-09-24",
      weekParam: "2026-13-01",
      dayParam: "2026-09-32",
      sessionDates: dates,
    });
    assert.equal(week.weekStart, "2026-09-21");
    assert.equal(week.selectedDay, "2026-09-24");
  });
});
