import { randomBytes } from "node:crypto";
import { addDaysYmd, appTodayYmd, calendarTodayYmd, endOfWeekSunday, startOfWeekMonday } from "./calendar";
import { enqueueWrite, readJsonFile, writeJsonFile } from "./json-store";

const TRAINING_FILE = "training.json";
const PLAN_WEEKS = 4;
const MIN_SESSION_KM = 2;

export const MIN_TRAINING_DAYS = 3;

export const GOAL_IDS = ["5k", "10k", "half", "marathon", "consistent"] as const;
export type Goal = (typeof GOAL_IDS)[number];

export const LEVEL_IDS = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof LEVEL_IDS)[number];

export const WEEKDAY_IDS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAY_IDS)[number];

export type SessionKind = "easy" | "intervals" | "tempo" | "long";
export type SessionOutcome = "done" | "skipped";
export const FEEDBACK_KINDS = ["done", "skip", "feeling-off"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const GOALS = [
  { id: "5k", label: "5K" },
  { id: "10k", label: "10K" },
  { id: "half", label: "Half" },
  { id: "marathon", label: "Marathon" },
  { id: "consistent", label: "Just consistent" },
] as const satisfies ReadonlyArray<{ id: Goal; label: string }>;

export const LEVELS = [
  {
    id: "beginner",
    label: "Beginner",
    help: "New to structured training, or coming back after a break.",
  },
  {
    id: "intermediate",
    label: "Intermediate",
    help: "You run most weeks and can hold a conversation on easy days.",
  },
  {
    id: "advanced",
    label: "Advanced",
    help: "You train consistently and are comfortable with harder sessions.",
  },
] as const satisfies ReadonlyArray<{ id: Level; label: string; help: string }>;

export const WEEKDAYS = [
  { id: "mon", abbr: "M", label: "Monday" },
  { id: "tue", abbr: "T", label: "Tuesday" },
  { id: "wed", abbr: "W", label: "Wednesday" },
  { id: "thu", abbr: "T", label: "Thursday" },
  { id: "fri", abbr: "F", label: "Friday" },
  { id: "sat", abbr: "S", label: "Saturday" },
  { id: "sun", abbr: "S", label: "Sunday" },
] as const satisfies ReadonlyArray<{ id: Weekday; abbr: string; label: string }>;

export const DEFAULT_DAYS: Weekday[] = ["tue", "thu", "sat"];

export const BASELINE_KINDS = ["last-race", "cooper", "skip"] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

export const RACE_DISTANCE_IDS = ["5k", "10k", "half", "marathon", "custom"] as const;
export type RaceDistanceId = (typeof RACE_DISTANCE_IDS)[number];

export const COOPER_DURATION_SEC = 720 as const;
export const COOPER_MIN_KM = 0.5;
export const COOPER_MAX_KM = 5;
/** Soft pace band: 2:30–12:00 /km. Out of range warns; it does not block Continue. */
export const PACE_SOFT_MIN_SEC_PER_KM = 150;
export const PACE_SOFT_MAX_SEC_PER_KM = 720;
export const BASELINE_ADJUSTMENT_MIN = 0.8;
export const BASELINE_ADJUSTMENT_MAX = 1.2;
export const LOGGED_RUN_MIN_KM = 0.1;
export const LOGGED_RUN_MAX_KM = 100;
export const EMPTY_RUN_ROUTE: RunRoute = { type: "none" };
const MAX_POLYLINE_POINTS = 2000;

export const RACE_DISTANCE_KM: Record<Exclude<RaceDistanceId, "custom">, number> = {
  "5k": 5,
  "10k": 10,
  half: 21.0975,
  marathon: 42.195,
};

export const RACE_DISTANCES = [
  { id: "5k", label: "5K", km: 5 },
  { id: "10k", label: "10K", km: 10 },
  { id: "half", label: "Half", km: 21.0975 },
  { id: "marathon", label: "Marathon", km: 42.195 },
  { id: "custom", label: "Custom", km: null },
] as const satisfies ReadonlyArray<{ id: RaceDistanceId; label: string; km: number | null }>;

export type Baseline =
  | { kind: "last-race"; distanceKm: number; timeSec: number; paceSecPerKm: number; date?: string }
  | { kind: "cooper"; distanceKm: number; durationSec: 720 }
  | { kind: "skip" };

export type OnboardingAnswers = {
  goal: Goal;
  raceDate: string | null;
  level: Level;
  days: Weekday[];
  baseline?: Baseline;
};

export type OnboardingRecord = {
  userId: string;
  goal?: Goal;
  raceDate?: string | null;
  level?: Level;
  days?: Weekday[];
  baseline?: Baseline;
  updatedAt: string;
  completedAt?: string;
  planId?: string;
};

export type Plan = {
  id: string;
  userId: string;
  version: 1;
  createdAt: string;
  goal: Goal;
  raceDate: string | null;
  level: Level;
  days: Weekday[];
  baseline?: Baseline;
};

export type GeoPoint = {
  lat: number;
  lng: number;
};

export type RunRoute =
  | { type: "polyline"; coords: GeoPoint[] }
  | { type: "none" };

/** Actuals from post-Done “Log this run”. 1:1 with Feedback.sessionId. */
export type RunLog = {
  id: string;
  userId: string;
  sessionId: string;
  planId: string;
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  route?: RunRoute;
  createdAt: string;
};

export type RunLogStats = {
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  route: RunRoute;
};

export type RunLogFormDraft = {
  distanceKm: string;
  time: string;
  pace: string;
  routeJson: string;
};

export type Session = {
  id: string;
  planId: string;
  userId: string;
  date: string;
  weekday: Weekday;
  weekIndex: number;
  kind: SessionKind;
  title: string;
  cue: string;
  distanceKm: number;
  outcome?: SessionOutcome;
  outcomeAt?: string;
};

export type Feedback = {
  id: string;
  userId: string;
  planId: string;
  sessionId: string;
  kind: FeedbackKind;
  createdAt: string;
};

/** Written only by the nocturnal adaptation job. The shell displays these read-only. */
export type AdaptationEvent = {
  id: string;
  userId: string;
  planId: string;
  sessionId?: string;
  /** Guayaquil civil date the event should appear (the adapted session’s day). */
  date: string;
  /** Always `Plan adjusted` for job-written events. Chip label. */
  title: string;
  /** One line: what changes tomorrow. Shown with the chip. */
  summary: string;
  /** One or two lines: why. Shown in the Why? sheet when non-empty. */
  reason: string;
  /** Guayaquil day of the Feedback that triggered this event. */
  sourceDate?: string;
  createdAt: string;
};

export type AdaptationSessionPatch = {
  id: string;
  distanceKm: number;
  kind: SessionKind;
  title: string;
  cue: string;
};

export type AdaptationDraft = {
  userId: string;
  planId: string;
  sessionId?: string;
  date: string;
  title: string;
  summary: string;
  reason: string;
  sourceDate: string;
};

type TrainingFile = {
  onboarding: OnboardingRecord[];
  plans: Plan[];
  sessions: Session[];
  feedbacks: Feedback[];
  runLogs: RunLog[];
  adaptationEvents: AdaptationEvent[];
};

const EMPTY_TRAINING: TrainingFile = {
  onboarding: [],
  plans: [],
  sessions: [],
  feedbacks: [],
  runLogs: [],
  adaptationEvents: [],
};

const WEEKLY_KM: Record<Goal, Record<Level, number>> = {
  "5k": { beginner: 16, intermediate: 25, advanced: 40 },
  "10k": { beginner: 20, intermediate: 32, advanced: 48 },
  half: { beginner: 24, intermediate: 40, advanced: 56 },
  marathon: { beginner: 32, intermediate: 50, advanced: 70 },
  consistent: { beginner: 12, intermediate: 20, advanced: 32 },
};

const SESSION_COPY: Record<SessionKind, { title: string; cue: string }> = {
  easy: { title: "Easy run", cue: "Keep it conversational" },
  intervals: { title: "Intervals", cue: "Hard efforts, easy recoveries" },
  tempo: { title: "Tempo", cue: "Comfortably hard, controlled" },
  long: { title: "Long run", cue: "Easy pace, finish with something left" },
};

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export type OnboardingStep = 1 | 2 | 3 | 4;

export type OnboardingFormResult =
  | { ok: true; redirect: string }
  | { ok: false; error: string; step: OnboardingStep };

export type TodayActionResult =
  | { ok: true; redirect: string }
  | { ok: false; error: string; logOpen: true; draft: RunLogFormDraft };

export type WeekDayView = {
  id: Weekday;
  abbr: string;
  label: string;
  ymd: string;
  isToday: boolean;
  hasSession: boolean;
};

export type ProgressMetric = {
  label: string;
  value: string;
  provisional: boolean;
};

function newId(): string {
  return randomBytes(16).toString("base64url");
}

function isGoal(value: string): value is Goal {
  return (GOAL_IDS as readonly string[]).includes(value);
}

function isLevel(value: string): value is Level {
  return (LEVEL_IDS as readonly string[]).includes(value);
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAY_IDS as readonly string[]).includes(value);
}

