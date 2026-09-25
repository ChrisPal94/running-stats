import { calendarTodayYmd } from "./calendar";
import {
  deleteIntervalsConnection,
  enqueueWrite,
  getIntervalsConnection as getStoredIntervalsConnection,
  getUserById,
  readEmailVerifiedAt,
  upsertIntervalsConnection,
  type IntervalsConnection,
} from "./db";
import {
  decryptIntervalsApiKey,
  encryptIntervalsApiKey,
  INTERVALS_ENC_NOT_CONFIGURED,
  intervalsEncryptionReady,
  IntervalsDecryptError,
  IntervalsEncryptionError,
} from "./intervals-crypto";
import type { IntervalsAuthType } from "./db";
import { loadLocalEnv } from "./load-env";
import { isSameOrigin } from "./public-origin";

loadLocalEnv();

export const INTERVALS_ICU_BASE_URL = "https://intervals.icu/api/v1";
/** Cloudflare 1010 without a stable UA. Must be sent on every Intervals HTTP call. */
export const INTERVALS_USER_AGENT = "RunningStatsMVP/0.1";
export const INTERVALS_CONNECT_COPY = "Your API key is encrypted and never shown again.";
export const INTERVALS_SYNC_ERROR = "Couldn’t sync. Try again.";
export const INTERVALS_CONNECT_ERROR = "Couldn’t connect. Try again.";
export const INTERVALS_CONNECT_INPUT = "Enter your Intervals API key and athlete ID.";
export const INTERVALS_ATHLETE_ID_INVALID = "Enter an athlete ID like i704884.";
export const INTERVALS_CONNECT_REJECTED = "Couldn’t connect. Check your API key and athlete ID.";
export const INTERVALS_ACCESS_EXPIRED = "Intervals access expired";
/** 401/403 and a stored secret that will not decrypt. Same copy as the Settings status. */
export const INTERVALS_RECONNECT_ERROR = INTERVALS_ACCESS_EXPIRED;
export const INTERVALS_API_KEY_NOT_CONFIGURED = "API key not configured";
export const INTERVALS_OAUTH_CONNECT_ERROR = "Couldn’t connect to Intervals. Try again.";
export const INTERVALS_CONNECTED_TOAST = "Intervals connected";
export const INTERVALS_CONNECT_UNAVAILABLE =
  "Connecting Intervals.icu isn’t available right now. Try again later.";
export const INTERVALS_OAUTH_CONNECT_BUTTON = "Connect Intervals.icu";
export const INTERVALS_OAUTH_CONNECT_LINE =
  "We import your runs and add planned workouts to your Intervals calendar.";
export const INTERVALS_KEY_HELP = "Your API key and athlete ID are in Intervals Settings > Developer.";
export const INTERVALS_KEY_HELP_URL = "https://intervals.icu/settings";
export { INTERVALS_ENC_NOT_CONFIGURED, intervalsEncryptionReady };
export type { IntervalsAuthType };
/** Settings status line when this account cannot connect or use the env fallback. No buttons. */
export const INTERVALS_UNAVAILABLE_STATUS = "Not available for your account";
/** 403 body when an Intervals action is not allowed for this account. No env names. */
export const INTERVALS_NOT_FOR_ACCOUNT =
  "Intervals.icu import isn’t available for your account yet.";
