import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import type { APIContext, AstroCookies } from "astro";
import { POST } from "../pages/logout.ts";
import { getCurrentUser, signupFromForm } from "./auth.ts";
import { getIntervalsConnection, getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import { applySettingsPost } from "./settings-post.ts";
import { readFormData } from "./safe-form-data.ts";
import { applyTodayPost } from "./today-post.ts";
import type { Plan, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-form-post-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16chars";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 9).toString("base64");

const STACK_MARKERS = ["TypeError", "\n    at ", "formData is not a function"];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|astro)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function cookieJar(): { cookies: AstroCookies; get(name: string): string | undefined } {
  const values = new Map<string, string>();
  const cookies = {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    set(name: string, value: string) {
      values.set(name, String(value));
    },
    delete(name: string) {
      values.delete(name);
    },
  };
  return { cookies: cookies as unknown as AstroCookies, get: (name) => values.get(name) };
}

function redirect(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

function postLogout(cookies: AstroCookies, request: Request): Promise<Response> {
  return Promise.resolve(POST({ cookies, request, redirect } as APIContext));
}

function request(url: string, contentType: string | null, body?: string, origin = "http://localhost"): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (contentType) headers.set("content-type", contentType);
  return new Request(url, { method: "POST", headers, body });
}

async function assertBadForm(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  const text = await response.text();
  assert.equal(text, "Expected a form submission.");
  for (const marker of STACK_MARKERS) assert.equal(text.includes(marker), false);
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
});

describe("readFormData", () => {
  it("returns null for JSON, a missing type, text, and a broken multipart body", async () => {
    assert.equal(await readFormData(request("http://localhost/x", "application/json", "{\"a\":1}")), null);
    assert.equal(await readFormData(request("http://localhost/x", null, "a=1")), null);
    assert.equal(await readFormData(request("http://localhost/x", "text/plain", "hello")), null);
    assert.equal(
      await readFormData(request("http://localhost/x", "multipart/form-data", "not-a-body")),
      null,
    );
  });

  it("parses a urlencoded form", async () => {
    const data = await readFormData(
      request("http://localhost/x", "application/x-www-form-urlencoded", "intent=skip&sessionId=s1"),
    );
    assert.ok(data);
    assert.equal(data?.get("intent"), "skip");
    assert.equal(data?.get("sessionId"), "s1");
  });
});