function isBaselineKind(value: string): value is BaselineKind {
  return (BASELINE_KINDS as readonly string[]).includes(value);
}

function isRaceDistanceId(value: string): value is RaceDistanceId {
  return (RACE_DISTANCE_IDS as readonly string[]).includes(value);
}

export function parseHmsToSeconds(raw: string): number | null {
  const value = raw.trim();
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function formatHms(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "";
  const input = formatPaceInput(secPerKm);
  return input ? `${input} /km` : "";
}

export function formatPaceInput(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "";
  const rounded = Math.round(secPerKm);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function computePaceSecPerKm(distanceKm: number, timeSec: number): number {
  if (!(distanceKm > 0) || !(timeSec > 0)) return 0;
  return timeSec / distanceKm;
}

export function isPaceSoftOutOfRange(paceSecPerKm: number): boolean {
  return paceSecPerKm < PACE_SOFT_MIN_SEC_PER_KM || paceSecPerKm > PACE_SOFT_MAX_SEC_PER_KM;
}

export function raceDistanceIdFromKm(distanceKm: number): RaceDistanceId {
  const match = RACE_DISTANCES.find((distance) => distance.km !== null && Math.abs(distance.km - distanceKm) < 0.001);
  return match?.id ?? "custom";
}

export function parsePositiveNumber(raw: string): number | null {
  const value = raw.trim().replace(",", ".");
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

export function parseDurationToSeconds(raw: string): number | null {
  const hms = parseHmsToSeconds(raw);
  if (hms !== null) return hms;
  const value = raw.trim();
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parsePaceToSecPerKm(raw: string): number | null {
  const value = raw.trim().replace(/\s*\/\s*km$/i, "").trim();
  if (!value) return null;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

function isGeoPoint(value: unknown): value is GeoPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as { lat?: unknown; lng?: unknown };
  return (
    typeof point.lat === "number" &&
    typeof point.lng === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

export function normalizeRunRoute(value: unknown): RunRoute {
  if (!value || typeof value !== "object") return { ...EMPTY_RUN_ROUTE };
  const record = value as { type?: unknown; kind?: unknown; coords?: unknown; points?: unknown };
  const rawCoords = Array.isArray(record.coords)
    ? record.coords
    : Array.isArray(record.points)
      ? record.points
      : null;
  const isPolyline = record.type === "polyline" || record.kind === "polyline";
  if (isPolyline && rawCoords) {
    const coords = rawCoords
      .map(parseCoord)
      .filter((point): point is GeoPoint => Boolean(point))
      .slice(0, MAX_POLYLINE_POINTS);
    if (coords.length >= 2) return { type: "polyline", coords };
  }
  return { ...EMPTY_RUN_ROUTE };
}

function parseCoord(value: unknown): GeoPoint | null {
  if (Array.isArray(value) && value.length >= 2) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    if (isFiniteCoord(lat, lng)) return { lat, lng };
    return null;
  }
  return isGeoPoint(value) ? value : null;
}

function isFiniteCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isRunRoute(value: unknown): value is RunRoute {
  if (!value || typeof value !== "object") return false;
  const record = value as { type?: unknown; coords?: unknown };
  if (record.type === "none") return true;
  if (record.type === "polyline" && Array.isArray(record.coords)) {
    const coords = record.coords.map(parseCoord).filter((point): point is GeoPoint => Boolean(point));
    return coords.length >= 2 && coords.length <= MAX_POLYLINE_POINTS;
  }
  return false;
}

export function normalizeRunLog(value: unknown): RunLog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RunLog>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.userId !== "string" ||
    !record.userId ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.planId !== "string" ||
    !record.planId ||
    typeof record.distanceKm !== "number" ||
    record.distanceKm < LOGGED_RUN_MIN_KM ||
    record.distanceKm > LOGGED_RUN_MAX_KM ||
    typeof record.timeSec !== "number" ||
    record.timeSec <= 0 ||
    typeof record.paceSecPerKm !== "number" ||
    record.paceSecPerKm <= 0 ||
    typeof record.createdAt !== "string" ||
    !record.createdAt
  ) {
    return undefined;
  }
  return {
    id: record.id,
    userId: record.userId,
    sessionId: record.sessionId,
    planId: record.planId,
    distanceKm: record.distanceKm,
    timeSec: record.timeSec,
    paceSecPerKm: record.paceSecPerKm,
    route: normalizeRunRoute(record.route),
    createdAt: record.createdAt,
  };
}

export function emptyRunLogDraft(distanceKm?: number): RunLogFormDraft {
  return {
    distanceKm: typeof distanceKm === "number" && distanceKm > 0 ? String(distanceKm) : "",
    time: "",
    pace: "",
    routeJson: JSON.stringify(EMPTY_RUN_ROUTE),
  };
}

export function parseRunRoute(raw: string): RunRoute {
  const value = raw.trim();
  if (!value) return { ...EMPTY_RUN_ROUTE };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeRunRoute({ type: "polyline", coords: parsed });
    }
    return normalizeRunRoute(parsed);
  } catch {
    return { ...EMPTY_RUN_ROUTE };
  }
}

export function readRunLogDraft(formData: FormData): RunLogFormDraft {
  const routeJson = String(formData.get("loggedRoute") ?? "").trim();
  return {
    distanceKm: String(formData.get("loggedDistanceKm") ?? ""),
    time: String(formData.get("loggedTime") ?? ""),
    pace: String(formData.get("loggedPace") ?? ""),
    routeJson: routeJson || JSON.stringify(EMPTY_RUN_ROUTE),
  };
}

function roundLoggedKm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function parseRunLogForm(
  formData: FormData,
): { ok: true; stats: RunLogStats } | { ok: false; error: string; draft: RunLogFormDraft } {
  const draft = readRunLogDraft(formData);
  const distanceRaw = parsePositiveNumber(draft.distanceKm);
  const timeSec = parseDurationToSeconds(draft.time);
  const route = parseRunRoute(draft.routeJson);

  if (distanceRaw === null) {
    return { ok: false, error: "Enter the distance you ran.", draft };
  }
  const distanceKm = roundLoggedKm(distanceRaw);
  if (distanceKm < LOGGED_RUN_MIN_KM || distanceKm > LOGGED_RUN_MAX_KM) {
    return { ok: false, error: "Distance must be between 0.1 and 100 km.", draft };
  }
  if (timeSec === null) {
    return { ok: false, error: "Enter your time as hh:mm:ss.", draft };
  }
  if (timeSec <= 0) {
    return { ok: false, error: "Time must be greater than zero.", draft };
  }

  const paceSecPerKm = computePaceSecPerKm(distanceKm, timeSec);
  if (!(paceSecPerKm > 0)) {
    return { ok: false, error: "Enter a distance and time so pace can be calculated.", draft };
  }

  return {
    ok: true,
    stats: { distanceKm, timeSec, paceSecPerKm, route },
  };
}

/** Skip, omit, and null all mean “no baseline” — current Plan v1 heuristic. */
export function isSkippedBaseline(baseline?: Baseline | null): boolean {
  return !baseline || baseline.kind === "skip";
}

export function isPresentBaseline(
  baseline?: Baseline | null,
): baseline is Extract<Baseline, { kind: "last-race" } | { kind: "cooper" }> {
  return Boolean(baseline && baseline.kind !== "skip");
}

export function isBaseline(value: unknown): value is Baseline {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Baseline> & { kind?: string };
  if (record.kind === "skip") return true;
  if (record.kind === "cooper") {
    const cooper = record as Extract<Baseline, { kind: "cooper" }>;
    return (
      typeof cooper.distanceKm === "number" &&
      cooper.distanceKm >= COOPER_MIN_KM &&
      cooper.distanceKm <= COOPER_MAX_KM &&
      cooper.durationSec === COOPER_DURATION_SEC
    );
  }
  if (record.kind === "last-race") {
    const race = record as Extract<Baseline, { kind: "last-race" }>;
    return (
      typeof race.distanceKm === "number" &&
      race.distanceKm > 0 &&
      typeof race.timeSec === "number" &&
      race.timeSec > 0 &&
      typeof race.paceSecPerKm === "number" &&
      race.paceSecPerKm > 0 &&
      (race.date === undefined || typeof race.date === "string")
    );
  }
  return false;
}

/** Expected equivalent 5K pace (sec/km) for the selected level. */
const EXPECTED_PACE_SEC_PER_KM: Record<Level, number> = {
  beginner: 420,
  intermediate: 330,
  advanced: 270,
};

/** Expected Cooper 12-minute distance (km) for the selected level. */
const EXPECTED_COOPER_KM: Record<Level, number> = {
  beginner: 1.8,
  intermediate: 2.4,
  advanced: 3.0,
};

function clampBaselineFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(BASELINE_ADJUSTMENT_MAX, Math.max(BASELINE_ADJUSTMENT_MIN, value));
}

