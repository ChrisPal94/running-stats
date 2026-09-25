import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEffortToDecision,
  decideHeuristic,
  enforceButtonFloor,
  planDecisions,
  type AdaptationDecision,
} from "./adapt.ts";
import { plannedRunEvent, upsertPlannedRuns, type RunEffort } from "./intervals.ts";
import type { AdaptationJobSnapshot, Feedback, Plan, Session } from "./training.ts";

function session(overrides: Partial<Session> & Pick<Session, "id" | "kind" | "distanceKm">): Session {
  return {
    planId: "plan-1",
    userId: "user-1",
    date: "2026-09-25",
    weekday: "fri",
    weekIndex: 1,
    title: "Tempo · 10 km",
    cue: "Comfortably hard, controlled",
    ...overrides,
  };
}

function effort(overrides: Partial<RunEffort> = {}): RunEffort {
  return {
    averageHr: null,
    maxHr: null,
    cadenceRpm: null,
    stepRateSpm: null,
    lthr: null,
    athleteMaxHr: null,
    restingHr: null,
    ...overrides,
  };
}

const tomorrow = session({ id: "tomorrow", kind: "tempo", distanceKm: 10 });

function decide(signal: "done" | "skip" | "feeling-off") {
  return decideHeuristic({
    signal,
    sourceDate: "2026-09-24",
    userId: "user-1",
    planId: "plan-1",
    todaySession: session({
      id: "today",
      kind: "easy",
      distanceKm: 9,
      date: "2026-09-24",
      weekday: "thu",
    }),
    tomorrow,
  });
}

function planFor(userId: string): Plan {
  return {
    id: "plan-1",
    userId,
    version: 1,
    createdAt: "2026-09-19T00:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["thu", "sat"],
    baseline: { kind: "skip" },
    feedbackCadence: "daily",
  };
}

function feelingOff(sessionId: string): Feedback {
  return {
    id: "fb-1",
    userId: "user-1",
    planId: "plan-1",
    sessionId,
    kind: "feeling-off",
    createdAt: "2026-09-24T15:00:00.000Z",
  };
}

describe("planDecisions next session", () => {
  const now = new Date("2026-09-24T18:00:00.000Z");

  function snapshot(sessions: Session[]): AdaptationJobSnapshot {
    return {
      plans: [planFor("user-1")],
      sessions,
      feedbacks: [feelingOff("today")],
      runLogs: [],
      adaptationEvents: [],
    };
  }

  it("eases the next planned session when tomorrow is a rest day", () => {
    const decisions = planDecisions(
      snapshot([
        session({
          id: "today",
          kind: "intervals",
          distanceKm: 13,
          date: "2026-09-24",
          weekday: "thu",
          title: "Intervals · 13 km",
        }),
        session({
          id: "saturday",
          kind: "easy",
          distanceKm: 9,
          date: "2026-09-26",
          weekday: "sat",
          title: "Easy run · 9 km",
          cue: "Keep it conversational",
        }),
      ]),
      now,
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.patch?.id, "saturday");
    assert.equal(decisions[0]?.patch?.kind, "easy");
    assert.equal(decisions[0]?.patch?.distanceKm, 7);
    assert.equal(decisions[0]?.draft.date, "2026-09-26");
  });

  it("keeps tomorrow when tomorrow has a session", () => {
    const decisions = planDecisions(
      snapshot([
        session({
          id: "today",
          kind: "intervals",
          distanceKm: 13,
          date: "2026-09-24",
          weekday: "thu",
        }),
        session({
          id: "friday",
          kind: "easy",
          distanceKm: 8,
          date: "2026-09-25",
          weekday: "fri",
          title: "Easy run · 8 km",
        }),
        session({
          id: "saturday",
          kind: "easy",
          distanceKm: 9,
          date: "2026-09-26",
          weekday: "sat",
        }),
      ]),
      now,
    );
    assert.equal(decisions[0]?.patch?.id, "friday");
    assert.equal(decisions[0]?.patch?.distanceKm, 6);
  });
});

describe("decideHeuristic", () => {
  it("leaves tomorrow unchanged after a logged run", () => {
    const decision = decide("done");
    assert.equal(decision.patch, null);
    assert.equal(decision.draft.reason, "Run logged. Tomorrow stays.");
  });

  it("eases a skipped hard session", () => {
    const decision = decide("skip");
    assert.equal(decision.patch?.kind, "easy");
    assert.equal(decision.patch?.distanceKm, 8);
    assert.match(decision.draft.reason, /skipped/i);
  });

  it("eases further when the athlete is feeling off", () => {
    const decision = decide("feeling-off");
    assert.equal(decision.patch?.kind, "easy");
    assert.equal(decision.patch?.distanceKm, 8);
    assert.match(decision.draft.reason, /feeling off/i);
  });
});

