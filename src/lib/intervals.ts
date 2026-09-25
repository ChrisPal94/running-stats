import { calendarTodayYmd } from "./calendar";
import {
  deleteIntervalsConnection,
  enqueueWrite,
  getIntervalsConnection as getStoredIntervalsConnection,
  getUserById,
  upsertIntervalsConnection,
  type IntervalsConnection,
} from "./db";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

export const INTERVALS_ICU_BASE_URL = "https://intervals.icu/api/v1";
/** Cloudflare 1010 without a stable UA. Must be sent on every Intervals HTTP call. */
export const INTERVALS_USER_AGENT = "RunningStatsMVP/0.1";
/** HTTP paths use `0` (athlete of the API key). Display fallback is Christian. */
export const INTERVALS_ATHLETE_PATH = "0";
export const DEFAULT_INTERVALS_ATHLETE_ID = "i704884";
export const INTERVALS_CONNECT_COPY = "API key stays on the server";
export const INTERVALS_SYNC_ERROR = "Couldn’t sync. Try again.";
export const INTERVALS_CONNECT_ERROR = "Couldn’t connect. Try again.";
export const INTERVALS_API_KEY_NOT_CONFIGURED = "API key not configured";
/** Shown when this account is not allowed to use the shared Intervals key. No env names. */
export const INTERVALS_NOT_FOR_ACCOUNT =
  "Intervals.icu import isn’t available for your account yet.";
/** Settings status line for an account that cannot use Intervals. No buttons. */
export const INTERVALS_UNAVAILABLE_STATUS = "Not available for your account";

const GATED_INTERVALS_INTENTS = new Set([
  "intervals-connect",
  "intervals-sync",
  "intervals-pick-run",
  "intervals-skip-pick",
]);
export const INTERVALS_NO_SESSION_TOAST = "No planned session that day";
export const INTERVALS_NO_NEW_RUNS_TOAST = "No new runs to import";
export const INTERVALS_COOPER_SYNC_TOAST = "Cooper test result synced — plan updated.";

export type IntervalsSyncToast = "no-session" | "no-new-runs" | "cooper" | null;

/**
 * Toast after Sync now when the Which run? picker is not shown.
 * Cooper wins when its result was applied. A successful import stays on the
 * silent success path even if another activity in the batch had no planned
 * session. No-session only when nothing was imported.
 */
export function intervalsSyncToast(input: {
  imported: number;
  skippedNoSession: number;
  cooperResolved?: boolean;
}): IntervalsSyncToast {
  if (input.cooperResolved) return "cooper";
  if (input.imported > 0) return null;
  if (input.skippedNoSession > 0) return "no-session";
  return "no-new-runs";
}

export function intervalsSyncToastRedirect(toast: IntervalsSyncToast): string {
  if (toast === "no-session") return "/settings?toast=no-session";
  if (toast === "no-new-runs") return "/settings?toast=no-new-runs";
  if (toast === "cooper") return "/settings?toast=cooper";
  return "/settings";
}

export function intervalsSyncToastCopy(toast: Exclude<IntervalsSyncToast, null>): string {
  if (toast === "no-session") return INTERVALS_NO_SESSION_TOAST;
  if (toast === "no-new-runs") return INTERVALS_NO_NEW_RUNS_TOAST;
  return INTERVALS_COOPER_SYNC_TOAST;
}

const FETCH_TIMEOUT_MS = 15_000;
const RUN_MIN_KM = 0.1;
const RUN_MAX_KM = 100;

export type IntervalsActivity = {
  id: string;
  start_date_local: string;
  distance?: number;
  moving_time?: number;
  average_speed?: number;
  type?: string;
  sport?: string;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  lthr?: number;
  athlete_max_hr?: number;
  icu_resting_hr?: number;
};

export type IntervalsRunStats = {
  activityId: string;
  date: string;
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  start_date_local: string;
  averageHr?: number;
  maxHr?: number;
  cadenceRpm?: number;
  lthr?: number;
  athleteMaxHr?: number;
  restingHr?: number;
};

export type RunEffort = {
  averageHr: number | null;
  maxHr: number | null;
  cadenceRpm: number | null;
  stepRateSpm: number | null;
  lthr: number | null;
  athleteMaxHr: number | null;
  restingHr: number | null;
};

