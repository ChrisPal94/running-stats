import { timingSafeEqual } from "node:crypto";
import { addDaysYmd, APP_TIME_ZONE, appTodayYmd, calendarTodayYmd, nextAppHourAt } from "./calendar";
import {
  WEEKDAYS,
  commitAdaptationRun,
  getAdaptationJobSnapshot,
  presentSession,
  type AdaptationDraft,
  type AdaptationJobSnapshot,
  type AdaptationSessionPatch,
  type Feedback,
  type FeedbackKind,
  type Plan,
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

function feedbackDay(feedback: Feedback, sessions: Session[]): string | null {
  const session = sessions.find((entry) => entry.id === feedback.sessionId);
  if (session) return session.date;
  const created = new Date(feedback.createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return calendarTodayYmd(created);
}

function latestFeedbackForDay(
  feedbacks: Feedback[],
  sessions: Session[],
  userId: string,
  ymd: string,
): Feedback | null {
  const matches = feedbacks.filter((entry) => {
    if (entry.userId !== userId) return false;
    return feedbackDay(entry, sessions) === ymd;
  });
  matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return matches.at(-1) ?? null;
}

function weekdayLabel(ymd: string, session?: Session | null): string {
  if (session) {
    return WEEKDAYS.find((day) => day.id === session.weekday)?.label ?? "today";
  }
  const utcDay = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const ids = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  return WEEKDAYS.find((day) => day.id === ids[utcDay])?.label ?? "today";
}

function easeFactor(signal: AdaptationSignal): number {
  if (signal === "feeling-off") return 0.75;
  if (signal === "skip") return 0.8;
  return 0.9;
}

function easedKind(signal: AdaptationSignal, kind: SessionKind): SessionKind {
  if ((signal === "skip" || signal === "feeling-off") && HARD_KINDS.has(kind)) return "easy";
  return kind;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summaryLine(tomorrow: Session | null, patch: AdaptationSessionPatch | null): string {
  if (!tomorrow) return "No session tomorrow.";
  if (!patch) {
    const label = tomorrow.title.split(" · ")[0] ?? "Tomorrow";
    return `${label} is ${tomorrow.distanceKm} km tomorrow.`;
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
  return "Higher effort yesterday.";
}

function llmConfigured(): boolean {
  return Boolean(process.env.ADAPT_LLM_API_KEY?.trim());
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
    parsed = JSON.parse(raw);
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
): Promise<LlmAdjustment | null> {
  const apiKey = process.env.ADAPT_LLM_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.ADAPT_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.ADAPT_LLM_MODEL?.trim() || "gpt-4o-mini";
  const payload = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return only JSON: {"title":"Plan adjusted","summary":string,"reason":string,"distanceKm":number,"kind":"easy"|"intervals"|"tempo"|"long"}. title must be Plan adjusted. summary: one line what changes tomorrow (e.g. Easy run shortened to 5 km). reason: one line why (e.g. Higher effort yesterday / You skipped Tuesday). Clear provisional English. No CTL/ATL/TSB jargon. No coach chat.',
      },
      {
        role: "user",
        content: JSON.stringify({
          feedback: decision.signal,
          today: todaySession
            ? {
                date: todaySession.date,
                weekday: todaySession.weekday,
                kind: todaySession.kind,
                distanceKm: todaySession.distanceKm,
              }
            : null,
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
): Promise<AdaptationDecision | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt += 1) {
    try {
      const overlay = await callLlmOnce(decision, tomorrow, todaySession);
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

function tomorrowSession(
  snapshot: AdaptationJobSnapshot,
  plan: Plan,
  tomorrowYmd: string,
): Session | null {
  return (
    snapshot.sessions.find(
      (session) =>
        session.userId === plan.userId &&
        session.planId === plan.id &&
        session.date === tomorrowYmd &&
        !session.outcome,
    ) ?? null
  );
}

export function planDecisions(
  snapshot: AdaptationJobSnapshot,
  now = new Date(),
): AdaptationDecision[] {
  const today = appTodayYmd(now);
  const tomorrowYmd = addDaysYmd(today, 1);
  const decisions: AdaptationDecision[] = [];

  for (const plan of snapshot.plans) {
    const already = snapshot.adaptationEvents.some(
      (event) => event.userId === plan.userId && event.sourceDate === today,
    );
    if (already) continue;

    const feedback = latestFeedbackForDay(snapshot.feedbacks, snapshot.sessions, plan.userId, today);
    if (!feedback) continue;

    const todaySession =
      snapshot.sessions.find((session) => session.id === feedback.sessionId) ??
      snapshot.sessions.find(
        (session) => session.userId === plan.userId && session.planId === plan.id && session.date === today,
      ) ??
      null;
    const tomorrow = tomorrowSession(snapshot, plan, tomorrowYmd);

    decisions.push(
      decideHeuristic({
        signal: feedback.kind,
        sourceDate: today,
        userId: plan.userId,
        planId: plan.id,
        todaySession,
        tomorrow,
      }),
    );
  }

  return decisions;
}

export async function runNocturnalAdaptation(now = new Date()): Promise<{
  processed: number;
  written: number;
  skipped: number;
  patched: number;
  llmFailed: number;
}> {
  const snapshot = await getAdaptationJobSnapshot();
  const planned = planDecisions(snapshot, now);
  const decisions: AdaptationDecision[] = [];
  let llmFailed = 0;

  for (const decision of planned) {
    const tomorrow = decision.draft.sessionId
      ? (snapshot.sessions.find((session) => session.id === decision.draft.sessionId) ?? null)
      : null;
    const todaySession =
      snapshot.sessions.find(
        (session) =>
          session.userId === decision.draft.userId && session.date === decision.draft.sourceDate,
      ) ?? null;

    if (llmConfigured()) {
      const llmDecision = await llmAdjustOrSkip(decision, tomorrow, todaySession);
      if (!llmDecision) {
        llmFailed += 1;
        continue;
      }
      decisions.push(llmDecision);
    } else {
      decisions.push(decision);
    }
  }

  if (decisions.length === 0) {
    return {
      processed: snapshot.plans.length,
      written: 0,
      skipped: snapshot.plans.length - planned.length + llmFailed,
      patched: 0,
      llmFailed,
    };
  }

  const written = await commitAdaptationRun({
    sessionPatches: decisions.flatMap((decision) => (decision.patch ? [decision.patch] : [])),
    drafts: decisions.map((decision) => decision.draft),
  });

  return {
    processed: snapshot.plans.length,
    written: written.length,
    skipped: snapshot.plans.length - planned.length + llmFailed,
    patched: decisions.filter((decision) => decision.patch).length,
    llmFailed,
  };
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
      console.log(
        `[adapt] wrote ${result.written} AdaptationEvent(s), patched ${result.patched} session(s) (${result.processed} plan(s) considered, ${result.skipped} skipped, ${result.llmFailed} LLM failed)`,
      );
    } catch (error) {
      console.error("[adapt] run failed; will retry at next 21:00", error);
    }
  }
}