describe("applyEffortToDecision", () => {
  it("holds a shorter run that has no hard heart-rate signal", () => {
    const decision = applyEffortToDecision(decide("done"), tomorrow, 8, effort());
    assert.equal(decision.patch, null);
    assert.match(decision.draft.reason, /Shorter than planned/);
  });

  it("eases a hard kind when heart rate is at or above 95% of LTHR", () => {
    const decision = applyEffortToDecision(
      decide("done"),
      tomorrow,
      10,
      effort({ averageHr: 170, lthr: 170, stepRateSpm: 170 }),
    );
    assert.equal(decision.patch?.kind, "easy");
    assert.equal(decision.patch?.distanceKm, 9);
    assert.equal(decision.draft.reason, "Heart rate was high yesterday.");
  });

  it("eases a shorter run when heart rate is at least 90% of LTHR", () => {
    const decision = applyEffortToDecision(
      decide("done"),
      tomorrow,
      8,
      effort({ averageHr: 160, lthr: 170, stepRateSpm: 170 }),
    );
    assert.equal(decision.patch?.kind, "tempo");
    assert.equal(decision.patch?.distanceKm, 9);
    assert.equal(decision.draft.reason, "Heart rate was high on a shorter run.");
  });

  it("eases when step rate is low under a high heart rate", () => {
    const decision = applyEffortToDecision(
      decide("done"),
      tomorrow,
      10,
      effort({ averageHr: 160, lthr: 170, cadenceRpm: 75 }),
    );
    assert.equal(decision.patch?.kind, "tempo");
    assert.equal(decision.patch?.distanceKm, 9);
    assert.equal(decision.draft.reason, "Heart rate was high and step rate was low.");
  });

  it("does not undo a skip", () => {
    const skipped = decide("skip");
    const decision = applyEffortToDecision(skipped, tomorrow, 10, effort({ averageHr: 120, lthr: 170 }));
    assert.equal(decision.patch?.distanceKm, skipped.patch?.distanceKm);
    assert.equal(decision.patch?.kind, skipped.patch?.kind);
  });
});

describe("enforceButtonFloor", () => {
  it("keeps a skip from being made harder by the model", () => {
    const heuristic = decide("skip");
    const overlaid: AdaptationDecision = {
      ...heuristic,
      patch: {
        id: "tomorrow",
        kind: "tempo",
        distanceKm: 12,
        title: "Tempo · 12 km",
        cue: "Comfortably hard, controlled",
      },
      draft: { ...heuristic.draft, summary: "Tempo increased to 12 km.", reason: "Model reason." },
    };
    const capped = enforceButtonFloor(heuristic, overlaid, tomorrow);
    assert.equal(capped.patch?.kind, "easy");
    assert.equal(capped.patch?.distanceKm, 8);
    assert.equal(capped.draft.reason, heuristic.draft.reason);
  });

  it("allows the model to ease a logged run inside the existing band", () => {
    const heuristic = decide("done");
    const overlaid: AdaptationDecision = {
      ...heuristic,
      patch: {
        id: "tomorrow",
        kind: "easy",
        distanceKm: 8,
        title: "Easy run · 8 km",
        cue: "Keep it conversational",
      },
    };
    const kept = enforceButtonFloor(heuristic, overlaid, tomorrow);
    assert.equal(kept.patch?.distanceKm, 8);
    assert.equal(kept.patch?.kind, "easy");
  });
});

describe("planned run upload", () => {
  it("builds a Run workout keyed by the session id", () => {
    const event = plannedRunEvent({
      externalId: "session-1",
      date: "2026-09-25",
      name: "Easy run · 8 km",
      description: "Keep it conversational",
      distanceKm: 8.2,
    });
    assert.deepEqual(event, {
      category: "WORKOUT",
      external_id: "session-1",
      start_date_local: "2026-09-25T08:00:00",
      type: "Run",
      name: "Easy run · 8 km",
      description: "Keep it conversational",
      distance: 8200,
    });
  });

  it("rejects a workout that cannot be upserted", () => {
    assert.equal(
      plannedRunEvent({
        externalId: " ",
        date: "tomorrow",
        name: "Run",
        description: "",
        distanceKm: 0,
      }),
      null,
    );
  });

  it("skips the network when the API key is missing", async () => {
    let called = false;
    const result = await upsertPlannedRuns(
      [
        {
          externalId: "session-1",
          date: "2026-09-25",
          name: "Easy run · 8 km",
          description: "Keep it conversational",
          distanceKm: 8,
        },
      ],
      {
        apiKey: null,
        fetchImpl: async () => {
          called = true;
          return new Response("[]", { status: 200 });
        },
      },
    );
    assert.equal(called, false);
    assert.deepEqual(result, { uploaded: 0, failed: 0 });
  });

  it("skips the network when the athlete id is missing", async () => {
    let called = false;
    const result = await upsertPlannedRuns(
      [
        {
          externalId: "session-1",
          date: "2026-09-25",
          name: "Easy run · 8 km",
          description: "Keep it conversational",
          distanceKm: 8,
        },
      ],
      {
        apiKey: "test-key",
        fetchImpl: async () => {
          called = true;
          return new Response("[]", { status: 200 });
        },
      },
    );
    assert.equal(called, false);
    assert.deepEqual(result, { uploaded: 0, failed: 0 });
  });

  it("upserts with the session id and counts an HTTP failure", async () => {
    const calls: Array<{ url: string; body: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
        authorization: headers.get("authorization") ?? "",
      });
      return new Response("nope", { status: 503 });
    };
    const result = await upsertPlannedRuns(
      [
        {
          externalId: "session-1",
          date: "2026-09-25",
          name: "Easy run · 8 km",
          description: "Keep it conversational",
          distanceKm: 8,
        },
      ],
      { apiKey: "test-key", athletePathId: "i704884", fetchImpl },
    );
    assert.equal(result.failed, 1);
    assert.equal(result.uploaded, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/athlete\/i704884\/events\/bulk\?upsert=true$/);
    assert.equal(calls[0].authorization.startsWith("Basic "), true);
    assert.equal(calls[0].authorization.includes("test-key"), false);
    const body = JSON.parse(calls[0].body) as Array<Record<string, unknown>>;
    assert.equal(body[0]?.external_id, "session-1");
    assert.equal(body[0]?.distance, 8000);
    assert.equal(JSON.stringify(body).includes("test-key"), false);
  });
});
