import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { APIContext, AstroCookies } from "astro";
import { GET, POST } from "../pages/logout.ts";
import {
  getAuthPageUser,
  getCurrentUser,
  setSessionCookie,
  SIGNUP_DUPLICATE_ERROR,
  signupFromForm,
} from "./auth.ts";
import { getDb, getUserById } from "./db.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-auth-session-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16chars";
process.env.AUTH_COOKIE_SECURE = "false";

const DUPLICATE_COPY =
  "Couldn\u2019t create your account. If you already have one, log in or continue with Google.";
const PASSWORD = "correct-horse";

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function cookieJar(): {
  cookies: AstroCookies;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  deletes: string[];
} {
  const values = new Map<string, string>();
  const deletes: string[] = [];
  const cookies = {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    set(name: string, value: string) {
      values.set(name, String(value));
    },
    delete(name: string) {
      deletes.push(name);
      values.delete(name);
    },
  };
  return {
    cookies: cookies as unknown as AstroCookies,
    get: (name) => values.get(name),
    set: (name, value) => {
      values.set(name, value);
    },
    deletes,
  };
}

function post(url: string, headers?: HeadersInit): Request {
  return new Request(url, { method: "POST", headers });
}

function passwordForm(email: string, password = PASSWORD): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

function redirect(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

function postLogout(cookies: AstroCookies): Promise<Response> {
  return POST({ cookies, redirect } as APIContext);
}

function signToken(payload: { sub: string; exp: number; epoch: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", process.env.AUTH_SECRET ?? "").update(body).digest("base64url");
  return `${body}.${sig}`;
}

function breakSignature(token: string): string {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return "not-a-session";
  const last = sig.slice(-1);
  return `${payload}.${sig.slice(0, -1)}${last === "a" ? "b" : "a"}`;
}

describe("signup duplicate email", () => {
  it("shows the neutral copy, sets no session, and leaves other validation as it was", async () => {
    const email = "signup-duplicate@example.com";
    const created = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(email),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const epoch = getUserById(created.user.id)?.sessionEpoch ?? 0;

    const jar = cookieJar();
    const again = await signupFromForm(
      post("http://localhost/signup"),
      jar.cookies,
      passwordForm(`  ${email.toUpperCase()}  `, "different-password"),
    );
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error, DUPLICATE_COPY);
    assert.equal(again.error, SIGNUP_DUPLICATE_ERROR);
    assert.equal(/already exists/i.test(again.error), false);
    assert.equal(jar.get("rs_session"), undefined);
    assert.equal(jar.deletes.length, 0);
    assert.equal(getUserById(created.user.id)?.sessionEpoch, epoch);
    assert.equal(getUserById(created.user.id)?.passwordHash === undefined, false);

    const invalidEmail = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm("not-an-email"),
    );
    assert.equal(invalidEmail.ok, false);
    if (!invalidEmail.ok) assert.equal(invalidEmail.error, "Enter a valid email.");

    const shortPassword = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm("short-pass@example.com", "short"),
    );
    assert.equal(shortPassword.ok, false);
    if (!shortPassword.ok) {
      assert.equal(shortPassword.error, "Password must be at least 8 characters.");
    }

    const crossSite = await signupFromForm(
      post("http://localhost/signup", { origin: "https://evil.example" }),
      cookieJar().cookies,
      passwordForm("cross-site@example.com"),
    );
    assert.equal(crossSite.ok, false);
    if (!crossSite.ok) {
      assert.equal(crossSite.error, "This request could not be verified. Try again.");
    }
  });
});