function riegelEquivalentPaceSecPerKm(distanceKm: number, timeSec: number, targetKm = 5): number {
  const equivalentTime = timeSec * (targetKm / distanceKm) ** 1.06;
  return equivalentTime / targetKm;
}

/** Fitness vs the selected level. Skip / omit / null is 1. Last-race / Cooper are clamped to ±20%. */
export function baselineFitnessFactor(baseline: Baseline | null | undefined, level: Level): number {
  if (!isPresentBaseline(baseline)) return 1;
  if (baseline.kind === "last-race") {
    const actual = riegelEquivalentPaceSecPerKm(baseline.distanceKm, baseline.timeSec);
    if (!(actual > 0)) return 1;
    return clampBaselineFactor(EXPECTED_PACE_SEC_PER_KM[level] / actual);
  }
  return clampBaselineFactor(baseline.distanceKm / EXPECTED_COOPER_KM[level]);
}

export function parseBaselineForm(
  formData: FormData,
): { ok: true; baseline: Baseline } | { ok: false; error: string } {
  const kindRaw = String(formData.get("baselineKind") ?? "");
  if (!isBaselineKind(kindRaw)) {
    return { ok: false, error: "Choose Last race, Cooper test, or Skip for now." };
  }

  if (kindRaw === "skip") {
    return { ok: true, baseline: { kind: "skip" } };
  }

  if (kindRaw === "cooper") {
    const amount = parsePositiveNumber(String(formData.get("cooperDistance") ?? ""));
    if (amount === null) {
      return { ok: false, error: "Enter the distance you covered." };
    }
    const unit = String(formData.get("cooperUnit") ?? "km");
    const distanceKm = Math.round((unit === "m" ? amount / 1000 : amount) * 1000) / 1000;
    if (distanceKm < COOPER_MIN_KM || distanceKm > COOPER_MAX_KM) {
      return { ok: false, error: "Cooper distance must be between 0.5 and 5 km." };
    }
    return {
      ok: true,
      baseline: { kind: "cooper", distanceKm, durationSec: COOPER_DURATION_SEC },
    };
  }

  const distanceIdRaw = String(formData.get("lastRaceDistance") ?? "");
  if (!isRaceDistanceId(distanceIdRaw)) {
    return { ok: false, error: "Pick a last-race distance." };
  }

  let distanceKm: number;
  if (distanceIdRaw === "custom") {
    const customKm = parsePositiveNumber(String(formData.get("lastRaceCustomKm") ?? ""));
    if (customKm === null) {
      return { ok: false, error: "Enter a custom distance in km." };
    }
    distanceKm = customKm;
  } else {
    distanceKm = RACE_DISTANCE_KM[distanceIdRaw];
  }

  const timeSec = parseHmsToSeconds(String(formData.get("lastRaceTime") ?? ""));
  if (timeSec === null) {
    return { ok: false, error: "Enter your time as hh:mm:ss." };
  }
  if (timeSec <= 0) {
    return { ok: false, error: "Time must be greater than zero." };
  }

  const dateRaw = String(formData.get("lastRaceDate") ?? "").trim();
  let date: string | undefined;
  if (dateRaw) {
    if (!isYmd(dateRaw)) {
      return { ok: false, error: "Enter a valid last-race date, or leave it blank." };
    }
    if (dateRaw > appTodayYmd()) {
      return { ok: false, error: "Last race date can’t be in the future." };
    }
    date = dateRaw;
  }

  const paceSecPerKm = computePaceSecPerKm(distanceKm, timeSec);
  return {
    ok: true,
    baseline: date
      ? { kind: "last-race", distanceKm, timeSec, paceSecPerKm, date }
      : { kind: "last-race", distanceKm, timeSec, paceSecPerKm },
  };
}

