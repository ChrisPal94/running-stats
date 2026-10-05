import { timingSafeEqual } from "node:crypto";
import { adaptRunLogLine, type AdaptRunCounts } from "./adapt-cron";
import { readLlmConfig } from "./llm-config";
import {
  INTERVALS_CONNECT_UNAVAILABLE,
  INTERVALS_ENC_NOT_CONFIGURED,
  INTERVALS_RECONNECT_ERROR,
  loadRunEffort,
  openIntervalsCredentials,
  upsertPlannedRuns,
  markIntervalsNeedsReconnect,
  type PlannedRunUpload,
  type RunEffort,
} from "./intervals";
import {
  addDaysYmd,
  APP_TIME_ZONE,
  appTodayYmd,
  calendarTodayYmd,
  isEndOfAppWeek,
  isLastDayOfMonth,
  nextAppHourAt,
  startOfMonthYmd,
  startOfWeekMonday,
} from "./calendar";
import {
  WEEKDAYS,
  commitAdaptationRun,
  getAdaptationJobSnapshot,
  normalizeFeedbackCadence,
  presentSession,
  type AdaptationDraft,
  type AdaptationJobSnapshot,
  type AdaptationSessionPatch,
  type Feedback,
  type FeedbackCadence,
  type FeedbackKind,
  type Plan,
  type RunLog,
  type Session,
  type SessionKind,
} from "./training";

export type AdaptationSignal = FeedbackKind;

export type AdaptationDecision = {
  signal: AdaptationSignal;
  draft: AdaptationDraft;
  patch: AdaptationSessionPatch | null;
};

export const ADAPT_HOUR = 21;
export const PLAN_ADJUSTED_TITLE = "Plan adjusted";

const HARD_KINDS = new Set<SessionKind>(["intervals", "tempo", "long"]);
const LLM_TIMEOUT_MS = 8_000;
const LLM_ATTEMPTS = 2;
const SESSION_KINDS: SessionKind[] = ["easy", "intervals", "tempo", "long"];
const JARGON = /\b(ctl|atl|tsb|trimp|vo2(?:max)?)\b/i;

type LlmAdjustment = {
  title?: string;
  summary?: string;
  reason?: string;
  distanceKm?: number;
  kind?: SessionKind;
};

type LlmActual = {
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  source?: "manual" | "intervals";
  averageHr?: number;
  maxHr?: number;
  lthr?: number;
  athleteMaxHr?: number;
  restingHr?: number;
  /** Intervals running cadence is one foot. */
  cadenceRpm?: number;
  stepRateSpm?: number;
};

function runLogForSession(
  snapshot: AdaptationJobSnapshot,
  session: Session | null,
): RunLog | null {
  if (!session) return null;
  return (
    snapshot.runLogs.find(
      (entry) => entry.userId === session.userId && entry.sessionId === session.id,
    ) ?? null
  );
}

function runLogForSourceDay(
  snapshot: AdaptationJobSnapshot,
  userId: string,
  sourceDate: string,
  todaySession: Session | null,
): RunLog | null {
  const preferred = runLogForSession(snapshot, todaySession);
  if (preferred) return preferred;

  const sessionIds = new Set(
    snapshot.sessions
      .filter((session) => session.userId === userId && session.date === sourceDate)
      .map((session) => session.id),
  );
  return (
    snapshot.runLogs.find((entry) => entry.userId === userId && sessionIds.has(entry.sessionId)) ??
    null
  );
}

function llmActualFromRunLog(log: RunLog | null, effort: RunEffort | null = null): LlmActual | null {
  if (!log) return null;
  const actual: LlmActual = {
    distanceKm: log.distanceKm,
    timeSec: log.timeSec,
    paceSecPerKm: log.paceSecPerKm,
  };
  if (log.source === "manual" || log.source === "intervals") actual.source = log.source;
  if (!effort) return actual;
  if (effort.averageHr) actual.averageHr = effort.averageHr;
  if (effort.maxHr) actual.maxHr = effort.maxHr;
  if (effort.lthr) actual.lthr = effort.lthr;
  if (effort.athleteMaxHr) actual.athleteMaxHr = effort.athleteMaxHr;
  if (effort.restingHr) actual.restingHr = effort.restingHr;
  if (effort.cadenceRpm) actual.cadenceRpm = effort.cadenceRpm;
  const steps = stepRateSpm(effort);
  if (steps) actual.stepRateSpm = steps;
  return actual;
}