export const INTERVALS_CSRF_ERROR = "This request could not be verified. Try again.";

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
      needsReconnect?: false;
    }
  | {
      connected: true;
      athleteId: string;
      athleteName?: string;
      authType?: IntervalsAuthType;
      needsReconnect?: boolean;
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

/**
 * Shared env key (`INTERVALS_ICU_API_KEY` + `INTERVALS_ICU_ATHLETE_ID`) is off unless
 * `INTERVALS_OWNER_ENV_FALLBACK=true` and `canUseIntervals` allows the account
 * (allowlist and verified email). A stored OAuth token or pasted key does not use this.
 */
export function ownerEnvFallbackAllowed(userId: string): boolean {
  if (envValue("INTERVALS_OWNER_ENV_FALLBACK").toLowerCase() !== "true") return false;
  const user = getUserById(userId);
  if (!canUseIntervals(user)) return false;
  const verified = readEmailVerifiedAt(userId);
  if (verified === undefined) return true;
  return Boolean(verified);
}

/**
 * Drop a legacy shared-key row (no stored ciphertext) when this account cannot
 * use the env fallback. Personal keys are left alone. Call from sync, not from getters.
 */
export async function revokeUnownedIntervals(userId: string): Promise<void> {
  const stored = getStoredIntervalsConnection(userId);
  if (!stored || stored.apiKeyEnc || ownerEnvFallbackAllowed(userId)) return;
  try {
    await enqueueWrite(() => {
      deleteIntervalsConnection(userId);
    });
  } catch (error) {
    logIntervals("revoke unowned failed", error);
  }
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

/** 403 for a cross-site Intervals settings POST or OAuth state failure. No secrets. */
export function intervalsCsrfDeniedResponse(): Response {
  return new Response(INTERVALS_CSRF_ERROR, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * 403 when `canUseIntervals` is false. This describes the shared-key gate only.
 * Settings still accepts a personal OAuth token or pasted key without it.
 */
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

/** 403 when an Intervals settings POST Origin/Referer does not match this site. */
export function denyIntervalsPostCsrf(request: Request, intent: string): Response | null {
  if (!intent.trim().startsWith("intervals-")) return null;
  if (isSameOrigin(request)) return null;
  return intervalsCsrfDeniedResponse();
}

export function intervalsBasicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`, "utf8").toString("base64")}`;
}

/** Bearer for OAuth access tokens, Basic `API_KEY:<key>` for a pasted key. */
export function intervalsAuthorizationHeader(authType: IntervalsAuthType, secret: string): string {
  if (authType === "oauth") return `Bearer ${secret}`;
  return intervalsBasicAuthHeader(secret);
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

export async function loadIntervalsRoute(userId: string, activityId: string): Promise<IntervalsStreamRoute | null> {
  const creds = await openIntervalsCredentials(userId);
  if (!creds.ok || !activityId.trim()) return null;
  try {
    const payload = await intervalsGet(
      { authType: creds.authType, secret: creds.apiKey },
      `/activity/${encodeURIComponent(activityId)}/streams?types=time,latlng,heartrate,cadence,altitude,distance`,
    );
    return routeFromIntervalsStreams(payload);
  } catch (error) {
    await noteIntervalsAuthFailure(userId, error);
    logIntervals("stream fetch failed", error, [creds.apiKey]);
    return null;
  }
}

export async function loadRunEffort(userId: string, date: string, distanceKm: number): Promise<RunEffort | null> {
  const creds = await openIntervalsCredentials(userId);
  if (!creds.ok || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    const activities = await fetchIntervalsActivities(
      { authType: creds.authType, secret: creds.apiKey },
      creds.athleteId,
      date,
      date,
    );
    const runs = activities
      .map(intervalsActivityStats)
      .filter((entry): entry is IntervalsRunStats => Boolean(entry));
    return effortForDistance(runs, distanceKm);
  } catch (error) {
    await noteIntervalsAuthFailure(userId, error);
    logIntervals("effort fetch failed", error, [creds.apiKey]);
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

/** Stored connection with the ciphertext removed. No writes. */
/** True when this user stored their own encrypted token or API key. */
export function userHasOwnIntervalsConnection(userId: string): boolean {
  return Boolean(getStoredIntervalsConnection(userId)?.apiKeyEnc?.trim());
}

export function getIntervalsConnection(userId: string): IntervalsConnection | null {
  const stored = getStoredIntervalsConnection(userId);
  if (!stored) return null;
  return connectionWithoutSecret(stored);
}

function connectionWithoutSecret(stored: IntervalsConnection): IntervalsConnection {
  const connection: IntervalsConnection = {
    userId: stored.userId,
    athleteId: stored.athleteId,
    connectedAt: stored.connectedAt,
    needsReconnect: stored.needsReconnect === true,
    authType: stored.authType === "oauth" ? "oauth" : "apikey",
  };
  if (stored.lastSyncAt) connection.lastSyncAt = stored.lastSyncAt;
  if (stored.lastSyncError) connection.lastSyncError = stored.lastSyncError;
  if (stored.scope) connection.scope = stored.scope;
  if (stored.athleteName) connection.athleteName = stored.athleteName;
  return connection;
}

export function getIntervalsConnectionView(userId: string, now = new Date()): IntervalsConnectionView {
  const connection = getStoredIntervalsConnection(userId);
  const usable = Boolean(connection && (connection.apiKeyEnc || ownerEnvFallbackAllowed(userId)));
  if (!connection || !usable) {
    return { connected: false, statusLabel: "Not connected" };
  }
  const needsReconnect = connection.needsReconnect === true;
  const athleteName = connection.athleteName?.trim() || "";
  const lastSyncLabel = needsReconnect
    ? null
    : connection.lastSyncError
      ? INTERVALS_SYNC_ERROR
      : connection.lastSyncAt
        ? formatSyncedAgo(connection.lastSyncAt, now)
        : null;
  return {
    connected: true,
    athleteId: connection.athleteId,
    athleteName: athleteName || undefined,
    authType: connection.authType === "oauth" ? "oauth" : "apikey",
    needsReconnect,
    statusLabel: needsReconnect ? INTERVALS_ACCESS_EXPIRED : `Connected as ${athleteName || connection.athleteId}`,
    lastSyncAt: connection.lastSyncAt,
    lastSyncError: needsReconnect ? INTERVALS_ACCESS_EXPIRED : connection.lastSyncError,
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
    authType?: IntervalsAuthType;
    fetchImpl?: typeof fetch;
    athletePathId?: string;
  } = {},
): Promise<{ uploaded: number; failed: number; status?: number }> {
  const events = workouts
    .map(plannedRunEvent)
    .filter((event): event is Record<string, unknown> => Boolean(event));
  if (events.length === 0) return { uploaded: 0, failed: 0 };

  const apiKey = options.apiKey?.trim() || null;
  if (!apiKey) return { uploaded: 0, failed: 0 };

  const authType = options.authType === "oauth" ? "oauth" : "apikey";
  const athletePathId = options.athletePathId?.trim() ?? "";
  if (!athletePathId) return { uploaded: 0, failed: 0 };
  try {
    await intervalsGet(
      { authType, secret: apiKey },
      `/athlete/${encodeURIComponent(athletePathId)}/events/bulk?upsert=true`,
      { method: "POST", body: JSON.stringify(events), fetchImpl: options.fetchImpl },
    );
    return { uploaded: events.length, failed: 0 };
  } catch (error) {
    if (error instanceof IntervalsHttpError) {
      console.error(`[intervals] planned workout upsert HTTP ${error.status}`);
      return { uploaded: 0, failed: events.length, status: error.status };
    }
    logIntervals("planned workout upsert failed", error, [apiKey]);
    return { uploaded: 0, failed: events.length };
  }
}

class IntervalsHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Intervals.icu ${status}`);
    this.name = "IntervalsHttpError";
    this.status = status;
  }
}

function isIntervalsAuthFailure(error: unknown): boolean {
  return error instanceof IntervalsHttpError && (error.status === 401 || error.status === 403);
}

function logIntervals(scope: string, error: unknown, secrets: readonly string[] = []): void {
  let message = error instanceof Error ? error.message : "request failed";
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    message = message.split(secret).join("[redacted]");
  }
  console.error(`[intervals] ${scope}`, message);
}

type IntervalsHttpAuth = { authType: IntervalsAuthType; secret: string };

/** One client for sync, pick, effort, route, upload, and connect checks. */
async function intervalsGet(
  auth: IntervalsHttpAuth,
  path: string,
  init: { method?: "GET" | "POST"; body?: string; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: intervalsAuthorizationHeader(auth.authType, auth.secret),
    "User-Agent": INTERVALS_USER_AGENT,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchImpl(`${INTERVALS_ICU_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new IntervalsHttpError(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Intervals response was not JSON");
  }
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

export async function fetchIntervalsActivities(
  auth: IntervalsHttpAuth,
  athleteId: string,
  oldest: string,
  newest: string,
): Promise<IntervalsActivity[]> {
  const params = new URLSearchParams({ oldest, newest });
  const payload = await intervalsGet(
    auth,
    `/athlete/${encodeURIComponent(athleteId)}/activities?${params.toString()}`,
  );
  return parseIntervalsActivities(payload);
}

const ATHLETE_ID_PATTERN = /^i\d{1,12}$/i;

export function normalizeIntervalsAthleteId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes("..") || trimmed.includes("?") || trimmed.includes("/") || /%2f/i.test(trimmed)) {
    return null;
  }
  if (!ATHLETE_ID_PATTERN.test(trimmed)) return null;
  return `i${trimmed.slice(1)}`;
}

export type IntervalsCredentials =
  | { ok: true; apiKey: string; athleteId: string; authType: IntervalsAuthType; source: "stored" | "env" }
  | { ok: false; error: string };

type ReadIntervalsCredentials = IntervalsCredentials & { decryptFailed?: boolean };

/** This user's decrypted secret and athlete, or the owner env fallback. Never another user's secret. */
function readIntervalsCredentials(userId: string): ReadIntervalsCredentials {
  const stored = getStoredIntervalsConnection(userId);
  if (stored?.needsReconnect) return { ok: false, error: INTERVALS_RECONNECT_ERROR };
  if (stored?.apiKeyEnc) {
    try {
      const apiKey = decryptIntervalsApiKey(stored.apiKeyEnc);
      if (!apiKey || !stored.athleteId) return { ok: false, error: INTERVALS_ENC_NOT_CONFIGURED };
      return {
        ok: true,
        apiKey,
        athleteId: stored.athleteId,
        authType: stored.authType === "oauth" ? "oauth" : "apikey",
        source: "stored",
      };
    } catch (error) {
      if (error instanceof IntervalsDecryptError) {
        return { ok: false, error: INTERVALS_RECONNECT_ERROR, decryptFailed: true };
      }
      if (error instanceof IntervalsEncryptionError) return { ok: false, error: INTERVALS_ENC_NOT_CONFIGURED };
      return { ok: false, error: INTERVALS_RECONNECT_ERROR, decryptFailed: true };
    }
  }
  if (stored && ownerEnvFallbackAllowed(userId)) {
    const apiKey = envValue("INTERVALS_ICU_API_KEY");
    const athleteId = stored.athleteId.trim() || envValue("INTERVALS_ICU_ATHLETE_ID");
    if (!apiKey || !athleteId) return { ok: false, error: INTERVALS_API_KEY_NOT_CONFIGURED };
    return { ok: true, apiKey, athleteId, authType: "apikey", source: "env" };
  }
  return { ok: false, error: INTERVALS_SYNC_ERROR };
}

export function resolveIntervalsCredentials(userId: string): IntervalsCredentials {
  const { decryptFailed: _decryptFailed, ...creds } = readIntervalsCredentials(userId);
  return creds;
}

/**
 * Opens the stored secret for an Intervals call. A decrypt failure marks the
 * connection reconnect-needed and does not throw. A missing encryption secret
 * leaves the stored row unchanged.
 */
export async function openIntervalsCredentials(userId: string): Promise<IntervalsCredentials> {
  const read = readIntervalsCredentials(userId);
  if (read.decryptFailed) {
    console.error("[intervals] stored connection could not be read");
    try {
      await markIntervalsNeedsReconnect(userId);
    } catch {
      console.error("[intervals] could not mark reconnect");
    }
    return { ok: false, error: INTERVALS_RECONNECT_ERROR };
  }
  const { decryptFailed: _decryptFailed, ...creds } = read;
  return creds;
}

/** Settings and Today call this so a bad ciphertext becomes reconnect-needed before render. */
export async function refreshIntervalsConnectionView(
  userId: string,
  now = new Date(),
): Promise<IntervalsConnectionView> {
  await openIntervalsCredentials(userId);
  return getIntervalsConnectionView(userId, now);
}

async function noteIntervalsAuthFailure(userId: string, error: unknown): Promise<void> {
  if (!isIntervalsAuthFailure(error)) return;
  await markIntervalsNeedsReconnect(userId);
}

export type IntervalsConnectInput = {
  apiKey?: string;
  athleteId?: string;
};

export async function connectIntervals(
  userId: string,
  input: IntervalsConnectInput = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = input.apiKey?.trim() ?? "";
  const athleteRaw = input.athleteId?.trim() ?? "";
  try {
    if (!apiKey && !athleteRaw) return connectWithOwnerEnvFallback(userId);
    if (!apiKey || !athleteRaw) return { ok: false, error: INTERVALS_CONNECT_INPUT };
    const athleteId = normalizeIntervalsAthleteId(athleteRaw);
    if (!athleteId) return { ok: false, error: INTERVALS_ATHLETE_ID_INVALID };
    try {
      encryptIntervalsApiKey("probe");
    } catch (error) {
      if (error instanceof IntervalsEncryptionError) return { ok: false, error: INTERVALS_ENC_NOT_CONFIGURED };
      throw error;
    }
    const rejected = await rejectInvalidAthlete(apiKey, athleteId);
    if (rejected) return rejected;
    const apiKeyEnc = encryptIntervalsApiKey(apiKey);
    await saveIntervalsConnection(userId, { athleteId, apiKeyEnc, authType: "apikey" });
    return { ok: true };
  } catch (error) {
    logIntervals("connect failed", error, [apiKey]);
    return { ok: false, error: INTERVALS_CONNECT_ERROR };
  }
}

async function connectWithOwnerEnvFallback(
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ownerEnvFallbackAllowed(userId)) return { ok: false, error: INTERVALS_CONNECT_INPUT };
  const apiKey = envValue("INTERVALS_ICU_API_KEY");
  const athleteId = normalizeIntervalsAthleteId(envValue("INTERVALS_ICU_ATHLETE_ID"));
  if (!apiKey || !athleteId) return { ok: false, error: INTERVALS_API_KEY_NOT_CONFIGURED };
  const rejected = await rejectInvalidAthlete(apiKey, athleteId);
  if (rejected) return rejected;
  await saveIntervalsConnection(userId, { athleteId, authType: "apikey" });
  return { ok: true };
}

async function rejectInvalidAthlete(
  apiKey: string,
  athleteId: string,
): Promise<{ ok: false; error: string } | null> {
  try {
    await intervalsGet({ authType: "apikey", secret: apiKey }, `/athlete/${encodeURIComponent(athleteId)}`);
    return null;
  } catch (error) {
    logIntervals("connect failed", error, [apiKey]);
    if (isIntervalsAuthFailure(error) || (error instanceof IntervalsHttpError && error.status === 404)) {
      return { ok: false, error: INTERVALS_CONNECT_REJECTED };
    }
    return { ok: false, error: INTERVALS_CONNECT_ERROR };
  }
}

async function saveIntervalsConnection(
  userId: string,
  input: {
    athleteId: string;
    apiKeyEnc?: string;
    authType: IntervalsAuthType;
    scope?: string;
    athleteName?: string;
  },
): Promise<void> {
  const connectedAt = new Date().toISOString();
  await enqueueWrite(() => {
    const existing = getStoredIntervalsConnection(userId);
    upsertIntervalsConnection({
      userId,
      athleteId: input.athleteId,
      connectedAt: existing?.connectedAt ?? connectedAt,
      lastSyncAt: existing?.lastSyncAt,
      lastSyncError: undefined,
      apiKeyEnc: input.apiKeyEnc,
      needsReconnect: false,
      authType: input.authType,
      scope: input.scope,
      athleteName: input.athleteName,
    });
  });
}

export async function connectIntervalsOAuth(
  userId: string,
  input: { accessToken: string; athleteId: string; athleteName?: string; scope?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accessToken = input.accessToken.trim();
  const athleteId = input.athleteId.trim();
  if (!accessToken || !athleteId) return { ok: false, error: INTERVALS_OAUTH_CONNECT_ERROR };
  if (!intervalsEncryptionReady()) return { ok: false, error: INTERVALS_CONNECT_UNAVAILABLE };
  try {
    const apiKeyEnc = encryptIntervalsApiKey(accessToken);
    await saveIntervalsConnection(userId, {
      athleteId,
      apiKeyEnc,
      authType: "oauth",
      scope: input.scope,
      athleteName: input.athleteName?.trim() || undefined,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof IntervalsEncryptionError) return { ok: false, error: INTERVALS_CONNECT_UNAVAILABLE };
    logIntervals("oauth connect failed", new Error("connect failed"), [accessToken]);
    return { ok: false, error: INTERVALS_OAUTH_CONNECT_ERROR };
  }
}

export async function disconnectIntervals(userId: string): Promise<void> {
  await enqueueWrite(() => {
    deleteIntervalsConnection(userId);
  });
}

export async function markIntervalsNeedsReconnect(userId: string): Promise<void> {
  await enqueueWrite(() => {
    const existing = getStoredIntervalsConnection(userId);
    if (!existing) return;
    upsertIntervalsConnection({
      ...existing,
      needsReconnect: true,
      lastSyncError: INTERVALS_RECONNECT_ERROR,
    });
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
      needsReconnect: false,
    });
  });
}

export async function loadIntervalsRunsForSync(
  userId: string,
  oldest: string,
  newest: string,
): Promise<{ ok: true; runs: IntervalsRunStats[] } | { ok: false; error: string }> {
  await revokeUnownedIntervals(userId);
  const creds = await openIntervalsCredentials(userId);
  if (!creds.ok) return creds;
  try {
    const activities = await fetchIntervalsActivities(
      { authType: creds.authType, secret: creds.apiKey },
      creds.athleteId,
      oldest,
      newest,
    );
    const runs = activities
      .map(intervalsActivityStats)
      .filter((entry): entry is IntervalsRunStats => Boolean(entry))
      .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local) || a.activityId.localeCompare(b.activityId));
    return { ok: true, runs };
  } catch (error) {
    if (isIntervalsAuthFailure(error)) {
      await markIntervalsNeedsReconnect(userId);
      logIntervals("sync fetch failed", error, [creds.apiKey]);
      return { ok: false, error: INTERVALS_RECONNECT_ERROR };
    }
    logIntervals("sync fetch failed", error, [creds.apiKey]);
    return { ok: false, error: INTERVALS_SYNC_ERROR };
  }
}