export { appTodayYmd };

export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function uniqueWeekdays(values: string[]): Weekday[] {
  const seen = new Set<Weekday>();
  for (const value of values) {
    if (isWeekday(value) && !seen.has(value)) seen.add(value);
  }
  return WEEKDAY_IDS.filter((day) => seen.has(day));
}

function normalizeAdaptationEvent(event: AdaptationEvent): AdaptationEvent {
  const summary = event.summary || "";
  const reason = event.reason || "";
  return {
    ...event,
    title: event.title || "Plan adjusted",
    summary,
    reason,
  };
}

function stripLegacyLoggedRun<T extends object>(value: T): T {
  const record = value as T & { loggedRun?: unknown };
  delete record.loggedRun;
  return record;
}

function normalizeSessionRecord(session: Session): Session {
  return stripLegacyLoggedRun(session);
}

function normalizeFeedbackRecord(feedback: Feedback): Feedback {
  return stripLegacyLoggedRun(feedback);
}

function normalizeRunLogRecord(value: unknown): RunLog | undefined {
  return normalizeRunLog(value);
}

async function readTraining(): Promise<TrainingFile> {
  const parsed = await readJsonFile<TrainingFile>(TRAINING_FILE, EMPTY_TRAINING);
  return {
    onboarding: Array.isArray(parsed.onboarding) ? parsed.onboarding : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSessionRecord) : [],
    feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks.map(normalizeFeedbackRecord) : [],
    runLogs: Array.isArray(parsed.runLogs)
      ? parsed.runLogs.map(normalizeRunLogRecord).filter((entry): entry is RunLog => Boolean(entry))
      : [],
    adaptationEvents: Array.isArray(parsed.adaptationEvents)
      ? parsed.adaptationEvents.map(normalizeAdaptationEvent)
      : [],
  };
}