export type IntervalsRunChoice = {
  date: string;
  sessionId: string;
  sessionDistanceKm: number;
  runs: IntervalsRunStats[];
  defaultActivityId: string;
};

export type IntervalsRunPickerState = {
  choice: IntervalsRunChoice;
  remaining: IntervalsRunChoice[];
  skippedNoSession: boolean;
  /** Runs already imported in this sync/pick flow, before this sheet. */
  imported: number;
};

export type IntervalsConnectionView =
  | {
      connected: false;
      statusLabel: "Not connected";
    }
  | {
      connected: true;
      athleteId: string;
      statusLabel: string;
      lastSyncAt?: string;
      lastSyncError?: string;
      lastSyncLabel: string | null;
    };

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Allowlist from `INTERVALS_OWNER_EMAILS`, trimmed and lowercased.
 * `null` when unset, blank, or with no addresses (fail closed).
 */
export function intervalsOwnerEmailAllowlist(): Set<string> | null {
  const raw = process.env.INTERVALS_OWNER_EMAILS;
  if (raw === undefined || raw.trim() === "") return null;
  const allow = new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
  if (allow.size === 0) return null;
  return allow;
}

export function hasVerifiedEmail(
  user: { emailVerifiedAt?: string | null } | null | undefined,
): boolean {
  return typeof user?.emailVerifiedAt === "string" && user.emailVerifiedAt.trim().length > 0;
}

/**
 * Shared Intervals key is owner-only.
 * Email match is trim + lowercase, and `emailVerifiedAt` must be set.
 * Missing verification fails closed (password signup does not set it).
 */
export function canUseIntervals(
  user: { email?: string | null; emailVerifiedAt?: string | null } | null | undefined,
): boolean {
  const email = user?.email?.trim().toLowerCase() ?? "";
  if (!email || !hasVerifiedEmail(user)) return false;
  const allow = intervalsOwnerEmailAllowlist();
  if (!allow) return false;
  return allow.has(email);
}

export function userCanUseIntervals(userId: string): boolean {
  return canUseIntervals(getUserById(userId));
}

/** Drop a stored connection when this account cannot use the shared key. */
export async function revokeUnownedIntervals(userId: string): Promise<void> {
  if (userCanUseIntervals(userId)) return;
  if (!getStoredIntervalsConnection(userId)) return;
  await enqueueWrite(() => {
    deleteIntervalsConnection(userId);
  });
}

/** Which Settings controls to show. Non-owners get the unavailable status and no buttons. */
export function intervalsSettingsControls(input: {
  available: boolean;
  connection: IntervalsConnectionView;
}): { statusLabel: string; showConnect: boolean; showSync: boolean } {
  if (!input.available) {
    return {
      statusLabel: INTERVALS_UNAVAILABLE_STATUS,
      showConnect: false,
      showSync: false,
    };
  }
  if (input.connection.connected) {
    return {
      statusLabel: input.connection.statusLabel,
      showConnect: false,
      showSync: true,
    };
  }
  return {
    statusLabel: input.connection.statusLabel,
    showConnect: true,
    showSync: false,
  };
}