describe("POST routes reject non-form bodies", () => {
  it("only the shared helper calls request.formData()", () => {
    const offenders = sourceFiles(join(process.cwd(), "src")).filter((file) => {
      if (file.endsWith(`${join("lib", "safe-form-data.ts")}`)) return false;
      return /\.formData\s*\(/.test(readFileSync(file, "utf8"));
    });
    assert.deepEqual(offenders, []);
  });

  it("logout: JSON and a missing type are 400, a form still signs out, origin stays first", async () => {
    const email = "form-logout@example.com";
    const jar = cookieJar();
    const signed = await signupFromForm(
      request("http://localhost/signup", "application/x-www-form-urlencoded"),
      jar.cookies,
      form({ email, password: "correct-horse" }),
    );
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;
    const token = jar.get("rs_session");

    const json = await postLogout(
      jar.cookies,
      request("http://localhost/logout", "application/json", "{\"intent\":\"logout\"}"),
    );
    await assertBadForm(json);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal(jar.get("rs_session"), token);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);

    const missing = await postLogout(jar.cookies, request("http://localhost/logout", null));
    await assertBadForm(missing);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);

    const foreign = await postLogout(
      jar.cookies,
      request("http://localhost/logout", "application/json", "{\"a\":1}", "https://evil.example"),
    );
    assert.equal(foreign.status, 403);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

    const formLogout = await postLogout(
      jar.cookies,
      request("http://localhost/logout", "application/x-www-form-urlencoded", ""),
    );
    assert.equal(formLogout.status, 302);
    assert.equal(formLogout.headers.get("Location"), "/login");
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 1);
    assert.equal(jar.get("rs_session"), undefined);
  });

  it("intervals connect: JSON, missing type, and broken multipart are 400; a form still connects", async () => {
    const userId = "form-connect";
    insertUser({ id: userId, email: "connect-form@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ id: "i123456" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const before = getIntervalsConnection(userId);
    assert.equal(before, null);

    for (const posted of [
      request("http://localhost/settings", "application/json", "{\"intent\":\"intervals-connect\"}"),
      request("http://localhost/settings", null, "intent=intervals-connect"),
      request("http://localhost/settings", "text/plain", "intent=intervals-connect"),
      request("http://localhost/settings", "multipart/form-data", "broken"),
    ]) {
      const outcome = await applySettingsPost(posted, userId, "daily");
      assert.equal(outcome.kind, "response");
      if (outcome.kind !== "response") continue;
      await assertBadForm(outcome.response);
      assert.equal(getIntervalsConnection(userId), null);
    }

    const cross = await applySettingsPost(
      request(
        "http://localhost/settings",
        "application/x-www-form-urlencoded",
        "intent=intervals-connect&intervalsApiKey=secret-key&intervalsAthleteId=i123456",
        "https://evil.example",
      ),
      userId,
      "daily",
    );
    assert.equal(cross.kind, "response");
    if (cross.kind === "response") assert.equal(cross.response.status, 403);
    assert.equal(getIntervalsConnection(userId), null);

    const ok = await applySettingsPost(
      request(
        "http://localhost/settings",
        "application/x-www-form-urlencoded",
        "intent=intervals-connect&intervalsApiKey=secret-key&intervalsAthleteId=i123456",
      ),
      userId,
      "daily",
    );
    assert.equal(ok.kind, "redirect");
    if (ok.kind === "redirect") assert.equal(ok.location, "/settings");
    const stored = getIntervalsConnection(userId);
    assert.equal(stored?.athleteId, "i123456");
    assert.equal(JSON.stringify(stored).includes("secret-key"), false);
  });

  it("feedback: JSON and a missing type are 400; a form still records skip; origin stays first", async () => {
    const userId = "form-feedback";
    insertUser({ id: userId, email: "feedback-form@example.com", createdAt: "2026-09-01T00:00:00.000Z" });
    const plan: Plan = {
      id: `${userId}-plan`,
      userId,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      goal: "5k",
      raceDate: null,
      level: "beginner",
      days: ["mon"],
      feedbackCadence: "daily",
    };
    const session: Session = {
      id: `${userId}-session`,
      planId: plan.id,
      userId,
      date: "2026-09-14",
      weekday: "mon",
      weekIndex: 0,
      kind: "easy",
      title: "Easy run",
      cue: "Easy",
      distanceKm: 5,
    };
    saveTrainingSnapshot(
      { onboarding: [], plans: [plan], sessions: [session], feedbacks: [], runLogs: [], adaptationEvents: [] },
      "replace",
    );

    const feedbackCount = () => loadTrainingSnapshot().feedbacks.filter((entry) => entry.userId === userId).length;

    for (const posted of [
      request("http://localhost/today", "application/json", "{\"intent\":\"skip\"}"),
      request("http://localhost/today", null),
      request("http://localhost/today", "text/plain", "intent=skip"),
      request("http://localhost/today", "multipart/form-data; boundary=----x", "garbage"),
    ]) {
      const outcome = await applyTodayPost(posted, userId);
      assert.equal(outcome.kind, "response");
      if (outcome.kind !== "response") continue;
      await assertBadForm(outcome.response);
      assert.equal(feedbackCount(), 0);
    }

    const foreign = await applyTodayPost(
      request(
        "http://localhost/today",
        "application/json",
        "{\"intent\":\"skip\",\"sessionId\":\"form-feedback-session\"}",
        "https://evil.example",
      ),
      userId,
    );
    assert.equal(foreign.kind, "redirect");
    if (foreign.kind === "redirect") assert.equal(foreign.location, "/today");
    assert.equal(feedbackCount(), 0);

    const ok = await applyTodayPost(
      request(
        "http://localhost/today",
        "application/x-www-form-urlencoded",
        `intent=skip&sessionId=${encodeURIComponent(session.id)}`,
      ),
      userId,
    );
    assert.equal(ok.kind, "redirect");
    if (ok.kind === "redirect") assert.equal(ok.location, "/today");
    const stored = loadTrainingSnapshot();
    assert.equal(stored.feedbacks.filter((entry) => entry.userId === userId).length, 1);
    assert.equal(stored.feedbacks.find((entry) => entry.userId === userId)?.kind, "skip");
    assert.equal(stored.sessions.find((entry) => entry.id === session.id)?.outcome, "skipped");
  });
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