/** Persist training data without creating or mutating AdaptationEvents. */
async function writeTraining(data: TrainingFile): Promise<void> {
  const onDisk = await readJsonFile<TrainingFile>(TRAINING_FILE, EMPTY_TRAINING);
  await writeJsonFile(TRAINING_FILE, {
    onboarding: data.onboarding,
    plans: data.plans,
    sessions: data.sessions,
    feedbacks: data.feedbacks,
    runLogs: data.runLogs,
    adaptationEvents: Array.isArray(onDisk.adaptationEvents) ? onDisk.adaptationEvents : [],
  });
}

export async function getOnboarding(userId: string): Promise<OnboardingRecord | null> {
  const data = await readTraining();
  return data.onboarding.find((entry) => entry.userId === userId) ?? null;
}

export async function getPlanForUser(userId: string): Promise<Plan | null> {
  const data = await readTraining();
  return data.plans.find((plan) => plan.userId === userId) ?? null;
}

export async function getSessionsForPlan(planId: string): Promise<Session[]> {
  const data = await readTraining();
  return data.sessions
    .filter((session) => session.planId === planId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.weekday.localeCompare(b.weekday));
}

export async function getNextSession(userId: string): Promise<Session | null> {
  const plan = await getPlanForUser(userId);
  if (!plan) return null;
  const today = appTodayYmd();
  const sessions = await getSessionsForPlan(plan.id);
  return sessions.find((session) => session.date >= today) ?? sessions.at(-1) ?? null;
}

export async function getSessionForToday(userId: string): Promise<Session | null> {
  const plan = await getPlanForUser(userId);
  if (!plan) return null;
  const today = appTodayYmd();
  const sessions = await getSessionsForPlan(plan.id);
  return sessions.find((session) => session.date === today) ?? null;
}

export async function getAppWeek(userId: string): Promise<{
  today: string;
  days: WeekDayView[];
  weekSessions: Session[];
  focusSessions: Session[];
}> {
  const today = appTodayYmd();
  const start = startOfWeekMonday(today);
  const end = endOfWeekSunday(today);
  const plan = await getPlanForUser(userId);
  const all = plan ? await getSessionsForPlan(plan.id) : [];
  const weekSessions = all.filter((session) => session.date >= start && session.date <= end);
  const focusSessions = weekSessions.filter((session) => session.date >= today).slice(0, 3);

  const days: WeekDayView[] = WEEKDAYS.map((day, index) => {
    const ymd = addDaysYmd(start, index);
    return {
      id: day.id,
      abbr: day.abbr,
      label: day.label,
      ymd,
      isToday: ymd === today,
      hasSession: weekSessions.some((session) => session.date === ymd),
    };
  });

  return { today, days, weekSessions, focusSessions };
}

export async function getProgressMetrics(userId: string): Promise<ProgressMetric[]> {
  const { weekSessions } = await getAppWeek(userId);
  const data = await readTraining();
  const planned = weekSessions.length;
  const done = weekSessions.filter((session) => session.outcome === "done").length;
  const weeklyKm = weekSessions.reduce((sum, session) => sum + session.distanceKm, 0);
  const logsBySession = new Map(
    data.runLogs.filter((entry) => entry.userId === userId).map((entry) => [entry.sessionId, entry]),
  );
  const easyPaces = weekSessions
    .filter((session) => session.kind === "easy" && session.outcome === "done")
    .map((session) => logsBySession.get(session.id)?.paceSecPerKm)
    .filter((pace): pace is number => typeof pace === "number" && pace > 0);
  const easyPace =
    easyPaces.length > 0 ? easyPaces.reduce((sum, pace) => sum + pace, 0) / easyPaces.length : 0;

  return [
    {
      label: "Consistency",
      value: `${done}/${planned}`,
      provisional: false,
    },
    {
      label: "Easy pace",
      value: easyPace > 0 ? formatPace(easyPace) : "—",
      provisional: easyPace <= 0,
    },
    {
      label: "Weekly distance",
      value: `${weeklyKm} km`,
      provisional: false,
    },
  ];
}

export async function getFeedbackForSession(userId: string, sessionId: string): Promise<Feedback | null> {
  const data = await readTraining();
  return data.feedbacks.find((entry) => entry.userId === userId && entry.sessionId === sessionId) ?? null;
}

export async function getRunLogForSession(userId: string, sessionId: string): Promise<RunLog | null> {
  const data = await readTraining();
  return data.runLogs.find((entry) => entry.userId === userId && entry.sessionId === sessionId) ?? null;
}

export async function getAdaptationEventForToday(userId: string): Promise<AdaptationEvent | null> {
  const today = appTodayYmd();
  const data = await readTraining();
  const matches = data.adaptationEvents.filter(
    (event) => event.userId === userId && event.date === today,
  );
  matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return matches.at(-1) ?? null;
}

/** Latest Feedback for a Guayaquil civil date. Read-only; does not write Feedback. */
export async function getFeedbackForDate(userId: string, ymd: string): Promise<Feedback | null> {
  const data = await readTraining();
  const session = data.sessions.find((entry) => entry.userId === userId && entry.date === ymd);
  const bySession = session
    ? data.feedbacks.filter((entry) => entry.userId === userId && entry.sessionId === session.id)
    : [];
  if (bySession.length > 0) {
    bySession.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return bySession.at(-1) ?? null;
  }

  const byCreated = data.feedbacks.filter((entry) => {
    if (entry.userId !== userId) return false;
    const created = new Date(entry.createdAt);
    if (Number.isNaN(created.getTime())) return false;
    return calendarTodayYmd(created) === ymd;
  });
  byCreated.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byCreated.at(-1) ?? null;
}