/** 403 for Settings connect/sync (and Which run? follow-ups) when the account is not allowed. */
export function intervalsOwnerDeniedResponse(
  user: { email?: string | null; emailVerifiedAt?: string | null } | null | undefined,
  intent: string,
): Response | null {
  if (!GATED_INTERVALS_INTENTS.has(intent.trim())) return null;
  if (canUseIntervals(user)) return null;
  return new Response(INTERVALS_NOT_FOR_ACCOUNT, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function intervalsApiKey(): string | null {
  const key = envValue("INTERVALS_ICU_API_KEY");
  return key || null;
}

/** HTTP path athlete id. Always `0` with the personal API key. */
export function intervalsAthletePathId(): string {
  return INTERVALS_ATHLETE_PATH;
}

function displayAthleteId(resolved: string): string {
  if (resolved && resolved !== "0") return resolved;
  return envValue("INTERVALS_ICU_ATHLETE_ID") || DEFAULT_INTERVALS_ATHLETE_ID;
}

export function intervalsBasicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`, "utf8").toString("base64")}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
  }
  return null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function isIntervalsRun(activity: {
  type?: string;
  sport?: string;
}): boolean {
  const type = activity.type?.trim().toLowerCase() ?? "";
  const sport = activity.sport?.trim().toLowerCase() ?? "";
  return type === "run" || type === "virtualrun" || sport === "run" || sport === "virtualrun";
}

/** Civil day in America/Guayaquil from Intervals `start_date_local`. */
export function intervalsActivityDay(startDateLocal: string): string | null {
  const raw = startDateLocal.trim();
  if (!raw) return null;
  const prefix = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(prefix)) {
    if (raw.length === 10 || raw[10] === "T" || raw[10] === " ") return prefix;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return calendarTodayYmd(parsed);
}

export function parseIntervalsActivity(value: unknown): IntervalsActivity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = asId(record.id);
  const start =
    typeof record.start_date_local === "string"
      ? record.start_date_local
      : typeof record.startDateLocal === "string"
        ? record.startDateLocal
        : "";
  if (!id || !start) return null;
  const activity: IntervalsActivity = { id, start_date_local: start };
  const distance = asFiniteNumber(record.distance);
  if (distance !== null) activity.distance = distance;
  const moving = asFiniteNumber(record.moving_time) ?? asFiniteNumber(record.movingTime);
  if (moving !== null) activity.moving_time = moving;
  const speed = asFiniteNumber(record.average_speed) ?? asFiniteNumber(record.averageSpeed);
  if (speed !== null) activity.average_speed = speed;
  if (typeof record.type === "string") activity.type = record.type;
  if (typeof record.sport === "string") activity.sport = record.sport;
  const averageHr = asFiniteNumber(record.average_heartrate) ?? asFiniteNumber(record.averageHeartrate);
  if (averageHr !== null && averageHr > 0) activity.average_heartrate = averageHr;
  const maxHr = asFiniteNumber(record.max_heartrate) ?? asFiniteNumber(record.maxHeartrate);
  if (maxHr !== null && maxHr > 0) activity.max_heartrate = maxHr;
  const cadence = asFiniteNumber(record.average_cadence) ?? asFiniteNumber(record.averageCadence);
  if (cadence !== null && cadence > 0) activity.average_cadence = cadence;
  const lthr = asFiniteNumber(record.lthr);
  if (lthr !== null && lthr > 0) activity.lthr = lthr;
  const athleteMax = asFiniteNumber(record.athlete_max_hr) ?? asFiniteNumber(record.athleteMaxHr);
  if (athleteMax !== null && athleteMax > 0) activity.athlete_max_hr = athleteMax;
  const resting = asFiniteNumber(record.icu_resting_hr) ?? asFiniteNumber(record.icuRestingHr);
  if (resting !== null && resting > 0) activity.icu_resting_hr = resting;
  return activity;
}

export function intervalsActivityStats(activity: IntervalsActivity): IntervalsRunStats | null {
  if (!isIntervalsRun(activity)) return null;
  const date = intervalsActivityDay(activity.start_date_local);
  if (!date) return null;

  const distanceM = activity.distance ?? 0;
  if (!(distanceM > 0)) return null;
  const distanceKm = Math.round((distanceM / 1000) * 100) / 100;
  if (distanceKm < RUN_MIN_KM || distanceKm > RUN_MAX_KM) return null;

  let timeSec = 0;
  if (typeof activity.moving_time === "number" && activity.moving_time > 0) {
    timeSec = Math.round(activity.moving_time);
  } else if (typeof activity.average_speed === "number" && activity.average_speed > 0) {
    timeSec = Math.round(distanceM / activity.average_speed);
  }
  if (!(timeSec > 0)) return null;

  const paceSecPerKm = timeSec / distanceKm;
  if (!(paceSecPerKm > 0) || !Number.isFinite(paceSecPerKm)) return null;

  return {
    activityId: activity.id,
    date,
    distanceKm,
    timeSec,
    paceSecPerKm,
    start_date_local: activity.start_date_local,
    averageHr: activity.average_heartrate,
    maxHr: activity.max_heartrate,
    cadenceRpm: activity.average_cadence,
    lthr: activity.lthr,
    athleteMaxHr: activity.athlete_max_hr,
    restingHr: activity.icu_resting_hr,
  };
}

export function effortForDistance(runs: IntervalsRunStats[], distanceKm: number): RunEffort | null {
  const run = pickClosestRun(runs, distanceKm);
  if (!run) return null;
  const cadenceRpm = run.cadenceRpm && run.cadenceRpm > 0 ? run.cadenceRpm : null;
  return {
    averageHr: run.averageHr && run.averageHr > 0 ? run.averageHr : null,
    maxHr: run.maxHr && run.maxHr > 0 ? run.maxHr : null,
    cadenceRpm,
    stepRateSpm: cadenceRpm ? Math.round(cadenceRpm * 2) : null,
    lthr: run.lthr && run.lthr > 0 ? run.lthr : null,
    athleteMaxHr: run.athleteMaxHr && run.athleteMaxHr > 0 ? run.athleteMaxHr : null,
    restingHr: run.restingHr && run.restingHr > 0 ? run.restingHr : null,
  };
}

export type IntervalsStreamRoute = {
  coords: { lat: number; lng: number }[];
  samples: {
    distanceKm: number;
    timeSec: number;
    heartrate?: number;
    cadenceRpm?: number;
    altitudeM?: number;
  }[];
};

function streamNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function streamsRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const record: Record<string, unknown> = {};
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { type?: unknown; name?: unknown; data?: unknown };
      const key = typeof entry.type === "string" ? entry.type : typeof entry.name === "string" ? entry.name : "";
      if (!key) continue;
      if (Array.isArray(entry.data)) record[key] = entry.data;
    }
    return record;
  }
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

/** GPS line plus heart rate and one-foot cadence from an Intervals streams payload. */
export function routeFromIntervalsStreams(value: unknown): IntervalsStreamRoute | null {
  const record = streamsRecord(value);
  const latlng = Array.isArray(record.latlng) ? record.latlng : [];
  const time = Array.isArray(record.time) ? record.time : [];
  const heartrate = Array.isArray(record.heartrate) ? record.heartrate : [];
  const cadence = Array.isArray(record.cadence) ? record.cadence : [];
  const altitude = Array.isArray(record.altitude) ? record.altitude : [];
  const distance = Array.isArray(record.distance) ? record.distance : [];
  if (latlng.length < 2 && time.length < 2 && distance.length < 2) return null;

  const indexes: number[] = [];
  const step = Math.max(1, Math.ceil(latlng.length / 500));
  for (let index = 0; index < latlng.length; index += step) indexes.push(index);
  const last = latlng.length - 1;
  if (indexes[indexes.length - 1] !== last) indexes.push(last);

  const coords: IntervalsStreamRoute["coords"] = [];
  const samples: IntervalsStreamRoute["samples"] = [];
  let tracedKm = 0;
  let previous: { lat: number; lng: number } | null = null;
  for (const index of indexes) {
    const pair = latlng[index];
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lat = streamNumber(pair[0]);
    const lng = streamNumber(pair[1]);
    const timeSec = streamNumber(time[index]);
    if (lat === null || lng === null || timeSec === null || timeSec < 0) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const point = { lat, lng };
    if (previous) tracedKm += haversineKm(previous, point);
    previous = point;
    const distanceM = streamNumber(distance[index]);
    const sample: IntervalsStreamRoute["samples"][number] = {
      distanceKm: distanceM !== null && distanceM >= 0 ? Math.round((distanceM / 1000) * 1000) / 1000 : Math.round(tracedKm * 1000) / 1000,
      timeSec,
    };
    const hr = streamNumber(heartrate[index]);
    if (hr !== null && hr > 0) sample.heartrate = hr;
    const rpm = streamNumber(cadence[index]);
    if (rpm !== null && rpm > 0) sample.cadenceRpm = rpm;
    const alt = streamNumber(altitude[index]);
    if (alt !== null) sample.altitudeM = alt;
    coords.push(point);
    samples.push(sample);
  }
  if (coords.length >= 2) return { coords, samples };

  const count = Math.max(time.length, distance.length, heartrate.length, cadence.length);
  if (count < 2) return null;
  const seriesStep = Math.max(1, Math.ceil(count / 500));
  const series: IntervalsStreamRoute["samples"] = [];
  for (let index = 0; index < count; index += seriesStep) {
    const timeSec = streamNumber(time[index]);
    const distanceM = streamNumber(distance[index]);
    if (timeSec === null || timeSec < 0 || distanceM === null || distanceM < 0) continue;
    const sample: IntervalsStreamRoute["samples"][number] = {
      distanceKm: Math.round((distanceM / 1000) * 1000) / 1000,
      timeSec,
    };
    const hr = streamNumber(heartrate[index]);
    if (hr !== null && hr > 0) sample.heartrate = hr;
    const rpm = streamNumber(cadence[index]);
    if (rpm !== null && rpm > 0) sample.cadenceRpm = rpm;
    const alt = streamNumber(altitude[index]);
    if (alt !== null) sample.altitudeM = alt;
    series.push(sample);
  }
  const end = count - 1;
  if (series.length > 0 && streamNumber(time[end]) !== series[series.length - 1]?.timeSec) {
    const timeSec = streamNumber(time[end]);
    const distanceM = streamNumber(distance[end]);
    if (timeSec !== null && distanceM !== null) {
      const sample: IntervalsStreamRoute["samples"][number] = {
        distanceKm: Math.round((distanceM / 1000) * 1000) / 1000,
        timeSec,
      };
      const hr = streamNumber(heartrate[end]);
      if (hr !== null && hr > 0) sample.heartrate = hr;
      const rpm = streamNumber(cadence[end]);
      if (rpm !== null && rpm > 0) sample.cadenceRpm = rpm;
      series.push(sample);
    }
  }
  if (series.length < 2) return null;
  return { coords: [], samples: series };
}

export async function loadIntervalsRoute(activityId: string): Promise<IntervalsStreamRoute | null> {
  const apiKey = intervalsApiKey();
  if (!apiKey || !activityId.trim()) return null;
  try {
    const payload = await intervalsGet(
      apiKey,
      `/activity/${encodeURIComponent(activityId)}/streams?types=time,latlng,heartrate,cadence,altitude,distance`,
    );
    return routeFromIntervalsStreams(payload);
  } catch (error) {
    console.error("[intervals] stream fetch failed", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function loadRunEffort(date: string, distanceKm: number): Promise<RunEffort | null> {
  const apiKey = intervalsApiKey();
  if (!apiKey || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    const activities = await fetchIntervalsActivities(apiKey, intervalsAthletePathId(), date, date);
    const runs = activities
      .map(intervalsActivityStats)
      .filter((entry): entry is IntervalsRunStats => Boolean(entry));
    return effortForDistance(runs, distanceKm);
  } catch (error) {
    console.error("[intervals] effort fetch failed", error instanceof Error ? error.message : error);
    return null;
  }
}

export function pickClosestRun(runs: IntervalsRunStats[], targetKm: number): IntervalsRunStats | null {
  if (runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => {
    const da = Math.abs(a.distanceKm - targetKm);
    const db = Math.abs(b.distanceKm - targetKm);
    if (da !== db) return da - db;
    return a.start_date_local.localeCompare(b.start_date_local);
  });
  return sorted[0] ?? null;
}

export function formatRunDuration(timeSec: number): string {
  const safe = Math.max(0, Math.round(timeSec));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : mmss;
}

export function formatIntervalsRunChoiceLabel(run: IntervalsRunStats): string {
  const km = Math.round(run.distanceKm * 100) / 100;
  return `${km} km · ${formatRunDuration(run.timeSec)}`;
}

function isRunStats(value: unknown): value is IntervalsRunStats {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<IntervalsRunStats>;
  return (
    typeof record.activityId === "string" &&
    Boolean(record.activityId) &&
    typeof record.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
    typeof record.distanceKm === "number" &&
    record.distanceKm > 0 &&
    typeof record.timeSec === "number" &&
    record.timeSec > 0 &&
    typeof record.paceSecPerKm === "number" &&
    record.paceSecPerKm > 0 &&
    typeof record.start_date_local === "string"
  );
}

export function parseIntervalsRunChoice(value: unknown): IntervalsRunChoice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<IntervalsRunChoice>;
  if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return null;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  if (typeof record.sessionDistanceKm !== "number" || !(record.sessionDistanceKm > 0)) return null;
  if (!Array.isArray(record.runs)) return null;
  const runs = record.runs.filter(isRunStats);
  if (runs.length === 0) return null;
  const closest = pickClosestRun(runs, record.sessionDistanceKm);
  const defaultActivityId =
    typeof record.defaultActivityId === "string" && runs.some((run) => run.activityId === record.defaultActivityId)
      ? record.defaultActivityId
      : closest?.activityId;
  if (!defaultActivityId) return null;
  return {
    date: record.date,
    sessionId: record.sessionId,
    sessionDistanceKm: record.sessionDistanceKm,
    runs,
    defaultActivityId,
  };
}

export function parseIntervalsRunChoiceList(raw: string): IntervalsRunChoice[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseIntervalsRunChoice).filter((entry): entry is IntervalsRunChoice => Boolean(entry));
  } catch {
    return [];
  }
}

export function formatSyncedAgo(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Synced";
  const deltaSec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (deltaSec < 45) return "Synced just now";
  const mins = Math.round(deltaSec / 60);
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Synced ${days}d ago`;
}

export function getIntervalsConnection(userId: string): IntervalsConnection | null {
  const stored = getStoredIntervalsConnection(userId);
  if (!stored) return null;
  if (userCanUseIntervals(userId)) return stored;
  revokeUnownedIntervals(userId).catch((err) => console.error("[intervals] revoke unowned failed", err));
  return null;
}

export function getIntervalsConnectionView(userId: string, now = new Date()): IntervalsConnectionView {
  const connection = getStoredIntervalsConnection(userId);
  if (!connection) {
    return { connected: false, statusLabel: "Not connected" };
  }
  const lastSyncLabel = connection.lastSyncError
    ? INTERVALS_SYNC_ERROR
    : connection.lastSyncAt
      ? formatSyncedAgo(connection.lastSyncAt, now)
      : null;
  return {
    connected: true,
    athleteId: connection.athleteId,
    statusLabel: `Connected · ${connection.athleteId}`,
    lastSyncAt: connection.lastSyncAt,
    lastSyncError: connection.lastSyncError,
    lastSyncLabel,
  };
}

export type PlannedRunUpload = {
  externalId: string;
  date: string;
  name: string;
  description: string;
  distanceKm: number;
};

/** Plain-text Run workout for bulk upsert. `external_id` is the local session id. */
export function plannedRunEvent(workout: PlannedRunUpload): Record<string, unknown> | null {
  const externalId = workout.externalId.trim();
  if (!externalId || !/^\d{4}-\d{2}-\d{2}$/.test(workout.date)) return null;
  if (!(workout.distanceKm > 0)) return null;
  const name = workout.name.replace(/\s+/g, " ").trim() || "Run";
  const description = workout.description.replace(/\s+/g, " ").trim();
  return {
    category: "WORKOUT",
    external_id: externalId,
    start_date_local: `${workout.date}T08:00:00`,
    type: "Run",
    name,
    description,
    distance: Math.round(workout.distanceKm * 1000),
  };
}

export async function upsertPlannedRuns(
  workouts: PlannedRunUpload[],
  options: {
    apiKey?: string | null;
    fetchImpl?: typeof fetch;
    athletePathId?: string;
  } = {},
): Promise<{ uploaded: number; failed: number }> {
  const events = workouts
    .map(plannedRunEvent)
    .filter((event): event is Record<string, unknown> => Boolean(event));
  if (events.length === 0) return { uploaded: 0, failed: 0 };

  const apiKey = options.apiKey === undefined ? intervalsApiKey() : options.apiKey;
  if (!apiKey) return { uploaded: 0, failed: 0 };

  const fetchImpl = options.fetchImpl ?? fetch;
  const athletePathId = options.athletePathId ?? intervalsAthletePathId();
  try {
    const response = await fetchImpl(
      `${INTERVALS_ICU_BASE_URL}/athlete/${athletePathId}/events/bulk?upsert=true`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: intervalsBasicAuthHeader(apiKey),
          "User-Agent": INTERVALS_USER_AGENT,
        },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error(`[intervals] planned workout upsert HTTP ${response.status}`);
      return { uploaded: 0, failed: events.length };
    }
    return { uploaded: events.length, failed: 0 };
  } catch (error) {
    console.error(
      "[intervals] planned workout upsert failed",
      error instanceof Error ? error.message : error,
    );
    return { uploaded: 0, failed: events.length };
  }
}

