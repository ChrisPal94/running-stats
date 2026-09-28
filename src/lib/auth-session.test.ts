import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { APIContext, AstroCookies } from "astro";
import { signupDuplicateMessage } from "./auth-methods.ts";
import { postAuthPath, requireAppSession } from "./app-session.ts";
import {
  getAuthPageUser,
  getCurrentUser,
  loginFromForm,
  LOGGED_OUT_ALL_PATH,
  setGoogleOAuthState,
  setSessionCookie,
  signupFromForm,
} from "./auth.ts";
import { GET, POST } from "../pages/logout.ts";
import { getDb, getUserById } from "./db.ts";
import { finishGoogleOAuth } from "./google-oauth.ts";
import { finishMagicLink, issueMagicLinkToken } from "./magic-link.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-auth-session-"));
process.env.AUTH_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "test-auth-secret-16chars";
process.env.AUTH_COOKIE_SECURE = "false";

const PASSWORD = "correct-horse";

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

type CookieAttrs = {
  httpOnly?: boolean;
  sameSite?: string | boolean;
  path?: string;
  secure?: boolean;
  maxAge?: number;
};

/**
 * Mirrors Astro's cookie jar: `has()` is true for an empty `name=` request
 * cookie, while `get()` returns undefined for that same value. `set` and
 * `delete` keep the attributes so a deletion can be compared to the set cookie.
 */
function cookieJar(requestCookie?: string): {
  cookies: AstroCookies;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  deletes: string[];
  setAttrs: Map<string, CookieAttrs>;
  deleteAttrs: Map<string, CookieAttrs | undefined>;
} {
  const values = new Map<string, { value: string; fromRequest: boolean }>();
  if (requestCookie) {
    for (const part of requestCookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 1) continue;
      const name = part.slice(0, eq).trim();
      if (!name) continue;
      values.set(name, { value: part.slice(eq + 1), fromRequest: true });
    }
  }
  const setAttrs = new Map<string, CookieAttrs>();
  const deleteAttrs = new Map<string, CookieAttrs | undefined>();
  const deletes: string[] = [];
  const cookies = {
    has(name: string) {
      return values.has(name);
    },
    get(name: string) {
      const stored = values.get(name);
      if (!stored) return undefined;
      if (stored.fromRequest && stored.value === "") return undefined;
      return { value: stored.value };
    },
    set(name: string, value: string, options?: CookieAttrs) {
      values.set(name, { value: String(value), fromRequest: false });
      if (options) setAttrs.set(name, options);
      deleteAttrs.delete(name);
      const index = deletes.indexOf(name);
      if (index >= 0) deletes.splice(index, 1);
    },
    delete(name: string, options?: CookieAttrs) {
      deletes.push(name);
      deleteAttrs.set(name, options);
      values.delete(name);
    },
  };
  return {
    cookies: cookies as unknown as AstroCookies,
    get: (name) => {
      const stored = values.get(name);
      return stored?.value;
    },
    set: (name, value) => {
      values.set(name, { value, fromRequest: false });
    },
    deletes,
    setAttrs,
    deleteAttrs,
  };
}