export function presentSession(
  kind: SessionKind,
  distanceKm: number,
): Pick<Session, "kind" | "distanceKm" | "title" | "cue"> {
  const km = Math.max(MIN_SESSION_KM, Math.round(distanceKm));
  const copy = SESSION_COPY[kind];
  return {
    kind,
    distanceKm: km,
    title: `${copy.title} · ${km} km`,
    cue: copy.cue,
  };
}

export type AdaptationJobSnapshot = {
  plans: Plan[];
  sessions: Session[];
  feedbacks: Feedback[];
  adaptationEvents: AdaptationEvent[];
};

export async function getAdaptationJobSnapshot(): Promise<AdaptationJobSnapshot> {
  const data = await readTraining();
  return {
    plans: data.plans,
    sessions: data.sessions,
    feedbacks: data.feedbacks,
    adaptationEvents: data.adaptationEvents,
  };
}

/** Persist session patches + AdaptationEvents. Shell writes never call this. */
export async function commitAdaptationRun(input: {
  sessionPatches: AdaptationSessionPatch[];
  drafts: AdaptationDraft[];
}): Promise<AdaptationEvent[]> {
  return enqueueWrite(async () => {
    const data = await readTraining();
    const written: AdaptationEvent[] = [];
    const createdAt = new Date().toISOString();

    for (const patch of input.sessionPatches) {
      const session = data.sessions.find((entry) => entry.id === patch.id);
      if (!session || session.outcome) continue;
      session.distanceKm = patch.distanceKm;
      session.kind = patch.kind;
      session.title = patch.title;
      session.cue = patch.cue;
    }

    for (const draft of input.drafts) {
      const already = data.adaptationEvents.some(
        (event) => event.userId === draft.userId && event.sourceDate === draft.sourceDate,
      );
      if (already) continue;

      const event: AdaptationEvent = {
        id: newId(),
        userId: draft.userId,
        planId: draft.planId,
        sessionId: draft.sessionId,
        date: draft.date,
        title: draft.title,
        summary: draft.summary,
        reason: draft.reason,
        sourceDate: draft.sourceDate,
        createdAt,
      };
      data.adaptationEvents.push(event);
      written.push(event);
    }

    await writeJsonFile(TRAINING_FILE, {
      onboarding: data.onboarding,
      plans: data.plans,
      sessions: data.sessions,
      feedbacks: data.feedbacks,
      runLogs: data.runLogs,
      adaptationEvents: data.adaptationEvents,
    });
    return written;
  });
}

function isFeedbackKind(value: string): value is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(value);
}

export async function submitSessionFeedback(
  userId: string,
  sessionId: string,
  kind: FeedbackKind,
  runLogStats?: RunLogStats,
): Promise<Feedback | null> {
  return enqueueWrite(async () => {
    const data = await readTraining();
    const session = data.sessions.find((entry) => entry.id === sessionId && entry.userId === userId);
    if (!session) return null;

    const existing = data.feedbacks.find((entry) => entry.userId === userId && entry.sessionId === sessionId);
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    const feedback: Feedback = {
      id: newId(),
      userId,
      planId: session.planId,
      sessionId,
      kind,
      createdAt,
    };
    data.feedbacks.push(feedback);

    if (kind === "done" || kind === "skip") {
      session.outcome = kind === "done" ? "done" : "skipped";
      session.outcomeAt = createdAt;
    }

    if (kind === "done" && runLogStats) {
      const already = data.runLogs.some((entry) => entry.userId === userId && entry.sessionId === sessionId);
      if (!already) {
        data.runLogs.push({
          id: newId(),
          userId,
          sessionId,
          planId: session.planId,
          distanceKm: runLogStats.distanceKm,
          timeSec: runLogStats.timeSec,
          paceSecPerKm: runLogStats.paceSecPerKm,
          route: runLogStats.route,
          createdAt,
        });
      }
    }

    await writeTraining(data);
    return feedback;
  });
}

export async function handleTodayPost(userId: string, formData: FormData): Promise<TodayActionResult> {
  const intent = String(formData.get("intent") ?? "");
  const sessionId = String(formData.get("sessionId") ?? "");

  if (intent === "open-log" && sessionId) {
    const data = await readTraining();
    const session = data.sessions.find((entry) => entry.id === sessionId && entry.userId === userId);
    const fallback = emptyRunLogDraft(session?.distanceKm);
    const fromForm = readRunLogDraft(formData);
    return {
      ok: false,
      error: "",
      logOpen: true,
      draft: {
        distanceKm: fromForm.distanceKm.trim() ? fromForm.distanceKm : fallback.distanceKm,
        time: fromForm.time,
        pace: fromForm.pace,
        routeJson: fromForm.routeJson.trim() ? fromForm.routeJson : fallback.routeJson,
      },
    };
  }

  if (intent === "skip-map" && sessionId) {
    await submitSessionFeedback(userId, sessionId, "done");
    return { ok: true, redirect: "/today" };
  }

  if (intent === "done" && sessionId) {
    const parsed = parseRunLogForm(formData);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, logOpen: true, draft: parsed.draft };
    }
    await submitSessionFeedback(userId, sessionId, "done", parsed.stats);
    return { ok: true, redirect: "/today?saved=1" };
  }

  if (isFeedbackKind(intent) && intent !== "done" && sessionId) {
    await submitSessionFeedback(userId, sessionId, intent);
  }
  return { ok: true, redirect: "/today" };
}

function upsertOnboarding(data: TrainingFile, record: OnboardingRecord): void {
  const index = data.onboarding.findIndex((entry) => entry.userId === record.userId);
  if (index >= 0) data.onboarding[index] = record;
  else data.onboarding.push(record);
}

