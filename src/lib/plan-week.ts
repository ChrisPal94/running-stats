import { addDaysYmd, startOfWeekMonday } from "./calendar";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type PlanWeekChoice = {
  weekStart: string;
  weekEnd: string;
  selectedDay: string;
  canPrev: boolean;
  canNext: boolean;
  prevWeek: string;
  nextWeek: string;
  isCurrentWeek: boolean;
};

function mondayInRange(ymd: string, minStart: string, maxStart: string): string | null {
  if (!YMD.test(ymd)) return null;
  const monday = startOfWeekMonday(ymd);
  if (monday < minStart || monday > maxStart) return null;
  return monday;
}

/** Which week and day Plan should show. Query values outside the plan are ignored. */
export function choosePlanWeek(input: {
  today: string;
  weekParam: string | null;
  dayParam: string | null;
  sessionDates: readonly string[];
}): PlanWeekChoice {
  const currentStart = startOfWeekMonday(input.today);
  const dates = input.sessionDates.filter((date) => YMD.test(date)).sort();
  const earliest = startOfWeekMonday(dates[0] ?? input.today);
  const latest = startOfWeekMonday(dates[dates.length - 1] ?? input.today);
  const minStart = earliest < currentStart ? earliest : currentStart;
  const maxStart = latest > currentStart ? latest : currentStart;
  const weekStart = mondayInRange(input.weekParam ?? "", minStart, maxStart) ?? currentStart;
  const weekEnd = addDaysYmd(weekStart, 6);
  const inWeek = (ymd: string) => ymd >= weekStart && ymd <= weekEnd;

  let selectedDay = dates.find(inWeek) ?? weekStart;
  if (inWeek(input.today)) selectedDay = input.today;
  if (input.dayParam && YMD.test(input.dayParam) && inWeek(input.dayParam)) {
    selectedDay = input.dayParam;
  }

  return {
    weekStart,
    weekEnd,
    selectedDay,
    canPrev: weekStart > minStart,
    canNext: weekStart < maxStart,
    prevWeek: addDaysYmd(weekStart, -7),
    nextWeek: addDaysYmd(weekStart, 7),
    isCurrentWeek: weekStart === currentStart,
  };
}

export function formatWeekRange(start: string, end: string): string {
  const day = (ymd: string, withMonth: boolean) =>
    new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString("en-US", {
      month: withMonth ? "short" : undefined,
      day: "numeric",
      timeZone: "UTC",
    });
  if (start.slice(0, 7) === end.slice(0, 7)) return `${day(start, true)} – ${day(end, false)}`;
  return `${day(start, true)} – ${day(end, true)}`;
}

export function planDayHref(weekStart: string, day: string): string {
  return `/plan?week=${weekStart}&day=${day}`;
}

export function planWeekHref(weekStart: string): string {
  return `/plan?week=${weekStart}`;
}