function sharedCookieAttrs(options: CookieAttrs | undefined) {
  return {
    path: options?.path,
    sameSite: options?.sameSite,
    secure: options?.secure,
    httpOnly: options?.httpOnly,
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

function logoutRequest(headers?: HeadersInit): Request {
  return new Request("http://localhost/logout", {
    method: "POST",
    headers: headers ?? { origin: "http://localhost" },
  });
}

function postLogout(cookies: AstroCookies, request = logoutRequest()): Promise<Response> {
  return Promise.resolve(POST({ cookies, request, redirect } as APIContext));
}

function tokenEpoch(token: string | undefined): number {
  assert.ok(token);
  const payload = token.split(".")[0] ?? "";
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { epoch?: number };
  return typeof data.epoch === "number" ? data.epoch : 0;
}

function insertPlan(userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO plans (id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson, feedbackCadence)
       VALUES (?, ?, 1, ?, 'consistency', NULL, 'intermediate', '[]', NULL, 'daily')`,
    )
    .run(`plan-${userId}`, userId, new Date().toISOString());
}

function astroSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...astroSources(path));
    else if (entry.name.endsWith(".astro")) files.push(path);
  }
  return files;
}

async function googleSession(email: string, sub: string): Promise<ReturnType<typeof cookieJar>> {
  const previousFetch = globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
  const jar = cookieJar();
  const nonce = setGoogleOAuthState(jar.cookies, "login", "pkce-verifier-value");
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token")) return Response.json({ access_token: "access-token" });
    if (url.includes("userinfo")) return Response.json({ sub, email, email_verified: true });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const request = new Request(
      `http://localhost:4321/auth/google/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
    );
    const { location } = await finishGoogleOAuth(request, jar.cookies);
    assert.equal(location, "/onboarding");
    return jar;
  } finally {
    globalThis.fetch = previousFetch;
  }
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
    assert.equal(again.error, signupDuplicateMessage());
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
    assert.equal(response.headers.get("Location"), LOGGED_OUT_ALL_PATH);
    assert.deepEqual(
      sharedCookieAttrs(deviceA.deleteAttrs.get("rs_session")),
      sharedCookieAttrs(deviceA.setAttrs.get("rs_session")),
    );
    assert.equal(deviceA.setAttrs.get("rs_session")?.path, "/");
    assert.equal(deviceA.setAttrs.get("rs_session")?.sameSite, "lax");
    assert.equal(deviceA.setAttrs.get("rs_session")?.httpOnly, true);
    assert.equal(deviceA.setAttrs.get("rs_session")?.secure, false);
    assert.equal(deviceA.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, before + 1);
    assert.equal(await getCurrentUser(deviceB.cookies), null);

    const revisited = await getAuthPageUser(deviceB.cookies);
    assert.equal(revisited, null);
    assert.equal(deviceB.get("rs_session"), undefined);
    assert.notEqual(otherDevice, deviceB.get("rs_session"));

    const again = cookieJar();
    const logged = await loginFromForm(post("http://localhost/login"), again.cookies, passwordForm(email));
    assert.equal(logged.ok, true);
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;
    assert.equal(epoch, before + 1);
    assert.equal(tokenEpoch(again.get("rs_session")), epoch);
    assert.equal((await getCurrentUser(again.cookies))?.id, signed.user.id);
    assert.equal(await getCurrentUser(deviceB.cookies), null);
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
    assert.equal(missing.headers.get("Location"), LOGGED_OUT_ALL_PATH);
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

  it("GET logout does not log out or bump the epoch", async () => {
    const config = readFileSync(join(process.cwd(), "astro.config.mjs"), "utf8");
    assert.match(config, /checkOrigin:\s*true/);
    for (const file of astroSources(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /href=["']\/logout["']/);
    }
    const settings = readFileSync(join(process.cwd(), "src/pages/settings.astro"), "utf8");
    assert.match(settings, /<form method="post" action="\/logout"/);
    assert.match(settings, />\s*Log out\s*</);
    assert.match(settings, /id="logout-all-devices"/);
    assert.match(settings, /aria-describedby="logout-all-devices"/);
    assert.match(settings, /id="logout-all-devices" class="mt-1 /);
    const helpAt = settings.indexOf('id="logout-all-devices"');
    const labelAt = settings.indexOf("Log out");
    assert.ok(helpAt !== -1 && labelAt !== -1 && helpAt < labelAt);
    assert.match(settings, /Signs you out on all your devices\./);
    assert.doesNotMatch(settings, /confirm\(/);
    const login = readFileSync(join(process.cwd(), "src/pages/login.astro"), "utf8");
    assert.match(login, /signedOut/);
    assert.match(login, /You’re signed out on all your devices\./);

    const email = "logout-get-keeps-session@example.com";
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const token = jar.get("rs_session");
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;
    const response = await GET({
      cookies: jar.cookies,
      request: new Request("http://localhost/logout"),
      redirect,
    } as APIContext);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/login");
    assert.equal(jar.get("rs_session"), token);
    assert.equal(jar.deletes.length, 0);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);
  });

  it("rejects a foreign or missing Origin with 403 and leaves the session", async () => {
    const email = "logout-origin@example.com";
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    const token = jar.get("rs_session");
    const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;

    const foreign = await postLogout(
      jar.cookies,
      logoutRequest({ origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }),
    );
    assert.equal(foreign.status, 403);
    assert.equal(jar.get("rs_session"), token);
    assert.equal(jar.deletes.length, 0);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);

    const missing = await postLogout(jar.cookies, new Request("http://localhost/logout", { method: "POST" }));
    assert.equal(missing.status, 403);
    assert.equal(jar.get("rs_session"), token);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);

    const refererOnly = await postLogout(
      jar.cookies,
      logoutRequest({ referer: "http://localhost/settings" }),
    );
    assert.equal(refererOnly.status, 403);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);
    assert.equal((await getCurrentUser(jar.cookies))?.id, signed.user.id);

    const proxied = await postLogout(
      jar.cookies,
      new Request("http://10.0.0.1:8080/logout", {
        method: "POST",
        headers: {
          origin: "https://running-stats-production.up.railway.app",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "running-stats-production.up.railway.app",
          host: "10.0.0.1:8080",
        },
      }),
    );
    assert.equal(proxied.status, 302);
    assert.equal(proxied.headers.get("Location"), LOGGED_OUT_ALL_PATH);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 1);
    assert.equal(jar.get("rs_session"), undefined);
  });

  it("logs out for PUBLIC_ORIGIN and ignores a spoofed X-Forwarded-Host", async () => {
    const previousOrigin = process.env.PUBLIC_ORIGIN;
    const previousSecure = process.env.AUTH_COOKIE_SECURE;
    process.env.PUBLIC_ORIGIN = "https://running-stats-production.up.railway.app/";
    process.env.AUTH_COOKIE_SECURE = "true";
    try {
      const email = "logout-public-origin@example.com";
      const jar = cookieJar();
      const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
      assert.equal(signed.ok, true);
      if (!signed.ok) return;
      const token = jar.get("rs_session");
      const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;

      const foreign = await postLogout(
        jar.cookies,
        new Request("http://10.0.0.1:8080/logout", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "running-stats-production.up.railway.app",
            host: "10.0.0.1:8080",
          },
        }),
      );
      assert.equal(foreign.status, 403);
      assert.equal(jar.get("rs_session"), token);
      assert.equal(jar.deletes.length, 0);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

      const spoofedHost = await postLogout(
        jar.cookies,
        new Request("http://10.0.0.1:8080/logout", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "evil.example",
            host: "evil.example",
          },
        }),
      );
      assert.equal(spoofedHost.status, 403);
      assert.equal(jar.get("rs_session"), token);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

      const good = await postLogout(
        jar.cookies,
        new Request("http://10.0.0.1:8080/logout", {
          method: "POST",
          headers: {
            origin: "https://running-stats-production.up.railway.app",
            "x-forwarded-proto": "http",
            "x-forwarded-host": "evil.example",
            host: "evil.example",
          },
        }),
      );
      assert.equal(good.status, 302);
      assert.equal(good.headers.get("Location"), LOGGED_OUT_ALL_PATH);
      assert.equal(jar.get("rs_session"), undefined);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 1);
      assert.deepEqual(
        sharedCookieAttrs(jar.deleteAttrs.get("rs_session")),
        sharedCookieAttrs(jar.setAttrs.get("rs_session")),
      );
      assert.equal(jar.deleteAttrs.get("rs_session")?.secure, true);
      assert.equal(jar.deleteAttrs.get("rs_session")?.httpOnly, true);
      assert.equal(jar.deleteAttrs.get("rs_session")?.sameSite, "lax");
      assert.equal(jar.deleteAttrs.get("rs_session")?.path, "/");
    } finally {
      if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = previousOrigin;
      if (previousSecure === undefined) delete process.env.AUTH_COOKIE_SECURE;
      else process.env.AUTH_COOKIE_SECURE = previousSecure;
    }
  });

  it("logs out in production when PUBLIC_ORIGIN is unset and Origin matches the request", async () => {
    const previousOrigin = process.env.PUBLIC_ORIGIN;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_ORIGIN;
    try {
      const email = "logout-prod-request-origin@example.com";
      const jar = cookieJar();
      const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
      assert.equal(signed.ok, true);
      if (!signed.ok) return;
      const token = jar.get("rs_session");
      const epoch = getUserById(signed.user.id)?.sessionEpoch ?? 0;
      const sameOrigin = new Request("http://10.0.0.1:8080/logout", {
        method: "POST",
        headers: {
          origin: "https://running-stats-production.up.railway.app",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "running-stats-production.up.railway.app",
          host: "10.0.0.1:8080",
        },
      });

      const missing = await postLogout(jar.cookies, new Request("http://10.0.0.1:8080/logout", { method: "POST" }));
      assert.equal(missing.status, 403);
      assert.equal(jar.get("rs_session"), token);

      const foreign = await postLogout(
        jar.cookies,
        new Request("http://10.0.0.1:8080/logout", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "running-stats-production.up.railway.app",
            host: "10.0.0.1:8080",
          },
        }),
      );
      assert.equal(foreign.status, 403);
      assert.equal(jar.get("rs_session"), token);
      assert.equal(jar.deletes.length, 0);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch);

      const allowed = await postLogout(jar.cookies, sameOrigin);
      assert.equal(allowed.status, 302);
      assert.equal(allowed.headers.get("Location"), LOGGED_OUT_ALL_PATH);
      assert.equal(jar.get("rs_session"), undefined);
      assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 1);
    } finally {
      if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = previousOrigin;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("invalidates a Google session and a magic-link session", async () => {
    const google = await googleSession("logout-google@example.com", "logout-google-sub");
    const googleUser = await getCurrentUser(google.cookies);
    assert.ok(googleUser);
    const googleOther = cookieJar();
    setSessionCookie(googleOther.cookies, googleUser.id);
    const googleEpoch = getUserById(googleUser.id)?.sessionEpoch ?? 0;
    const googleLoggedOut = await postLogout(google.cookies);
    assert.equal(googleLoggedOut.status, 302);
    assert.equal(getUserById(googleUser.id)?.sessionEpoch, googleEpoch + 1);
    assert.equal(await getCurrentUser(google.cookies), null);
    assert.equal(await getCurrentUser(googleOther.cookies), null);
    const googleAgain = await googleSession("logout-google@example.com", "logout-google-sub");
    const googleBack = await getCurrentUser(googleAgain.cookies);
    assert.equal(googleBack?.id, googleUser.id);
    assert.equal(tokenEpoch(googleAgain.get("rs_session")), getUserById(googleUser.id)?.sessionEpoch);

    const magicEmail = "logout-magic@example.com";
    const magic = cookieJar();
    const issued = issueMagicLinkToken(magicEmail);
    const finished = await finishMagicLink(
      new Request(`http://localhost/auth/magic?token=${encodeURIComponent(issued.raw)}`),
      magic.cookies,
    );
    assert.equal(finished.location, "/onboarding");
    const magicUser = await getCurrentUser(magic.cookies);
    assert.ok(magicUser);
    const magicOther = cookieJar();
    setSessionCookie(magicOther.cookies, magicUser.id);
    const magicEpoch = getUserById(magicUser.id)?.sessionEpoch ?? 0;
    const magicLoggedOut = await postLogout(magic.cookies);
    assert.equal(magicLoggedOut.status, 302);
    assert.equal(getUserById(magicUser.id)?.sessionEpoch, magicEpoch + 1);
    assert.equal(await getCurrentUser(magic.cookies), null);
    assert.equal(await getCurrentUser(magicOther.cookies), null);
    const magicAgain = cookieJar();
    const reissued = issueMagicLinkToken(magicEmail);
    const resigned = await finishMagicLink(
      new Request(`http://localhost/auth/magic?token=${encodeURIComponent(reissued.raw)}`),
      magicAgain.cookies,
    );
    assert.equal(resigned.location, "/onboarding");
    assert.equal((await getCurrentUser(magicAgain.cookies))?.id, magicUser.id);
    assert.equal(tokenEpoch(magicAgain.get("rs_session")), getUserById(magicUser.id)?.sessionEpoch);
    assert.equal(await getCurrentUser(magicOther.cookies), null);
  });

  it("redirects a copied pre-logout cookie to /login on today, settings, and intervals", async () => {
    const email = "copied-cookie@example.com";
    const jar = cookieJar();
    const signed = await signupFromForm(post("http://localhost/signup"), jar.cookies, passwordForm(email));
    assert.equal(signed.ok, true);
    if (!signed.ok) return;
    insertPlan(signed.user.id);
    const copiedToken = jar.get("rs_session");
    assert.ok(copiedToken);
    const copied = cookieJar();
    copied.set("rs_session", copiedToken);
    const before = await requireAppSession(copied.cookies);
    assert.equal(before.ok, true);

    await postLogout(jar.cookies);
    const gate = await requireAppSession(copied.cookies);
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.redirect, "/login");

    const today = readFileSync(join(process.cwd(), "src/pages/today.astro"), "utf8");
    const settings = readFileSync(join(process.cwd(), "src/pages/settings.astro"), "utf8");
    assert.match(today, /requireAppSession\(Astro\.cookies\)/);
    assert.match(today, /return Astro\.redirect\(gate\.redirect\)/);
    assert.match(settings, /requireAppSession\(Astro\.cookies\)/);
    assert.match(settings, /return Astro\.redirect\(gate\.redirect\)/);
    assert.ok(settings.indexOf("requireAppSession") < settings.indexOf("handleSettingsPost"));
    assert.ok(settings.includes("intervals-"));
  });
});