async function intervalsGet(apiKey: string, path: string): Promise<unknown> {
  const url = `${INTERVALS_ICU_BASE_URL}${path}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: intervalsBasicAuthHeader(apiKey),
      "User-Agent": INTERVALS_USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`Intervals.icu ${response.status}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.json() as Promise<unknown>;
}

function pickAthleteId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return asId(record.id) ?? pickAthleteId(record.athlete);
}

export function parseIntervalsActivities(payload: unknown): IntervalsActivity[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { activities?: unknown }).activities)
      ? (payload as { activities: unknown[] }).activities
      : [];
  return list
    .map(parseIntervalsActivity)
    .filter((entry): entry is IntervalsActivity => Boolean(entry));
}

async function resolveAthleteId(apiKey: string, pathId: string): Promise<string> {
  const paths = [`/athlete/${encodeURIComponent(pathId)}`, `/athlete/${encodeURIComponent(pathId)}/profile`];
  for (const path of paths) {
    try {
      const payload = await intervalsGet(apiKey, path);
      const id = pickAthleteId(payload);
      if (id && id !== "0") return id;
    } catch {
      // Try the next probe; listing activities still validates the key.
    }
  }
  return displayAthleteId(pathId);
}

export async function fetchIntervalsActivities(
  apiKey: string,
  athleteId: string,
  oldest: string,
  newest: string,
): Promise<IntervalsActivity[]> {
  const params = new URLSearchParams({ oldest, newest });
  const payload = await intervalsGet(
    apiKey,
    `/athlete/${encodeURIComponent(athleteId)}/activities?${params.toString()}`,
  );
  return parseIntervalsActivities(payload);
}