export async function saveOnboardingDraft(
  userId: string,
  patch: Partial<Pick<OnboardingRecord, "goal" | "raceDate" | "level" | "days" | "baseline">>,
): Promise<OnboardingRecord> {
  return enqueueWrite(async () => {
    const data = await readTraining();
    const existing = data.onboarding.find((entry) => entry.userId === userId);
    const record: OnboardingRecord = {
      ...existing,
      ...patch,
      userId,
      updatedAt: new Date().toISOString(),
    };
    upsertOnboarding(data, record);
    await writeTraining(data);
    return record;
  });
}

function parseRaceDate(raw: FormDataEntryValue | null, goal: Goal): string | null | { error: string } {
  const value = String(raw ?? "").trim();
  if (!value || goal === "consistent") return null;
  if (!isYmd(value)) return { error: "Enter a valid race date, or leave it blank." };
  if (value < appTodayYmd()) return { error: "Pick a race date from today on." };
  return value;
}

function roundKm(value: number): number {
  return Math.max(MIN_SESSION_KM, Math.round(value));
}

function assignKinds(days: Weekday[]): Record<Weekday, SessionKind> {
  const ordered = WEEKDAY_IDS.filter((day) => days.includes(day));
  const kinds = Object.fromEntries(ordered.map((day) => [day, "easy"])) as Record<
    Weekday,
    SessionKind
  >;

  const weekend = ordered.filter((day) => day === "sat" || day === "sun");
  const longDay = weekend.at(-1) ?? ordered.at(-1);
  if (longDay) kinds[longDay] = "long";

  const midCandidates = ordered.filter((day) => kinds[day] !== "long");
  if (midCandidates.length > 0) {
    const intervalsDay = midCandidates[Math.floor((midCandidates.length - 1) / 2)];
    kinds[intervalsDay] = "intervals";
  }

  if (ordered.length >= 5) {
    const tempoDay = midCandidates.find((day) => kinds[day] === "easy");
    if (tempoDay) kinds[tempoDay] = "tempo";
  }

  return kinds;
}

function allocateDistances(
  days: Weekday[],
  kinds: Record<Weekday, SessionKind>,
  weeklyKm: number,
): Record<Weekday, number> {
  const weights: Record<SessionKind, number> = {
    long: 0.36,
    intervals: 0.2,
    tempo: 0.18,
    easy: 0.14,
  };
  const raw = Object.fromEntries(
    days.map((day) => [day, weights[kinds[day]]]),
  ) as Record<Weekday, number>;
  const totalWeight = days.reduce((sum, day) => sum + raw[day], 0);
  const distances = Object.fromEntries(
    days.map((day) => [day, roundKm((raw[day] / totalWeight) * weeklyKm)]),
  ) as Record<Weekday, number>;

  const drift = weeklyKm - days.reduce((sum, day) => sum + distances[day], 0);
  const longDay = days.find((day) => kinds[day] === "long") ?? days.at(-1);
  if (longDay) distances[longDay] = Math.max(MIN_SESSION_KM, distances[longDay] + drift);

  return distances;
}

function applyBaselineAdjustment(
  days: Weekday[],
  kinds: Record<Weekday, SessionKind>,
  baseDistances: Record<Weekday, number>,
  baseline: Extract<Baseline, { kind: "last-race" } | { kind: "cooper" }>,
  level: Level,
): Record<Weekday, number> {
  const factor = baselineFitnessFactor(baseline, level);
  const adjusted = { ...baseDistances };
  for (const day of days) {
    const base = baseDistances[day];
    const kind = kinds[day];
    const scaled = kind === "easy" ? base * (2 - factor) : base * factor;
    const min = Math.max(MIN_SESSION_KM, Math.ceil(base * BASELINE_ADJUSTMENT_MIN));
    const max = Math.max(MIN_SESSION_KM, Math.floor(base * BASELINE_ADJUSTMENT_MAX));
    if (min > max) {
      adjusted[day] = base;
    } else {
      adjusted[day] = Math.min(max, Math.max(min, Math.round(scaled)));
    }
  }
  return adjusted;
}

function planDistances(
  days: Weekday[],
  kinds: Record<Weekday, SessionKind>,
  goal: Goal,
  level: Level,
  baseline?: Baseline,
): Record<Weekday, number> {
  const base = allocateDistances(days, kinds, WEEKLY_KM[goal][level]);
  if (isSkippedBaseline(baseline) || !isPresentBaseline(baseline)) return base;
  return applyBaselineAdjustment(days, kinds, base, baseline, level);
}

function dateOnOrAfter(startYmd: string, weekday: Weekday): string {
  const start = new Date(`${startYmd}T12:00:00.000Z`);
  const delta = (WEEKDAY_INDEX[weekday] - start.getUTCDay() + 7) % 7;
  return addDaysYmd(startYmd, delta);
}

export function generatePlanV1(
  userId: string,
  answers: OnboardingAnswers,
  fromYmd = appTodayYmd(),
): { plan: Plan; sessions: Session[] } {
  const createdAt = new Date().toISOString();
  const plan: Plan = {
    id: newId(),
    userId,
    version: 1,
    createdAt,
    goal: answers.goal,
    raceDate: answers.raceDate,
    level: answers.level,
    days: answers.days,
    ...(answers.baseline ? { baseline: answers.baseline } : {}),
  };

  const kinds = assignKinds(answers.days);
  const distances = planDistances(
    answers.days,
    kinds,
    answers.goal,
    answers.level,
    answers.baseline,
  );
  const cutoff = answers.raceDate;

  const sessions: Session[] = [];
  for (let weekIndex = 0; weekIndex < PLAN_WEEKS; weekIndex += 1) {
    for (const weekday of answers.days) {
      const first = dateOnOrAfter(fromYmd, weekday);
      const date = addDaysYmd(first, weekIndex * 7);
      if (cutoff && date > cutoff) continue;

      const kind = kinds[weekday];
      const distanceKm = distances[weekday];
      const copy = SESSION_COPY[kind];
      sessions.push({
        id: newId(),
        planId: plan.id,
        userId,
        date,
        weekday,
        weekIndex,
        kind,
        title: `${copy.title} · ${distanceKm} km`,
        cue: copy.cue,
        distanceKm,
      });
    }
  }

  if (sessions.length === 0) {
    for (const weekday of answers.days) {
      const date = dateOnOrAfter(fromYmd, weekday);
      const kind = kinds[weekday];
      const distanceKm = distances[weekday];
      const copy = SESSION_COPY[kind];
      sessions.push({
        id: newId(),
        planId: plan.id,
        userId,
        date,
        weekday,
        weekIndex: 0,
        kind,
        title: `${copy.title} · ${distanceKm} km`,
        cue: copy.cue,
        distanceKm,
      });
    }
  }

  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { plan, sessions };
}

