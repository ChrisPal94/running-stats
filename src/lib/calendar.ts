/** Civil calendar for “today” / the training week. Not UTC midnight. */
export const APP_TIME_ZONE = "America/Guayaquil";

/** Calendar “today” in America/Guayaquil (not UTC). */
export function appTodayYmd(now = new Date()): string {
  return calendarTodayYmd(now);
}

export function calendarTodayYmd(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Could not resolve ${APP_TIME_ZONE} calendar date.`);
  }
  return `${year}-${month}-${day}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Monday-start week that contains `ymd` (civil date). */
export function startOfWeekMonday(ymd: string): string {
  const day = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDaysYmd(ymd, offset);
}

export function endOfWeekSunday(ymd: string): string {
  return addDaysYmd(startOfWeekMonday(ymd), 6);
}

/**
 * Next instant when `hour` (0–23) occurs in America/Guayaquil.
 * Guayaquil is UTC−5 year-round (no DST).
 */
export function nextAppHourAt(hour: number, now = new Date()): Date {
  const ymd = appTodayYmd(now);
  const todayAt = appCivilDateTime(ymd, hour);
  if (now.getTime() < todayAt.getTime()) return todayAt;
  return appCivilDateTime(addDaysYmd(ymd, 1), hour);
}

export function appCivilDateTime(ymd: string, hour: number, minute = 0, second = 0): Date {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return new Date(`${ymd}T${hh}:${mm}:${ss}-05:00`);
}
