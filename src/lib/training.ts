import { randomBytes } from "node:crypto";
import { addDaysYmd, appTodayYmd, endOfWeekSunday, startOfWeekMonday } from "./calendar";
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

export type OnboardingAnswers = {
  goal: Goal;
  raceDate: string | null;
  level: Level;
  days: Weekday[];
};

export type OnboardingRecord = {
  userId: string;
  goal?: Goal;
  raceDate?: string | null;
  level?: Level;
  days?: Weekday[];
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
  title: string;
  /** Why the plan changed — shown with the Today chip / Why? control. */
  reason: string;
  /** Display alias; the job writes the same text as `reason`. */
  summary?: string;
  /** Guayaquil day of the Feedback (or pending session) that triggered this event. */
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
  reason: string;
  sourceDate: string;
};

type TrainingFile = {
  onboarding: OnboardingRecord[];
  plans: Plan[];
  sessions: Session[];
  feedbacks: Feedback[];
  adaptationEvents: AdaptationEvent[];
};

const EMPTY_TRAINING: TrainingFile = {
  onboarding: [],
  plans: [],
  sessions: [],
  feedbacks: [],
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

export type OnboardingFormResult =
  | { ok: true; redirect: string }
  | { ok: false; error: string; step: 1 | 2 | 3 };

export type TodayActionResult = { redirect: string };

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
  const reason = event.reason || event.summary || "";
  return {
    ...event,
    reason,
    summary: event.summary || reason || undefined,
  };
}

async function readTraining(): Promise<TrainingFile> {
  const parsed = await readJsonFile<TrainingFile>(TRAINING_FILE, EMPTY_TRAINING);
  return {
    onboarding: Array.isArray(parsed.onboarding) ? parsed.onboarding : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [],
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
  const planned = weekSessions.length;
  const done = weekSessions.filter((session) => session.outcome === "done").length;
  const weeklyKm = weekSessions.reduce((sum, session) => sum + session.distanceKm, 0);

  return [
    {
      label: "Consistency",
      value: `${done}/${planned}`,
      provisional: false,
    },
    {
      label: "Easy pace",
      value: "—",
      provisional: true,
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

export async function getAdaptationEventForToday(userId: string): Promise<AdaptationEvent | null> {
  const today = appTodayYmd();
  const data = await readTraining();
  const matches = data.adaptationEvents.filter(
    (event) => event.userId === userId && event.date === today,
  );
  matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return matches.at(-1) ?? null;
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
        reason: draft.reason,
        summary: draft.reason,
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

    await writeTraining(data);
    return feedback;
  });
}

export async function handleTodayPost(userId: string, formData: FormData): Promise<TodayActionResult> {
  const intent = String(formData.get("intent") ?? "");
  const sessionId = String(formData.get("sessionId") ?? "");
  if (isFeedbackKind(intent) && sessionId) {
    await submitSessionFeedback(userId, sessionId, intent);
  }
  return { redirect: "/today" };
}

function upsertOnboarding(data: TrainingFile, record: OnboardingRecord): void {
  const index = data.onboarding.findIndex((entry) => entry.userId === record.userId);
  if (index >= 0) data.onboarding[index] = record;
  else data.onboarding.push(record);
}

export async function saveOnboardingDraft(
  userId: string,
  patch: Partial<Pick<OnboardingRecord, "goal" | "raceDate" | "level" | "days">>,
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
  };

  const kinds = assignKinds(answers.days);
  const distances = allocateDistances(
    answers.days,
    kinds,
    WEEKLY_KM[answers.goal][answers.level],
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
  };
}

export function onboardingStep(draft: OnboardingRecord | null, requested: number | null): 1 | 2 | 3 {
  const max: 1 | 2 | 3 = draft?.goal && draft?.level ? 3 : draft?.goal ? 2 : 1;
  if (requested === 1) return 1;
  if (requested === 2) return max >= 2 ? 2 : max;
  if (requested === 3) return max >= 3 ? 3 : max;
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

  if (intent === "generate") {
    const answers = draftAnswers(draft);
    if (!answers.goal) {
      return { ok: false, error: "Pick a goal first.", step: 1 };
    }
    if (!answers.level) {
      return { ok: false, error: "Pick a level first.", step: 2 };
    }

    const days = uniqueWeekdays(formData.getAll("days").map((value) => String(value)));
    if (days.length < MIN_TRAINING_DAYS) {
      await saveOnboardingDraft(userId, { days });
      return {
        ok: false,
        error: `Pick at least ${MIN_TRAINING_DAYS} days you can run.`,
        step: 3,
      };
    }

    try {
      await completeOnboarding(userId, {
        goal: answers.goal,
        raceDate: answers.goal === "consistent" ? null : (answers.raceDate ?? null),
        level: answers.level,
        days,
      });
      return { ok: true, redirect: "/today" };
    } catch (error) {
      console.error("[training] generate plan failed", error);
      return { ok: false, error: "Something went wrong. Try again.", step: 3 };
    }
  }

  return { ok: false, error: "Something went wrong. Try again.", step: onboardingStep(draft, null) };
}