export async function connectIntervals(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!userCanUseIntervals(userId)) {
    await revokeUnownedIntervals(userId);
    return { ok: false, error: INTERVALS_NOT_FOR_ACCOUNT };
  }
  const apiKey = intervalsApiKey();
  if (!apiKey) return { ok: false, error: INTERVALS_API_KEY_NOT_CONFIGURED };

  const pathId = intervalsAthletePathId();
  try {
    const today = calendarTodayYmd();
    await fetchIntervalsActivities(apiKey, pathId, today, today);
    const athleteId = displayAthleteId(await resolveAthleteId(apiKey, pathId));
    const connectedAt = new Date().toISOString();
    await enqueueWrite(() => {
      const existing = getStoredIntervalsConnection(userId);
      upsertIntervalsConnection({
        userId,
        athleteId,
        connectedAt: existing?.connectedAt ?? connectedAt,
        lastSyncAt: existing?.lastSyncAt,
        lastSyncError: undefined,
      });
    });
    return { ok: true };
  } catch (error) {
    console.error("[intervals] connect failed", error instanceof Error ? error.message : error);
    return { ok: false, error: INTERVALS_CONNECT_ERROR };
  }
}

export async function disconnectIntervals(userId: string): Promise<void> {
  await enqueueWrite(() => {
    deleteIntervalsConnection(userId);
  });
}

