import { calendarTodayYmd } from "./calendar";
import {
  deleteIntervalsConnection,
  enqueueWrite,
  getIntervalsConnection as getStoredIntervalsConnection,
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
export const INTERVALS_NO_SESSION_TOAST = "No planned session that day";

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
};

export type IntervalsRunStats = {
  activityId: string;
  date: string;
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  start_date_local: string;
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
  };
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
  return getStoredIntervalsConnection(userId);
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
  const apiKey = intervalsApiKey();
  if (!apiKey) return { ok: false, error: INTERVALS_CONNECT_ERROR };

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
