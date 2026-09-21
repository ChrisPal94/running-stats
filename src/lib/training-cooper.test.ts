import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addDaysYmd, appTodayYmd } from "./calendar.ts";
import { loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import type { IntervalsRunStats } from "./intervals.ts";
import {
  applyIntervalsRuns,
  baselineFitnessFactor,
  BASELINE_KINDS,
  COOPER_PENDING_HINT,
  cooperPendingHint,
  generatePlanV1,
  handleOnboardingPost,
  isBaseline,
  parseBaselineForm,
  type OnboardingAnswers,
  type Session,
} from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-cooper-"));
process.env.AUTH_DATA_DIR = dataDir;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const FROM_YMD = "2026-09-14";
const DAYS = ["mon", "wed", "fri"] as const;

function answers(baseline: OnboardingAnswers["baseline"]): OnboardingAnswers {
  return {
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: [...DAYS],
    baseline,
    feedbackCadence: "daily",
  };
}

function sessionsSorted(sessions: Session[]): Pick<Session, "date" | "kind" | "title" | "distanceKm" | "cue">[] {
  return sessions
    .map(({ date, kind, title, distanceKm, cue }) => ({ date, kind, title, distanceKm, cue }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe("cooper-pending Today hint", () => {
  it("shows the hint only for a cooper-pending baseline", () => {
    assert.equal(cooperPendingHint({ kind: "cooper-pending" }), COOPER_PENDING_HINT);
    assert.equal(cooperPendingHint({ kind: "cooper", distanceKm: 2.8, durationSec: 720 }), null);
    assert.equal(cooperPendingHint({ kind: "skip" }), null);
    assert.equal(cooperPendingHint(undefined), null);
  });

  it("the hint copy mentions the 12-minute test and Intervals.icu", () => {
    assert.equal(
      COOPER_PENDING_HINT,
      "Cooper result pending — run your 12-minute test and sync Intervals.icu.",
    );
  });
});

describe("cooper-pending baseline model", () => {
  it("lists cooper-pending in BASELINE_KINDS and accepts it via isBaseline", () => {
    assert.equal(BASELINE_KINDS.includes("cooper-pending"), true);
    assert.equal(isBaseline({ kind: "cooper-pending" }), true);
  });

  it("keeps legacy cooper records fully valid", () => {
    assert.equal(isBaseline({ kind: "cooper", distanceKm: 2.4, durationSec: 720 }), true);
  });

  it("parseBaselineForm maps the cooper radio to cooper-pending without manual input", () => {
    const formData = new FormData();
    formData.set("baselineKind", "cooper");
    formData.set("cooperDistance", "2.4");
    formData.set("cooperUnit", "km");

    const parsed = parseBaselineForm(formData);
    assert.deepEqual(parsed, { ok: true, baseline: { kind: "cooper-pending" } });
  });

  it("baselineFitnessFactor treats cooper-pending as absent (factor 1)", () => {
    for (const level of ["beginner", "intermediate", "advanced"] as const) {
      assert.equal(baselineFitnessFactor({ kind: "cooper-pending" }, level), 1);
    }
    assert.equal(baselineFitnessFactor(null, "beginner"), 1);
    assert.equal(baselineFitnessFactor(undefined, "beginner"), 1);
    assert.equal(baselineFitnessFactor({ kind: "skip" }, "beginner"), 1);
  });

  it("baselineFitnessFactor still clamps legacy cooper records to ±20%", () => {
    const fast = baselineFitnessFactor({ kind: "cooper", distanceKm: 5, durationSec: 720 }, "beginner");
    assert.equal(fast, 1.2);
    const slow = baselineFitnessFactor({ kind: "cooper", distanceKm: 0.9, durationSec: 720 }, "beginner");
    assert.equal(slow, 0.8);
    const inBand = baselineFitnessFactor({ kind: "cooper", distanceKm: 2.0, durationSec: 720 }, "intermediate");
    assert.ok(inBand > 0.8 && inBand < 1.2);
  });

  it("generatePlanV1 with cooper-pending produces the same distances as skip", () => {
    const pending = generatePlanV1("user-pending", answers({ kind: "cooper-pending" }), FROM_YMD);
    const skipped = generatePlanV1("user-skipped", answers({ kind: "skip" }), FROM_YMD);

    assert.deepEqual(sessionsSorted(pending.sessions), sessionsSorted(skipped.sessions));
    assert.deepEqual(pending.plan.baseline, { kind: "cooper-pending" });
  });
});

describe("onboarding baseline POST error echo", () => {
  function seedDraft(userId: string): void {
    saveTrainingSnapshot({
      onboarding: [
        {
          userId,
          goal: "5k",
          raceDate: null,
          level: "beginner",
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      plans: [],
      sessions: [],
      feedbacks: [],
      runLogs: [],
      adaptationEvents: [],
    });
  }

  it("returns the submitted baseline form values when the last-race time fails to parse", async () => {
    seedDraft("baseline-echo");
    const formData = new FormData();
    formData.set("intent", "baseline");
    formData.set("baselineKind", "last-race");
    formData.set("lastRaceDistance", "5k");
    formData.set("lastRaceTime", "25:30");

    const result = await handleOnboardingPost("baseline-echo", formData);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Enter your time as hh:mm:ss.");
    assert.equal(result.step, 3);
    assert.deepEqual(result.form, {
      baselineKind: "last-race",
      lastRaceDistance: "5k",
      lastRaceCustomKm: "",
      lastRaceTime: "25:30",
      lastRaceDate: "",
    });
  });

  it("asks for a baseline option when no kind is submitted and echoes an empty kind", async () => {
    seedDraft("baseline-neutral");
    const formData = new FormData();
    formData.set("intent", "baseline");

    const result = await handleOnboardingPost("baseline-neutral", formData);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Pick a baseline option.");
    assert.deepEqual(result.form, {
      baselineKind: "",
      lastRaceDistance: "",
      lastRaceCustomKm: "",
      lastRaceTime: "",
      lastRaceDate: "",
    });
  });

  it("still parses a cooper submit and stores cooper-pending", async () => {
    seedDraft("baseline-cooper");
    const formData = new FormData();
    formData.set("intent", "baseline");
    formData.set("baselineKind", "cooper");

    const result = await handleOnboardingPost("baseline-cooper", formData);

    assert.deepEqual(result, { ok: true, redirect: "/onboarding?step=4" });
    assert.deepEqual(loadTrainingSnapshot().onboarding.find((entry) => entry.userId === "baseline-cooper")?.baseline, {
      kind: "cooper-pending",
    });
  });
});

function runStats(date: string, activityId: string, distanceKm: number, timeSec: number): IntervalsRunStats {
  return {
    activityId,
    date,
    distanceKm,
    timeSec,
    paceSecPerKm: timeSec / distanceKm,
    start_date_local: `${date}T07:15:00`,
  };
}

const WEEKDAY_BY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function weekdayOf(ymd: string): (typeof WEEKDAY_BY_INDEX)[number] {
  return WEEKDAY_BY_INDEX[new Date(`${ymd}T12:00:00.000Z`).getUTCDay()];
}

function futurePlanDayDates(today: string, count: number): string[] {
  const dates: string[] = [];
  for (let offset = 1; offset <= 21 && dates.length < count; offset += 1) {
    const ymd = addDaysYmd(today, offset);
    if ((DAYS as readonly string[]).includes(weekdayOf(ymd))) dates.push(ymd);
  }
  return dates;
}

function pastPlanDayDate(today: string): string {
  for (let offset = 1; offset <= 7; offset += 1) {
    const ymd = addDaysYmd(today, -offset);
    if ((DAYS as readonly string[]).includes(weekdayOf(ymd))) return ymd;
  }
  throw new Error("no past plan day within a week");
}

function cooperSeed(userId: string): { planId: string; past: Session; future: Session[] } {
  const today = appTodayYmd();
  const futureDates = futurePlanDayDates(today, 2);
  const pastDate = pastPlanDayDate(today);
  const planId = `${userId}-plan`;

  const sessions: Session[] = [
    {
      id: `${userId}-past`,
      planId,
      userId,
      date: pastDate,
      weekday: weekdayOf(pastDate),
      weekIndex: 0,
      kind: "easy",
      title: "Easy run · 8 km",
      cue: "Keep it conversational",
      distanceKm: 8,
    },
    ...futureDates.map((date, index) => ({
      id: `${userId}-future-${index}`,
      planId,
      userId,
      date,
      weekday: weekdayOf(date),
      weekIndex: index,
      kind: weekdayOf(date) === "fri" ? ("long" as const) : ("intervals" as const),
      title: `Session ${index} · 8 km`,
      cue: "Keep it conversational",
      distanceKm: 8,
    })),
  ];

  saveTrainingSnapshot({
    onboarding: [
      {
        userId,
        goal: "5k",
        raceDate: null,
        level: "beginner",
        days: [...DAYS],
        baseline: { kind: "cooper-pending" },
        feedbackCadence: "daily",
        updatedAt: "2026-09-01T12:00:00.000Z",
        completedAt: "2026-09-01T12:00:00.000Z",
        planId,
      },
    ],
    plans: [
      {
        id: planId,
        userId,
        version: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
        goal: "5k",
        raceDate: null,
        level: "beginner",
        days: [...DAYS],
        baseline: { kind: "cooper-pending" },
        feedbackCadence: "daily",
      },
    ],
    sessions,
    feedbacks: [],
    runLogs: [],
    adaptationEvents: [],
  });

  return {
    planId,
    past: sessions[0] as Session,
    future: sessions.slice(1) as Session[],
  };
}

describe("Cooper pending baseline via Intervals sync", () => {
  it("resolves cooper-pending from a ~720s Run anywhere in the fetch and re-adjusts future sessions", async () => {
    const userId = "cooper-resolve";
    const { planId, past, future } = cooperSeed(userId);
    const today = appTodayYmd();
    const pastDate = past.date;
    // The Cooper candidate is on a day with no planned session: matching is independent.
    const reference = generatePlanV1("cooper-reference", answers({ kind: "cooper", distanceKm: 2.8, durationSec: 720 }), today);

    const result = await applyIntervalsRuns(userId, [
      runStats(pastDate, "act-planned", 8.05, 2415),
      runStats(addDaysYmd(today, -2), "act-cooper", 2.8, 700),
    ]);

    const snapshot = loadTrainingSnapshot();
    const plan = snapshot.plans.find((entry) => entry.id === planId);
    const onboarding = snapshot.onboarding.find((entry) => entry.userId === userId);

    assert.equal(result.cooperResolved, true);
    assert.deepEqual(plan?.baseline, { kind: "cooper", distanceKm: 2.8, durationSec: 720 });
    assert.deepEqual(onboarding?.baseline, { kind: "cooper", distanceKm: 2.8, durationSec: 720 });

    // Future sessions re-adjust to the now-present baseline; past sessions are untouched.
    const stored = snapshot.sessions.filter((entry) => entry.planId === planId);
    const storedPast = stored.find((entry) => entry.id === past.id);
    assert.equal(storedPast?.distanceKm, past.distanceKm);
    assert.equal(storedPast?.title, past.title);
    for (const futureSession of future) {
      const storedFuture = stored.find((entry) => entry.id === futureSession.id);
      const expected =
        reference.sessions.find((entry) => entry.weekday === futureSession.weekday)?.distanceKm;
      assert.equal(storedFuture?.distanceKm, expected);
      assert.equal(storedFuture?.title, `${storedFuture?.title.split(" · ")[0]} · ${expected} km`);
    }

    // The shared test store accumulates events across cases, so scope by user.
    const events = snapshot.adaptationEvents.filter((entry) => entry.userId === userId);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.userId, userId);
    assert.equal(event?.planId, planId);
    assert.equal(event?.title, "Cooper test synced");
    assert.equal(event?.summary, "Plan adjusted to your Cooper baseline — future sessions updated.");
    assert.equal(
      event?.reason,
      "Your 12-minute run of 2.80 km set your baseline; future sessions were recomputed from it.",
    );
    assert.equal(event?.date, today);
    assert.equal(event?.sourceDate, undefined);
  });

  it("writes no AdaptationEvent when nothing changed and no Cooper candidate exists", async () => {
    const userId = "cooper-no-event-no-candidate";
    const { planId } = cooperSeed(userId);
    const today = appTodayYmd();

    const result = await applyIntervalsRuns(userId, [
      runStats(addDaysYmd(today, -1), "act-long", 5, 900),
    ]);

    const snapshot = loadTrainingSnapshot();
    assert.equal(result.cooperResolved, false);
    assert.deepEqual(snapshot.plans.find((entry) => entry.id === planId)?.baseline, {
      kind: "cooper-pending",
    });
    assert.equal(snapshot.adaptationEvents.filter((entry) => entry.userId === userId).length, 0);
  });

  it("writes no AdaptationEvent when the baseline resolves but no future session changes", async () => {
    const userId = "cooper-no-changed-sessions";
    const planId = `${userId}-plan`;
    const today = appTodayYmd();
    const pastDate = pastPlanDayDate(today);

    saveTrainingSnapshot({
      onboarding: [
        {
          userId,
          goal: "5k",
          raceDate: null,
          level: "beginner",
          days: [...DAYS],
          baseline: { kind: "cooper-pending" },
          feedbackCadence: "daily",
          updatedAt: "2026-09-01T12:00:00.000Z",
          completedAt: "2026-09-01T12:00:00.000Z",
          planId,
        },
      ],
      plans: [
        {
          id: planId,
          userId,
          version: 1,
          createdAt: "2026-09-01T12:00:00.000Z",
          goal: "5k",
          raceDate: null,
          level: "beginner",
          days: [...DAYS],
          baseline: { kind: "cooper-pending" },
          feedbackCadence: "daily",
        },
      ],
      sessions: [
        {
          id: `${userId}-past`,
          planId,
          userId,
          date: pastDate,
          weekday: weekdayOf(pastDate),
          weekIndex: 0,
          kind: "easy",
          title: "Easy run · 8 km",
          cue: "Keep it conversational",
          distanceKm: 8,
        },
      ],
      feedbacks: [],
      runLogs: [],
      adaptationEvents: [],
    });

    const result = await applyIntervalsRuns(userId, [
      runStats(addDaysYmd(today, -2), "act-cooper", 2.8, 700),
    ]);

    const snapshot = loadTrainingSnapshot();
    assert.equal(result.cooperResolved, true);
    assert.deepEqual(snapshot.plans.find((entry) => entry.id === planId)?.baseline, {
      kind: "cooper",
      distanceKm: 2.8,
      durationSec: 720,
    });
    assert.equal(snapshot.adaptationEvents.filter((entry) => entry.userId === userId).length, 0);
  });

  it("picks the Cooper candidate closest to 720s inside the 660–780s and 0.5–5 km band", async () => {
    const userId = "cooper-closest";
    const { planId } = cooperSeed(userId);
    const today = appTodayYmd();

    const result = await applyIntervalsRuns(userId, [
      runStats(addDaysYmd(today, -3), "act-short", 1.2, 670),
      runStats(addDaysYmd(today, -2), "act-close", 2.5, 735),
      runStats(addDaysYmd(today, -1), "act-far", 4.5, 775),
    ]);

    assert.equal(result.cooperResolved, true);
    assert.deepEqual(loadTrainingSnapshot().plans.find((entry) => entry.id === planId)?.baseline, {
      kind: "cooper",
      distanceKm: 2.5,
      durationSec: 720,
    });
  });

  it("does not resolve when the Run is outside the Cooper duration band", async () => {
    const userId = "cooper-out-of-band";
    const { planId, past, future } = cooperSeed(userId);
    const today = appTodayYmd();

    const result = await applyIntervalsRuns(userId, [
      runStats(addDaysYmd(today, -1), "act-long", 5, 900),
      runStats(addDaysYmd(today, -2), "act-short", 1.0, 600),
    ]);

    const snapshot = loadTrainingSnapshot();
    const plan = snapshot.plans.find((entry) => entry.id === planId);
    assert.equal(result.cooperResolved, false);
    assert.deepEqual(plan?.baseline, { kind: "cooper-pending" });
    const stored = snapshot.sessions.filter((entry) => entry.planId === planId);
    for (const session of [past, ...future]) {
      const unchanged = stored.find((entry) => entry.id === session.id);
      assert.equal(unchanged?.distanceKm, session.distanceKm);
      assert.equal(unchanged?.title, session.title);
    }
  });

  it("is idempotent: a second sync after resolution never re-resolves", async () => {
    const userId = "cooper-idempotent";
    const { planId, future } = cooperSeed(userId);
    const today = appTodayYmd();

    await applyIntervalsRuns(userId, [runStats(addDaysYmd(today, -2), "act-cooper", 2.8, 700)]);
    const afterFirst = loadTrainingSnapshot();
    const firstSessions = afterFirst.sessions.filter((entry) => entry.planId === planId);

    const second = await applyIntervalsRuns(userId, [runStats(addDaysYmd(today, -1), "act-again", 3.0, 740)]);

    const snapshot = loadTrainingSnapshot();
    const plan = snapshot.plans.find((entry) => entry.id === planId);
    assert.equal(second.cooperResolved, false);
    assert.deepEqual(plan?.baseline, { kind: "cooper", distanceKm: 2.8, durationSec: 720 });
    assert.equal(snapshot.adaptationEvents.filter((entry) => entry.userId === userId).length, 1);
    for (const session of future) {
      const before = firstSessions.find((entry) => entry.id === session.id);
      const after = snapshot.sessions.find((entry) => entry.id === session.id);
      assert.deepEqual(
        { distanceKm: after?.distanceKm, title: after?.title },
        { distanceKm: before?.distanceKm, title: before?.title },
      );
    }
  });
});