function feedbackDay(feedback: Feedback, sessions: Session[]): string | null {
  const session = sessions.find((entry) => entry.id === feedback.sessionId);
  if (session) return session.date;
  const created = new Date(feedback.createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return calendarTodayYmd(created);
}

function latestFeedbackInRange(
  feedbacks: Feedback[],
  sessions: Session[],
  userId: string,
  startYmd: string,
  endYmd: string,
): Feedback | null {
  const matches = feedbacks.filter((entry) => {
    if (entry.userId !== userId) return false;
    const day = feedbackDay(entry, sessions);
    return day !== null && day >= startYmd && day <= endYmd;
  });
  matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return matches.at(-1) ?? null;
}

/** Daily: every night. Weekly: Sunday (end of Guayaquil week). Monthly: last civil day of the month. */
export function cadenceAllowsAdapt(cadence: FeedbackCadence, ymd: string): boolean {
  if (cadence === "daily") return true;
  if (cadence === "weekly") return isEndOfAppWeek(ymd);
  return isLastDayOfMonth(ymd);
}

export function adaptFeedbackWindow(
  cadence: FeedbackCadence,
  today: string,
): { start: string; end: string } {
  if (cadence === "weekly") {
    return { start: startOfWeekMonday(today), end: today };
  }
  if (cadence === "monthly") {
    return { start: startOfMonthYmd(today), end: today };
  }
  // Yesterday through today, not today alone. The scheduled run fires in the
  // early hours of the following day, so a session the athlete ran and
  // confirmed in the evening carries yesterday's date and fell outside a
  // same-day window. That made the nightly adaptation structurally unable to
  // fire for anyone who trains later in the day. One day of lookback also
  // absorbs the scheduler running late, while still refusing to plan from a
  // stale run the way an unbounded "most recent session" window would.
  return { start: addDaysYmd(today, -1), end: today };
}

function weekdayLabel(ymd: string, session?: Session | null): string {
  if (session) {
    return WEEKDAYS.find((day) => day.id === session.weekday)?.label ?? "today";
  }
  const utcDay = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const ids = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  return WEEKDAYS.find((day) => day.id === ids[utcDay])?.label ?? "today";
}

const HIGH_HR_OF_LTHR = 0.95;
const LOAD_HR_OF_LTHR = 0.9;
const SHORT_RUN_RATIO = 0.85;
const LOW_STEP_RATE_SPM = 160;
const EASE_HIGH_HR = 0.9;
const EASE_SHORT_HARD = 0.85;

function easeFactor(signal: AdaptationSignal): number {
  if (signal === "feeling-off") return 0.75;
  if (signal === "skip") return 0.8;
  return 1;
}

function easedKind(signal: AdaptationSignal, kind: SessionKind): SessionKind {
  if ((signal === "skip" || signal === "feeling-off") && HARD_KINDS.has(kind)) return "easy";
  return kind;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summaryLine(tomorrow: Session | null, patch: AdaptationSessionPatch | null): string {
  if (!tomorrow) return "No upcoming session.";
  if (!patch) {
    const label = tomorrow.title.split(" · ")[0] ?? "Session";
    const when = weekdayLabel(tomorrow.date, tomorrow);
    return `${label} is ${tomorrow.distanceKm} km ${when}.`;
  }
  const label = patch.title.split(" · ")[0] ?? "Tomorrow";
  if (patch.distanceKm < tomorrow.distanceKm) {
    return `${label} shortened to ${patch.distanceKm} km.`;
  }
  if (patch.distanceKm > tomorrow.distanceKm) {
    return `${label} increased to ${patch.distanceKm} km.`;
  }
  return `${label} is ${patch.distanceKm} km tomorrow.`;
}

function reasonLine(signal: AdaptationSignal, sourceDate: string, todaySession: Session | null): string {
  if (signal === "skip") return `You skipped ${weekdayLabel(sourceDate, todaySession)}.`;
  if (signal === "feeling-off") {
    return `You were feeling off ${weekdayLabel(sourceDate, todaySession)}.`;
  }
  return "Run logged. Tomorrow stays.";
}

function doneHoldReason(actualKm: number | null, plannedKm: number): string {
  if (actualKm !== null && plannedKm > 0 && actualKm < plannedKm * SHORT_RUN_RATIO) {
    return "Shorter than planned, without a hard heart-rate signal. Tomorrow stays.";
  }
  return "Run logged. Tomorrow stays.";
}

function heartRateRatio(effort: RunEffort | null): number | null {
  if (!effort?.averageHr || !effort.lthr || effort.lthr <= 0) return null;
  return effort.averageHr / effort.lthr;
}

function stepRateSpm(effort: RunEffort | null): number | null {
  if (!effort) return null;
  if (effort.stepRateSpm && effort.stepRateSpm > 0) return effort.stepRateSpm;
  if (effort.cadenceRpm && effort.cadenceRpm > 0) return Math.round(effort.cadenceRpm * 2);
  return null;
}

type EffortEase = { factor: number; easeKind: boolean; reason: string };

function effortEase(
  plannedKm: number,
  actualKm: number | null,
  effort: RunEffort | null,
): EffortEase | null {
  const ratio = heartRateRatio(effort);
  if (ratio === null) return null;
  const steps = stepRateSpm(effort);
  const short = actualKm !== null && plannedKm > 0 && actualKm < plannedKm * SHORT_RUN_RATIO;
  let factor = 1;
  let easeKind = false;
  let reason = "";
  if (ratio >= HIGH_HR_OF_LTHR) {
    factor = EASE_HIGH_HR;
    easeKind = true;
    reason = "Heart rate was high yesterday.";
  }
  if (short && ratio >= LOAD_HR_OF_LTHR && EASE_SHORT_HARD < factor) {
    factor = EASE_SHORT_HARD;
    reason = "Heart rate was high on a shorter run.";
  }
  if (steps !== null && steps < LOW_STEP_RATE_SPM && ratio >= LOAD_HR_OF_LTHR && EASE_HIGH_HR < factor) {
    factor = EASE_HIGH_HR;
    reason = "Heart rate was high and step rate was low.";
  }
  if (factor >= 1) return null;
  return { factor, easeKind, reason };
}

function llmConfigured(): boolean {
  return readLlmConfig() !== null;
}

export function decideHeuristic(input: {
  signal: AdaptationSignal;
  sourceDate: string;
  userId: string;
  planId: string;
  todaySession: Session | null;
  tomorrow: Session | null;
}): AdaptationDecision {
  let patch: AdaptationSessionPatch | null = null;
  if (input.tomorrow) {
    const kind = easedKind(input.signal, input.tomorrow.kind);
    const next = presentSession(kind, input.tomorrow.distanceKm * easeFactor(input.signal));
    const unchanged = next.distanceKm === input.tomorrow.distanceKm && next.kind === input.tomorrow.kind;
    if (!unchanged) {
      patch = { id: input.tomorrow.id, ...next };
    }
  }

  return {
    signal: input.signal,
    patch,
    draft: {
      userId: input.userId,
      planId: input.planId,
      sessionId: input.tomorrow?.id,
      date: input.tomorrow?.date ?? addDaysYmd(input.sourceDate, 1),
      title: PLAN_ADJUSTED_TITLE,
      summary: summaryLine(input.tomorrow, patch),
      reason: reasonLine(input.signal, input.sourceDate, input.todaySession),
      sourceDate: input.sourceDate,
    },
  };
}

export function applyEffortToDecision(
  decision: AdaptationDecision,
  tomorrow: Session | null,
  actualKm: number | null,
  effort: RunEffort | null,
): AdaptationDecision {
  if (decision.signal !== "done" || !tomorrow || tomorrow.outcome) return decision;
  const ease = effortEase(tomorrow.distanceKm, actualKm, effort);
  if (!ease) {
    return {
      ...decision,
      patch: null,
      draft: {
        ...decision.draft,
        summary: summaryLine(tomorrow, null),
        reason: doneHoldReason(actualKm, tomorrow.distanceKm),
      },
    };
  }

  const kind = ease.easeKind && HARD_KINDS.has(tomorrow.kind) ? "easy" : tomorrow.kind;
  const next = presentSession(kind, tomorrow.distanceKm * ease.factor);
  const unchanged = next.distanceKm === tomorrow.distanceKm && next.kind === tomorrow.kind;
  const patch = unchanged ? null : { id: tomorrow.id, ...next };
  const reason = unchanged ? `${ease.reason} Tomorrow stays at the same distance.` : ease.reason;
  return {
    ...decision,
    patch,
    draft: {
      ...decision.draft,
      summary: summaryLine(tomorrow, patch),
      reason,
    },
  };
}

/** Skip and Feeling off cannot come back harder than the button ease. */
export function enforceButtonFloor(
  heuristic: AdaptationDecision,
  overlaid: AdaptationDecision,
  tomorrow: Session | null,
): AdaptationDecision {
  if (heuristic.signal === "done") return overlaid;
  const floor = heuristic.patch;
  if (!floor || !tomorrow) return overlaid;
  const patch = overlaid.patch;
  if (!patch) {
    return {
      ...overlaid,
      patch: floor,
      draft: { ...overlaid.draft, summary: summaryLine(tomorrow, floor), reason: heuristic.draft.reason },
    };
  }
  const distanceKm = Math.min(patch.distanceKm, floor.distanceKm);
  const kind = floor.kind === "easy" && patch.kind !== "easy" ? "easy" : patch.kind;
  if (distanceKm === patch.distanceKm && kind === patch.kind) return overlaid;
  const next = presentSession(kind, distanceKm);
  const capped = { id: floor.id, ...next };
  return {
    ...overlaid,
    patch: capped,
    draft: {
      ...overlaid.draft,
      summary: summaryLine(tomorrow, capped),
      reason: heuristic.draft.reason,
    },
  };
}

function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === "string" && (SESSION_KINDS as string[]).includes(value);
}

function clampDistance(original: number, next: number): number {
  const min = Math.max(2, Math.round(original * 0.5));
  const max = Math.max(min, Math.round(original * 1.2));
  return Math.min(max, Math.max(min, Math.round(next)));
}

function parseLlmAdjustment(raw: string, tomorrow: Session | null): LlmAdjustment | null {
  let parsed: unknown;
  try {
    // Providers that ignore `response_format: json_object` wrap the payload in a
    // markdown fence (measured: `gemma4:31b`). `parseCoachFeedback` already
    // tolerates this; without the same handling here every such adjustment was
    // discarded and the run silently fell back to the heuristic.
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? oneLine(record.summary) : "";
  const reason = typeof record.reason === "string" ? oneLine(record.reason) : "";
  if (!summary || !reason) return null;
  if (summary.length > 160 || reason.length > 160) return null;
  if (JARGON.test(summary) || JARGON.test(reason)) return null;
  if (summary.includes("\n") || reason.includes("\n")) return null;

  const kindRaw = record.kind;
  const kind = isSessionKind(kindRaw) ? kindRaw : undefined;
  const kmRaw = record.distanceKm;
  const distanceKm =
    typeof kmRaw === "number" && Number.isFinite(kmRaw) ? kmRaw : undefined;

  if (tomorrow) {
    if (distanceKm === undefined || !kind) return null;
  }

  return { title: PLAN_ADJUSTED_TITLE, summary, reason, distanceKm, kind };
}

function applyLlmOverlay(
  decision: AdaptationDecision,
  tomorrow: Session | null,
  overlay: LlmAdjustment,
): AdaptationDecision {
  let patch = decision.patch;
  if (tomorrow && !tomorrow.outcome && overlay.kind && overlay.distanceKm !== undefined) {
    const next = presentSession(overlay.kind, clampDistance(tomorrow.distanceKm, overlay.distanceKm));
    const unchanged = next.distanceKm === tomorrow.distanceKm && next.kind === tomorrow.kind;
    patch = unchanged ? null : { id: tomorrow.id, ...next };
  }

  return {
    signal: decision.signal,
    patch,
    draft: {
      ...decision.draft,
      title: PLAN_ADJUSTED_TITLE,
      summary: overlay.summary || decision.draft.summary,
      reason: overlay.reason || decision.draft.reason,
      sessionId: tomorrow?.id ?? decision.draft.sessionId,
      date: tomorrow?.date ?? decision.draft.date,
    },
  };
}

async function callLlmOnce(
  decision: AdaptationDecision,
  tomorrow: Session | null,
  todaySession: Session | null,
  actual: LlmActual | null,
): Promise<LlmAdjustment | null> {
  const config = readLlmConfig();
  if (!config) return null;
  const { apiKey, baseUrl, model } = config;
  const payload = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return only JSON: {"title":"Plan adjusted","summary":string,"reason":string,"distanceKm":number,"kind":"easy"|"intervals"|"tempo"|"long"}. title must be Plan adjusted. summary: one line what changes tomorrow (e.g. Easy run shortened to 5 km). reason: one line why, using the athlete feedback and the numbers, not a coach note. cadenceRpm is one-foot cadence; stepRateSpm is the full step rate. Compare actual distance and pace to the planned session. When averageHr and lthr are present, use that ratio. feedback "done" keeps tomorrow unless heart rate is high, the run was short with a high heart rate, or step rate was low under a high heart rate. feedback "skip" or "feeling-off" must not exceed proposed.distanceKm or leave kind easy when proposed.kind is easy. Do not invent missing numbers. Clear provisional English. No CTL/ATL/TSB jargon. No coach chat.',
      },
      {
        role: "user",
        content: JSON.stringify({
          feedback: decision.signal,
          proposed: decision.patch
            ? { distanceKm: decision.patch.distanceKm, kind: decision.patch.kind }
            : null,
          today: todaySession
            ? {
                date: todaySession.date,
                weekday: todaySession.weekday,
                kind: todaySession.kind,
                distanceKm: todaySession.distanceKm,
              }
            : null,
          actual,
          tomorrow: tomorrow
            ? {
                date: tomorrow.date,
                kind: tomorrow.kind,
                distanceKm: tomorrow.distanceKm,
                title: tomorrow.title,
              }
            : null,
        }),
      },
    ],
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM empty content");
  const parsed = parseLlmAdjustment(content, tomorrow);
  if (!parsed) throw new Error("LLM JSON failed validation");
  return parsed;
}