describe("logout ends every session", () => {
  it("bumps sessionEpoch, clears this cookie, and rejects another device", async () => {
    const email = "logout-all-devices@example.com";
    const deviceA = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), deviceA.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const before = getUserById(signed.user.id)?.sessionEpoch ?? 0;

    const deviceB = cookieJar();
    setSessionCookie(deviceB.cookies, signed.user.id);
    const otherDevice = deviceB.get("rs_session");
    assert.ok(otherDevice);
    assert.equal((await getCurrentUser(deviceB.cookies))?.id, signed.user.id);

    const response = await postLogout(deviceA.cookies);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/login");
    assert.equal(deviceA.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, before + 1);
    assert.equal(await getCurrentUser(deviceB.cookies), null);

    const revisited = await getAuthPageUser(deviceB.cookies);
    assert.equal(revisited, null);
    assert.equal(deviceB.get("rs_session"), undefined);
    assert.notEqual(otherDevice, deviceB.get("rs_session"));
  });

  it("clears the cookie and does not throw when there is no valid session", async () => {
    const email = "logout-bystander@example.com";
    const signed = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(email),
    );
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;

    const empty = cookieJar();
    const missing = await postLogout(empty.cookies);
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.get("Location"), "/login");
    assert.equal(empty.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

    const garbage = cookieJar();
    garbage.set("rs_session", "garbage");
    const cleared = await postLogout(garbage.cookies);
    assert.equal(cleared.status, 302);
    assert.equal(garbage.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

    const stale = cookieJar();
    stale.set(
      "rs_session",
      signToken({
        sub: signed.user.id,
        exp: Date.now() + 60_000,
        epoch: epoch - 1,
      }),
    );
    await postLogout(stale.cookies);
    assert.equal(stale.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
  });

  it("keeps logout on POST so Astro's origin check still applies", async () => {
    const config = readFileSync(join(process.cwd(), "astro.config.mjs"), "utf8");
    assert.match(config, /checkOrigin:\s*true/);
    const route = readFileSync(join(process.cwd(), "src/pages/logout.ts"), "utf8");
    assert.match(route, /logoutSession/);
    assert.doesNotMatch(route, /checkOrigin:\s*false/);

    const settings = readFileSync(join(process.cwd(), "src/pages/settings.astro"), "utf8");
    assert.match(settings, /<form method="post" action="\/logout"/);
    assert.match(settings, />\s*Log out\s*</);
    assert.match(settings, /Signs you out on all your devices\./);
    assert.doesNotMatch(settings, /confirm\(/);

    const email = "logout-get-keeps-session@example.com";
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const token = jar.get("rs_session");
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;
    const response = await GET({ redirect } as APIContext);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/login");
    assert.equal(jar.get("rs_session"), token);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);
  });
});

describe("invalid rs_session on login and signup", () => {
  it("deletes a bad, expired, stale, or garbage cookie and still returns no user", async () => {
    for (const page of ["src/pages/login.astro", "src/pages/signup.astro"]) {
      const source = readFileSync(join(process.cwd(), page), "utf8");
      assert.match(source, /getAuthPageUser\(Astro\.cookies\)/);
      assert.doesNotMatch(source, /return new Response\(/);
    }

    const email = "stale-cookie@example.com";
    const signed = await signupFromForm(
      post("http://localhost/signup"),
      cookieJar().cookies,
      passwordForm(email),
    );
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;

    const fresh = signToken({ sub: signed.user.id, exp: Date.now() + 60_000, epoch });
    const valid = cookieJar();
    valid.set("rs_session", fresh);
    assert.equal((await getAuthPageUser(valid.cookies))?.id, signed.user.id);
    assert.equal(valid.get("rs_session"), fresh);
    assert.deepEqual(valid.deletes, []);

    const absent = cookieJar();
    assert.equal(await getAuthPageUser(absent.cookies), null);
    assert.deepEqual(absent.deletes, []);

    const cases: Array<[string, string]> = [
      ["bad signature", breakSignature(fresh)],
      ["expired", signToken({ sub: signed.user.id, exp: Date.now() - 5_000, epoch })],
      ["stale epoch", signToken({ sub: signed.user.id, exp: Date.now() + 60_000, epoch: epoch - 1 })],
      ["garbage", "garbage"],
      ["empty", ""],
    ];
    for (const [label, token] of cases) {
      const jar = cookieJar();
      jar.set("rs_session", token);
      const user = await getAuthPageUser(jar.cookies);
      assert.equal(user, null, label);
      assert.equal(jar.get("rs_session"), undefined, label);
      assert.deepEqual(jar.deletes, ["rs_session"], label);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch, label);
    }

    getDb().prepare("UPDATE users SET sessionEpoch = sessionEpoch + 4 WHERE id = ?").run(signed.user.id);
    const staleDb = cookieJar();
    staleDb.set("rs_session", fresh);
    assert.equal(await getAuthPageUser(staleDb.cookies), null);
    assert.equal(staleDb.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 4);
  });
});