describe("invalid rs_session on login and signup", () => {
  it("deletes a bad, expired, stale, or garbage cookie and still returns no user", async () => {
    for (const page of ["src/pages/login.astro", "src/pages/signup.astro"]) {
      const source = readFileSync(join(process.cwd(), page), "utf8");
      assert.match(source, /getAuthPageUser\(Astro\.cookies\)/);
      assert.match(source, /postAuthPath\(existing\.id\)/);
      assert.match(source, /return Astro\.redirect\(signedInPath\)/);
      assert.doesNotMatch(source, /return new Response\(/);
    }

    const returning = cookieJar();
    const withPlan = await signupFromForm(
      post("http://localhost/signup"),
      returning.cookies,
      passwordForm("valid-session-today@example.com"),
    );
    assert.equal(withPlan.ok, true);
    if (!withPlan.ok) return;
    const kept = returning.get("rs_session");
    insertPlan(withPlan.user.id);
    assert.equal((await getAuthPageUser(returning.cookies))?.id, withPlan.user.id);
    assert.equal(returning.get("rs_session"), kept);
    assert.deepEqual(returning.deletes, []);
    assert.equal(await postAuthPath(withPlan.user.id), "/today");

    const freshSignup = cookieJar();
    const noPlan = await signupFromForm(
      post("http://localhost/signup"),
      freshSignup.cookies,
      passwordForm("valid-session-onboarding@example.com"),
    );
    assert.equal(noPlan.ok, true);
    if (!noPlan.ok) return;
    const signupToken = freshSignup.get("rs_session");
    assert.equal((await getAuthPageUser(freshSignup.cookies))?.id, noPlan.user.id);
    assert.equal(freshSignup.get("rs_session"), signupToken);
    assert.deepEqual(freshSignup.deletes, []);
    assert.equal(await postAuthPath(noPlan.user.id), "/onboarding");

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
      assert.deepEqual(
        sharedCookieAttrs(jar.deleteAttrs.get("rs_session")),
        {
          path: "/",
          sameSite: "lax",
          secure: false,
          httpOnly: true,
        },
        label,
      );
    }

    const blank = cookieJar("rs_session=");
    assert.equal(blank.cookies.has("rs_session"), true);
    assert.equal(blank.cookies.get("rs_session"), undefined);
    assert.equal(await getAuthPageUser(blank.cookies), null);
    assert.deepEqual(blank.deletes, ["rs_session"]);

    getDb().prepare("UPDATE users SET sessionEpoch = sessionEpoch + 4 WHERE id = ?").run(signed.user.id);
    const staleDb = cookieJar();
    staleDb.set("rs_session", fresh);
    assert.equal(await getAuthPageUser(staleDb.cookies), null);
    assert.equal(staleDb.get("rs_session"), undefined);
    assert.equal(getUserById(signed.user.id)?.sessionEpoch, epoch + 4);
  });
});