export async function completeOnboarding(
  userId: string,
  answers: OnboardingAnswers,
): Promise<{ plan: Plan; sessions: Session[] }> {
  return enqueueWrite(async () => {
    const data = await readTraining();
    const existingPlan = data.plans.find((plan) => plan.userId === userId);
    if (existingPlan) {
      return {
        plan: existingPlan,
        sessions: data.sessions.filter((session) => session.planId === existingPlan.id),
      };
    }

    const { plan, sessions } = generatePlanV1(userId, answers);
    const now = plan.createdAt;
    upsertOnboarding(data, {
      userId,
      goal: answers.goal,
      raceDate: answers.raceDate,
      level: answers.level,
      days: answers.days,
      baseline: answers.baseline,
      updatedAt: now,
      completedAt: now,
      planId: plan.id,
    });
    data.plans.push(plan);
    data.sessions.push(...sessions);
    await writeTraining(data);
    return { plan, sessions };
  });
}

function draftAnswers(draft: OnboardingRecord | null): Partial<OnboardingAnswers> {
  return {
    goal: draft?.goal,
    raceDate: draft?.raceDate ?? null,
    level: draft?.level,
    days: draft?.days,
    baseline: isBaseline(draft?.baseline) ? draft?.baseline : undefined,
  };
}

export function onboardingStep(
  draft: OnboardingRecord | null,
  requested: number | null,
): OnboardingStep {
  const max: OnboardingStep =
    draft?.goal && draft?.level && isBaseline(draft.baseline)
      ? 4
      : draft?.goal && draft?.level
        ? 3
        : draft?.goal
          ? 2
          : 1;
  if (requested === 1) return 1;
  if (requested === 2) return max >= 2 ? 2 : max;
  if (requested === 3) return max >= 3 ? 3 : max;
  if (requested === 4) return max >= 4 ? 4 : max;
  return max;
}

export async function handleOnboardingPost(
  userId: string,
  formData: FormData,
): Promise<OnboardingFormResult> {
  if (await getPlanForUser(userId)) {
    return { ok: true, redirect: "/today" };
  }

  const draft = await getOnboarding(userId);
  const intent = String(formData.get("intent") ?? "");

  if (formData.has("goal")) {
    const goalRaw = String(formData.get("goal") ?? "");
    if (!isGoal(goalRaw)) {
      return { ok: false, error: "Pick a goal to continue.", step: 1 };
    }
    const raceDate = parseRaceDate(formData.get("raceDate"), goalRaw);
    if (raceDate && typeof raceDate === "object") {
      return { ok: false, error: raceDate.error, step: 1 };
    }
    await saveOnboardingDraft(userId, { goal: goalRaw, raceDate });
    return { ok: true, redirect: "/onboarding?step=2" };
  }

  if (formData.has("level")) {
    if (!draft?.goal) {
      return { ok: false, error: "Pick a goal first.", step: 1 };
    }
    const levelRaw = String(formData.get("level") ?? "");
    if (!isLevel(levelRaw)) {
      return { ok: false, error: "Pick a level to continue.", step: 2 };
    }
    await saveOnboardingDraft(userId, { level: levelRaw });
    return { ok: true, redirect: "/onboarding?step=3" };
  }

  if (intent === "baseline") {
    if (!draft?.goal) {
      return { ok: false, error: "Pick a goal first.", step: 1 };
    }
    if (!draft?.level) {
      return { ok: false, error: "Pick a level first.", step: 2 };
    }
    const parsed = parseBaselineForm(formData);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, step: 3 };
    }
    await saveOnboardingDraft(userId, { baseline: parsed.baseline });
    return { ok: true, redirect: "/onboarding?step=4" };
  }

  if (intent === "generate") {
    const answers = draftAnswers(draft);
    if (!answers.goal) {
      return { ok: false, error: "Pick a goal first.", step: 1 };
    }
    if (!answers.level) {
      return { ok: false, error: "Pick a level first.", step: 2 };
    }
    if (!answers.baseline) {
      return { ok: false, error: "Choose a baseline, or skip for now.", step: 3 };
    }

    const days = uniqueWeekdays(formData.getAll("days").map((value) => String(value)));
    if (days.length < MIN_TRAINING_DAYS) {
      await saveOnboardingDraft(userId, { days });
      return {
        ok: false,
        error: `Pick at least ${MIN_TRAINING_DAYS} days you can run.`,
        step: 4,
      };
    }

    try {
      await completeOnboarding(userId, {
        goal: answers.goal,
        raceDate: answers.goal === "consistent" ? null : (answers.raceDate ?? null),
        level: answers.level,
        days,
        baseline: answers.baseline,
      });
      return { ok: true, redirect: "/today" };
    } catch (error) {
      console.error("[training] generate plan failed", error);
      return { ok: false, error: "Something went wrong. Try again.", step: 4 };
    }
  }

  return { ok: false, error: "Something went wrong. Try again.", step: onboardingStep(draft, null) };
}
