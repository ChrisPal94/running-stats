import { addDaysYmd, appTodayYmd, calendarTodayYmd } from "./calendar";
import {
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

export type AdaptationSignal = FeedbackKind | "pending";

export type AdaptationDecision = {
  signal: AdaptationSignal;
  draft: AdaptationDraft;
  patch: AdaptationSessionPatch | null;
};

const HARD_KINDS = new Set<SessionKind>(["intervals", "tempo"]);
const LLM_TIMEOUT_MS = 8_000;
const SESSION_KINDS: SessionKind[] = ["easy", "intervals", "tempo", "long"];

type LlmAdjustment = {
  title?: string;
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

function nextOpenSession(
  sessions: Session[],
  userId: string,
  planId: string,
  fromYmd: string,
): Session | null {
  return (
    sessions
      .filter(
        (session) =>
          session.userId === userId &&
          session.planId === planId &&
          session.date >= fromYmd &&
          !session.outcome,
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))[0] ?? null
  );
}

function easeFactor(signal: AdaptationSignal): number {
  if (signal === "feeling-off") return 0.75;
  if (signal === "skip") return 0.8;
  if (signal === "pending") return 0.85;
  return 1;
}

function easedKind(signal: AdaptationSignal, kind: SessionKind): SessionKind {
  if ((signal === "skip" || signal === "feeling-off") && HARD_KINDS.has(kind)) return "easy";
  return kind;
}

function reasonFor(
  signal: AdaptationSignal,
  tomorrow: Session | null,
  patch: AdaptationSessionPatch | null,
): { title: string; reason: string } {
  if (!tomorrow) {
    const unchanged = {
      done: "No session tomorrow, so the plan is unchanged after you completed today.",
      skip: "No session tomorrow, so the plan is unchanged after you skipped today.",
      "feeling-off":
        "No session tomorrow, so the plan is unchanged after you flagged that you were feeling off.",
      pending: "No session tomorrow, so the plan is unchanged after today’s session went unmarked.",
    } as const;
    return { title: "On track", reason: unchanged[signal] };
  }

  if (!patch) {
    return {
      title: "On track",
      reason: "Tomorrow stays as planned after you completed today’s session.",
    };
  }

  const changedDistance = patch.distanceKm !== tomorrow.distanceKm;
  const sessionLabel = patch.title.split(" · ")[0] ?? "Tomorrow";
  const distanceBit = changedDistance
    ? `${sessionLabel} is ${patch.distanceKm} km instead of ${tomorrow.distanceKm} km`
    : patch.title;

  if (signal === "feeling-off") {
    return {
      title: "Plan adjusted",
      reason: `${distanceBit} after you flagged that you were feeling off.`,
    };
  }
  if (signal === "skip") {
    return {
      title: "Plan adjusted",
      reason: `${distanceBit} after you skipped today’s session.`,
    };
  }
  if (signal === "pending") {
    return {
      title: "Plan adjusted",
      reason: `${distanceBit} after today’s session went unmarked.`,
    };
  }

  return {
    title: "On track",
    reason: "Tomorrow stays as planned after you completed today’s session.",
  };
}

export function decideHeuristic(input: {
  signal: AdaptationSignal;
  sourceDate: string;
  userId: string;
  planId: string;
  tomorrow: Session | null;
}): AdaptationDecision {
  let patch: AdaptationSessionPatch | null = null;
  if (input.tomorrow && input.signal !== "done") {
    const kind = easedKind(input.signal, input.tomorrow.kind);
    const next = presentSession(kind, input.tomorrow.distanceKm * easeFactor(input.signal));
    const unchanged = next.distanceKm === input.tomorrow.distanceKm && next.kind === input.tomorrow.kind;
    if (!unchanged) {
      patch = { id: input.tomorrow.id, ...next };
    }
  }

  const copy = reasonFor(input.signal, input.tomorrow, patch);
  return {
    signal: input.signal,
    patch,
    draft: {
      userId: input.userId,
      planId: input.planId,
      sessionId: input.tomorrow?.id,
      date: input.tomorrow?.date ?? addDaysYmd(input.sourceDate, 1),
      title: copy.title,
      reason: copy.reason,
      sourceDate: input.sourceDate,
    },
  };
}

function isSessionKind(value: string): value is SessionKind {
  return (SESSION_KINDS as string[]).includes(value);
}

function clampDistance(original: number, next: number): number {
  const min = Math.max(2, Math.round(original * 0.5));
  const max = Math.max(min, Math.round(original * 1.2));
  return Math.min(max, Math.max(min, Math.round(next)));
}

function applyLlmOverlay(
  decision: AdaptationDecision,
  tomorrow: Session | null,
  overlay: LlmAdjustment,
): AdaptationDecision {
  const title = overlay.title?.trim() || decision.draft.title;
  const reason = overlay.reason?.trim() || decision.draft.reason;
  let patch = decision.patch;

  if (tomorrow && !tomorrow.outcome) {
    const kind = overlay.kind && isSessionKind(overlay.kind) ? overlay.kind : (patch?.kind ?? tomorrow.kind);
    const rawKm =
      typeof overlay.distanceKm === "number" && Number.isFinite(overlay.distanceKm)
        ? overlay.distanceKm
        : (patch?.distanceKm ?? tomorrow.distanceKm);
    const next = presentSession(kind, clampDistance(tomorrow.distanceKm, rawKm));
    const unchanged = next.distanceKm === tomorrow.distanceKm && next.kind === tomorrow.kind;
    patch = unchanged ? null : { id: tomorrow.id, ...next };
  }

  return {
    signal: decision.signal,
    patch,
    draft: {
      ...decision.draft,
      sessionId: tomorrow?.id ?? decision.draft.sessionId,
      date: tomorrow?.date ?? decision.draft.date,
      title,
      reason,
    },
  };
}

async function maybeLlmAdjust(
  decision: AdaptationDecision,
  tomorrow: Session | null,
): Promise<AdaptationDecision> {
  const apiKey = process.env.ADAPT_LLM_API_KEY?.trim();
  if (!apiKey) return decision;

  const baseUrl = (process.env.ADAPT_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.ADAPT_LLM_MODEL?.trim() || "gpt-4o-mini";

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a running coach. Return JSON with keys title, reason, and optionally distanceKm and kind (easy|intervals|tempo|long). Title is a short chip (Plan adjusted or On track). Reason is one sentence for the athlete, no jargon.",
      },
      {
        role: "user",
        content: JSON.stringify({
          signal: decision.signal,
          heuristic: { title: decision.draft.title, reason: decision.draft.reason },
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

  try {
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
      console.warn(`[adapt] LLM HTTP ${response.status}; using heuristic`);
      return decision;
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return decision;
    const parsed = JSON.parse(content) as LlmAdjustment;
    return applyLlmOverlay(decision, tomorrow, parsed);
  } catch (error) {
    console.warn("[adapt] LLM failed; using heuristic", error);
    return decision;
  }
}

function pickSource(
  plan: Plan,
  sessions: Session[],
  feedbacks: Feedback[],
  sourceDatesWithEvent: Set<string>,
  today: string,
): { signal: AdaptationSignal; sourceDate: string } | null {
  const userId = plan.userId;
  if (sourceDatesWithEvent.has(today)) return null;

  const todayFeedback = latestFeedbackForDay(feedbacks, sessions, userId, today);
  if (todayFeedback) return { signal: todayFeedback.kind, sourceDate: today };

  const todaySession = sessions.find(
    (session) => session.userId === userId && session.planId === plan.id && session.date === today,
  );
  if (todaySession && !feedbacks.some((entry) => entry.sessionId === todaySession.id)) {
    return { signal: "pending", sourceDate: today };
  }

  const past = sessions
    .filter((session) => session.userId === userId && session.planId === plan.id && session.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));

  for (const session of past) {
    if (sourceDatesWithEvent.has(session.date)) continue;
    const feedback = feedbacks.find((entry) => entry.sessionId === session.id) ?? null;
    if (feedback && feedback.kind !== "done") {
      return { signal: feedback.kind, sourceDate: session.date };
    }
    if (!feedback && !session.outcome) {
      return { signal: "pending", sourceDate: session.date };
    }
  }

  return null;
}

export function planDecisions(
  snapshot: AdaptationJobSnapshot,
  now = new Date(),
): AdaptationDecision[] {
  const today = appTodayYmd(now);
  const tomorrowYmd = addDaysYmd(today, 1);
  const decisions: AdaptationDecision[] = [];

  for (const plan of snapshot.plans) {
    const sourceDatesWithEvent = new Set(
      snapshot.adaptationEvents
        .filter((event) => event.userId === plan.userId)
        .map((event) => event.sourceDate)
        .filter((value): value is string => Boolean(value)),
    );
    const source = pickSource(
      plan,
      snapshot.sessions,
      snapshot.feedbacks,
      sourceDatesWithEvent,
      today,
    );
    if (!source) continue;

    const tomorrow =
      snapshot.sessions.find(
        (session) =>
          session.userId === plan.userId &&
          session.planId === plan.id &&
          session.date === tomorrowYmd &&
          !session.outcome,
      ) ?? nextOpenSession(snapshot.sessions, plan.userId, plan.id, tomorrowYmd);

    decisions.push(
      decideHeuristic({
        signal: source.signal,
        sourceDate: source.sourceDate,
        userId: plan.userId,
        planId: plan.id,
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
}> {
  const snapshot = await getAdaptationJobSnapshot();
  const planned = planDecisions(snapshot, now);
  const decisions: AdaptationDecision[] = [];

  for (const decision of planned) {
    const tomorrow = decision.draft.sessionId
      ? (snapshot.sessions.find((session) => session.id === decision.draft.sessionId) ?? null)
      : null;
    decisions.push(await maybeLlmAdjust(decision, tomorrow));
  }

  if (decisions.length === 0) {
    return {
      processed: snapshot.plans.length,
      written: 0,
      skipped: snapshot.plans.length,
      patched: 0,
    };
  }

  const written = await commitAdaptationRun({
    sessionPatches: decisions.flatMap((decision) => (decision.patch ? [decision.patch] : [])),
    drafts: decisions.map((decision) => decision.draft),
  });

  return {
    processed: snapshot.plans.length,
    written: written.length,
    skipped: snapshot.plans.length - planned.length,
    patched: decisions.filter((decision) => decision.patch).length,
  };
}