export async function markIntervalsSyncError(userId: string, message = INTERVALS_SYNC_ERROR): Promise<void> {
  await enqueueWrite(() => {
    const existing = getStoredIntervalsConnection(userId);
    if (!existing) return;
    upsertIntervalsConnection({
      ...existing,
      lastSyncError: message,
    });
  });
}

export async function markIntervalsSyncSuccess(userId: string, at = new Date().toISOString()): Promise<void> {
  await enqueueWrite(() => {
    const existing = getStoredIntervalsConnection(userId);
    if (!existing) return;
    upsertIntervalsConnection({
      ...existing,
      lastSyncAt: at,
      lastSyncError: undefined,
    });
  });
}

export async function loadIntervalsRunsForSync(
  oldest: string,
  newest: string,
): Promise<{ ok: true; runs: IntervalsRunStats[] } | { ok: false; error: string }> {
  const apiKey = intervalsApiKey();
  if (!apiKey) return { ok: false, error: INTERVALS_SYNC_ERROR };
  const pathId = intervalsAthletePathId();
  try {
    const activities = await fetchIntervalsActivities(apiKey, pathId, oldest, newest);
    const runs = activities
      .map(intervalsActivityStats)
      .filter((entry): entry is IntervalsRunStats => Boolean(entry))
      .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local) || a.activityId.localeCompare(b.activityId));
    return { ok: true, runs };
  } catch (error) {
    console.error("[intervals] sync fetch failed", error instanceof Error ? error.message : error);
    return { ok: false, error: INTERVALS_SYNC_ERROR };
  }
}
