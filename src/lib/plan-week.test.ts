import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choosePlanWeek, formatWeekRange, planDayHref } from "./plan-week.ts";

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