async function llmAdjustOrSkip(
  decision: AdaptationDecision,
  tomorrow: Session | null,
  todaySession: Session | null,
  actual: LlmActual | null,
): Promise<AdaptationDecision | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt += 1) {
    try {
      const overlay = await callLlmOnce(decision, tomorrow, todaySession, actual);
      if (!overlay) return null;
      return applyLlmOverlay(decision, tomorrow, overlay);
    } catch (error) {
      lastError = error;
      console.warn(
        `[adapt] LLM attempt ${attempt}/${LLM_ATTEMPTS} failed for user ${decision.draft.userId}`,
        error,
      );
    }
  }
  console.warn(
    `[adapt] LLM failed; no plan mutation (retry next run) user=${decision.draft.userId}`,
    lastError,
  );
  return null;
}

/**
 * Latest planned Session in the adapt window that has an Intervals RunLog.
 * Sync stores the RunLog and does not write Feedback, so this is the Done
 * stand-in. Manual logs, and runs with no planned Session, are ignored.
 */
function intervalsRunInWindow(
  snapshot: AdaptationJobSnapshot,
  plan: Plan,
  startYmd: string,
  endYmd: string,
): Session | null {
  const matches: { session: Session; createdAt: string }[] = [];
  for (const log of snapshot.runLogs) {
    if (log.userId !== plan.userId || log.source !== "intervals") continue;
    const session = snapshot.sessions.find(
      (entry) =>
        entry.id === log.sessionId &&
        entry.userId === plan.userId &&
        entry.planId === plan.id &&
        entry.date >= startYmd &&
        entry.date <= endYmd,
    );
    if (!session) continue;
    matches.push({ session, createdAt: log.createdAt });
  }
  matches.sort((a, b) => {
    const byDate = a.session.date.localeCompare(b.session.date);
    if (byDate !== 0) return byDate;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return matches.at(-1)?.session ?? null;
}

/** Next unfinished session after today. A rest day in between is skipped. */
function nextPlannedSession(
  snapshot: AdaptationJobSnapshot,
  plan: Plan,
  todayYmd: string,
): Session | null {
  const upcoming = snapshot.sessions
    .filter(
      (session) =>
        session.userId === plan.userId &&
        session.planId === plan.id &&
        session.date > todayYmd &&
        !session.outcome,
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return upcoming[0] ?? null;
}

export function planDecisions(
  snapshot: AdaptationJobSnapshot,
  now = new Date(),
): AdaptationDecision[] {
  const today = appTodayYmd(now);
  const decisions: AdaptationDecision[] = [];

  for (const plan of snapshot.plans) {
    const cadence = normalizeFeedbackCadence(plan.feedbackCadence);
    if (!cadenceAllowsAdapt(cadence, today)) continue;

    const window = adaptFeedbackWindow(cadence, today);
    const already = snapshot.adaptationEvents.some((event) => {
      if (event.userId !== plan.userId || !event.sourceDate) return false;
      return event.sourceDate >= window.start && event.sourceDate <= window.end;
    });
    if (already) continue;

    const feedback = latestFeedbackInRange(
      snapshot.feedbacks,
      snapshot.sessions,
      plan.userId,
      window.start,
      window.end,
    );

    // Feeling off and Skip (any explicit Feedback) win over a synced run.
    // An Intervals RunLog is Done only when that window has no Feedback.
    let signal: AdaptationSignal;
    let sourceDate: string;
    let todaySession: Session | null;
    if (feedback) {
      signal = feedback.kind;
      sourceDate = feedbackDay(feedback, snapshot.sessions) ?? today;
      todaySession =
        snapshot.sessions.find((session) => session.id === feedback.sessionId) ??
        snapshot.sessions.find(
          (session) =>
            session.userId === plan.userId && session.planId === plan.id && session.date === sourceDate,
        ) ??
        null;
    } else {
      todaySession = intervalsRunInWindow(snapshot, plan, window.start, window.end);
      if (!todaySession) continue;
      signal = "done";
      sourceDate = todaySession.date;
    }

    const tomorrow = nextPlannedSession(snapshot, plan, today);

    decisions.push(
      decideHeuristic({
        signal,
        sourceDate,
        userId: plan.userId,
        planId: plan.id,
        todaySession,
        tomorrow,
      }),
    );
  }

  return decisions;
}

function plannedUploads(snapshot: AdaptationJobSnapshot, decisions: AdaptationDecision[]): PlannedRunUpload[] {
  const uploads: PlannedRunUpload[] = [];
  for (const decision of decisions) {
    const patch = decision.patch;
    if (!patch) continue;
    const session = snapshot.sessions.find((entry) => entry.id === patch.id);
    if (!session || session.outcome) continue;
    uploads.push({
      externalId: session.id,
      date: session.date,
      name: patch.title,
      description: patch.cue,
      distanceKm: patch.distanceKm,
    });
  }
  return uploads;
}

function adaptCounts(
  processed: number,
  written: number,
  skipped: number,
  patched: number,
  llmFailed: number,
  uploaded = 0,
  uploadFailed = 0,
  noConnection = 0,
  reconnect = 0,
): AdaptRunCounts {
  return { processed, written, skipped, patched, llmFailed, uploaded, uploadFailed, noConnection, reconnect };
}

/** Planning view for one plan. Other athletes' rows are not passed to planDecisions. */
function snapshotForPlan(snapshot: AdaptationJobSnapshot, plan: Plan): AdaptationJobSnapshot {
  const userId = plan.userId;
  return {
    plans: [plan],
    sessions: snapshot.sessions.filter((session) => session.userId === userId),
    feedbacks: snapshot.feedbacks.filter((feedback) => feedback.userId === userId),
    runLogs: snapshot.runLogs.filter((log) => log.userId === userId),
    adaptationEvents: snapshot.adaptationEvents.filter((event) => event.userId === userId),
  };
}

function logAccountSkipped(error: unknown): void {
  const name = error instanceof Error ? error.name : "Error";
  console.error(`[intervals] adapt account failed ${name}`);
}

export async function runNocturnalAdaptation(
  now = new Date(),
  deps: {
    loadRunEffort?: typeof loadRunEffort;
    upsertPlannedRuns?: typeof upsertPlannedRuns;
    plannedUploads?: typeof plannedUploads;
  } = {},
): Promise<AdaptRunCounts> {
  const readEffort = deps.loadRunEffort ?? loadRunEffort;
  const uploadRuns = deps.upsertPlannedRuns ?? upsertPlannedRuns;
  const planUploads = deps.plannedUploads ?? plannedUploads;
  const snapshot = await getAdaptationJobSnapshot();
  let plannedCount = 0;
  let llmFailed = 0;
  let accountFailed = 0;
  let writtenCount = 0;
  let patched = 0;
  let uploaded = 0;
  let uploadFailed = 0;
  let noConnection = 0;
  let reconnectNeeded = 0;
  let loggedEncryption = false;
  const skippedUsers = new Set<string>();
  const reconnectUsers = new Set<string>();
  const countReconnect = (userId: string) => {
    if (reconnectUsers.has(userId)) return;
    reconnectUsers.add(userId);
    reconnectNeeded += 1;
  };
  const noteCredentialGap = (userId: string, error: string) => {
    if (error === INTERVALS_ENC_NOT_CONFIGURED || error === INTERVALS_CONNECT_UNAVAILABLE) {
      if (!loggedEncryption) {
        loggedEncryption = true;
        console.error("[intervals] encryption is not configured");
      }
      return;
    }
    if (error === INTERVALS_RECONNECT_ERROR) {
      countReconnect(userId);
      return;
    }
    if (skippedUsers.has(userId)) return;
    skippedUsers.add(userId);
    noConnection += 1;
  };

  for (const plan of snapshot.plans) {
    // `counted` is set only after this plan produced a decision. A throw before that
    // is already inside `plans - plannedCount`, so it must not also increment `accountFailed`.
    let counted = false;
    try {
      const accountSnapshot = snapshotForPlan(snapshot, plan);
      const planned = planDecisions(accountSnapshot, now);
      if (planned.length === 0) continue;
      counted = true;
      plannedCount += planned.length;

      const decisions: AdaptationDecision[] = [];
      let accountLlmFailed = 0;
      for (const plannedDecision of planned) {
        const tomorrow = plannedDecision.draft.sessionId
          ? (accountSnapshot.sessions.find((session) => session.id === plannedDecision.draft.sessionId) ?? null)
          : null;
        const todaySession =
          accountSnapshot.sessions.find(
            (session) =>
              session.userId === plannedDecision.draft.userId &&
              session.date === plannedDecision.draft.sourceDate,
          ) ?? null;
        const log = runLogForSourceDay(
          accountSnapshot,
          plannedDecision.draft.userId,
          plannedDecision.draft.sourceDate,
          todaySession,
        );
        const creds = await openIntervalsCredentials(plannedDecision.draft.userId);
        if (!creds.ok) noteCredentialGap(plannedDecision.draft.userId, creds.error);
        const effort =
          log && creds.ok
            ? await readEffort(plannedDecision.draft.userId, plannedDecision.draft.sourceDate, log.distanceKm)
            : null;
        const actual = llmActualFromRunLog(log, effort);
        let decision = applyEffortToDecision(
          plannedDecision,
          tomorrow,
          actual?.distanceKm ?? null,
          effort,
        );

        if (llmConfigured()) {
          const llmDecision = await llmAdjustOrSkip(decision, tomorrow, todaySession, actual);
          if (!llmDecision) {
            accountLlmFailed += 1;
          } else {
            decision = enforceButtonFloor(decision, llmDecision, tomorrow);
          }
        }
        decisions.push(decision);
      }

      // Session patch and AdaptationEvent share this account's commit. The Intervals
      // upload runs only after that transaction commits, so a failed commit cannot
      // leave an upload, and a rollback cannot leave an event without its session update.
      const written = await commitAdaptationRun({
        sessionPatches: decisions.flatMap((decision) => (decision.patch ? [decision.patch] : [])),
        drafts: decisions.map((decision) => decision.draft),
      });
      llmFailed += accountLlmFailed;
      writtenCount += written.length;
      patched += decisions.filter((decision) => decision.patch).length;
      for (const event of written) snapshot.adaptationEvents.push(event);

      if (written.length > 0) {
        let uploads: PlannedRunUpload[] = [];
        try {
          uploads = planUploads(accountSnapshot, decisions);
          if (uploads.length > 0) {
            const creds = await openIntervalsCredentials(plan.userId);
            if (!creds.ok) {
              noteCredentialGap(plan.userId, creds.error);
            } else {
              const result = await uploadRuns(uploads, {
                apiKey: creds.apiKey,
                authType: creds.authType,
                athletePathId: creds.athleteId,
              });
              uploaded += result.uploaded;
              uploadFailed += result.failed;
              if (result.status === 401 || result.status === 403) {
                countReconnect(plan.userId);
                try {
                  await markIntervalsNeedsReconnect(plan.userId);
                } catch (error) {
                  logAccountSkipped(error);
                }
              }
            }
          }
        } catch {
          console.error("[intervals] adapt upload failed");
          uploadFailed += uploads.length > 0 ? uploads.length : 1;
        }
      }
    } catch (error) {
      if (counted) accountFailed += 1;
      logAccountSkipped(error);
    }
  }

  const skipped = snapshot.plans.length - plannedCount + llmFailed + accountFailed;
  return adaptCounts(
    snapshot.plans.length,
    writtenCount,
    skipped,
    patched,
    llmFailed,
    uploaded,
    uploadFailed,
    noConnection,
    reconnectNeeded,
  );
}

export function adaptRequestAuthorized(request: Request): boolean {
  const secret = process.env.ADAPT_CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alt = request.headers.get("x-adapt-cron-secret")?.trim() ?? "";
  const provided = bearer || alt;
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function runAdaptCronLoop(): Promise<void> {
  console.log(`[adapt] cron loop; timezone ${APP_TIME_ZONE} hour ${ADAPT_HOUR}:00`);
  while (true) {
    const next = nextAppHourAt(ADAPT_HOUR);
    const wait = Math.max(0, next.getTime() - Date.now());
    console.log(`[adapt] next run ${next.toISOString()} (wait ${Math.round(wait / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, wait || 1000));
    try {
      const result = await runNocturnalAdaptation();
      console.log(adaptRunLogLine(result));
    } catch (error) {
      console.error("[adapt] run failed; will retry at next 21:00", error);
    }
  }
}
