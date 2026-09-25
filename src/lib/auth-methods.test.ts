import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it } from "node:test";
import { transform } from "@astrojs/compiler-rs";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import {
  authOptionsClause,
  isGoogleLoginConfigured,
  isMagicLinkConfigured,
  signupDuplicateMessage,
} from "./auth-methods.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-auth-methods-"));
const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "RESEND_API_KEY",
  "MAIL_FROM",
  "MAGIC_LINK_FROM",
  "PUBLIC_ORIGIN",
  "NODE_ENV",
] as const;

const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearAuthEnv(): void {
  for (const key of ENV_KEYS) {
    if (key === "NODE_ENV") continue;
    delete process.env[key];
  }
}

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  restoreEnv();
});

function alertText(html: string): string {
  const match = html.match(/role="alert">([\s\S]*?)<\/p>/);
  assert.ok(match, "expected a duplicate-account alert");
  return (match[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

let authFormRender: Promise<(props: Record<string, unknown>) => Promise<string>> | undefined;

function renderAuthForm(props: Record<string, unknown>): Promise<string> {
  authFormRender ??= (async () => {
    const sourceUrl = new URL("../components/AuthForm.astro", import.meta.url);
    const compiled = transform(readFileSync(sourceUrl, "utf8"), {
      filename: "AuthForm.astro",
      resolvePath: (specifier) => specifier,
    });
    const errors = compiled.diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((item) => item.text).join("\n"));
    const code = compiled.code
      .replaceAll(
        'from "../lib/auth-methods"',
        `from ${JSON.stringify(new URL("./auth-methods.ts", import.meta.url).href)}`,
      )
      .replaceAll(
        'from "astro/runtime/server/index.js"',
        `from ${JSON.stringify(new URL("../../node_modules/astro/dist/runtime/server/index.js", import.meta.url).href)}`,
      );
    const file = join(dataDir, "AuthForm.compiled.mts");
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as { default: AstroComponentFactory };
    const { experimental_AstroContainer: AstroContainer } = await import("astro/container");
    const container = await AstroContainer.create();
    return (next: Record<string, unknown>) => container.renderToString(mod.default, { props: next });
  })();
  return authFormRender.then((render) => render(props));
}

function formProps(): Record<string, unknown> {
  return {
    email: "runner@example.com",
    error: signupDuplicateMessage(),
    passwordAutocomplete: "new-password",
    footerHref: "/login",
    footerLabel: "Already training? Log in",
    googleFrom: "signup",
    method: "password",
  };
}

describe("isGoogleLoginConfigured", () => {
  it("is false until client id, secret, and callback are all non-blank", () => {
    clearAuthEnv();
    assert.equal(isGoogleLoginConfigured(), false);
    process.env.GOOGLE_CLIENT_ID = " client ";
    process.env.GOOGLE_CLIENT_SECRET = " secret ";
    assert.equal(isGoogleLoginConfigured(), false);
    process.env.GOOGLE_CALLBACK_URL = "   ";
    assert.equal(isGoogleLoginConfigured(), false);
    process.env.GOOGLE_CALLBACK_URL = " http://localhost:4321/auth/google/callback ";
    assert.equal(isGoogleLoginConfigured(), true);
  });
});

describe("isMagicLinkConfigured", () => {
  it("requires a Resend key and a from address", () => {
    clearAuthEnv();
    assert.equal(isMagicLinkConfigured(), false);
    process.env.RESEND_API_KEY = " re_test ";
    assert.equal(isMagicLinkConfigured(), false);
    process.env.MAIL_FROM = "   ";
    process.env.MAGIC_LINK_FROM = " ";
    assert.equal(isMagicLinkConfigured(), false);
    process.env.MAGIC_LINK_FROM = " stride@example.com ";
    assert.equal(isMagicLinkConfigured(), true);
    delete process.env.MAGIC_LINK_FROM;
    process.env.MAIL_FROM = " stride@example.com ";
    assert.equal(isMagicLinkConfigured(), true);
  });

  it("also requires a configured public origin in production", () => {
    clearAuthEnv();
    process.env.NODE_ENV = "production";
    process.env.RESEND_API_KEY = "re_test";
    process.env.MAIL_FROM = "stride@example.com";
    delete process.env.PUBLIC_ORIGIN;
    assert.equal(isMagicLinkConfigured(), false);
    process.env.PUBLIC_ORIGIN = " https://running-stats-production.up.railway.app/ ";
    assert.equal(isMagicLinkConfigured(), true);
    process.env.PUBLIC_ORIGIN = "not a url";
    assert.equal(isMagicLinkConfigured(), false);
  });
});

describe("signupDuplicateMessage", () => {
  it("names only the configured sign-in methods", () => {
    clearAuthEnv();
    assert.equal(
      signupDuplicateMessage(),
      "Couldn’t create your account. If you already have one, log in.",
    );
    assert.equal(authOptionsClause(), "email and password");

    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
    assert.equal(
      signupDuplicateMessage(),
      "Couldn’t create your account. If you already have one, log in or continue with Google.",
    );
    assert.equal(authOptionsClause(), "email and password or continue with Google");

    delete process.env.GOOGLE_CLIENT_ID;
    process.env.RESEND_API_KEY = "re_test";
    process.env.MAIL_FROM = "stride@example.com";
    assert.equal(
      signupDuplicateMessage(),
      "Couldn’t create your account. If you already have one, log in or sign in with an email link.",
    );
    assert.equal(authOptionsClause(), "email and password or an email link");

    process.env.GOOGLE_CLIENT_ID = "id";
    assert.equal(
      signupDuplicateMessage(),
      "Couldn’t create your account. If you already have one, log in, sign in with an email link, or continue with Google.",
    );
    assert.equal(authOptionsClause(), "email and password, an email link, or continue with Google");
  });
});

describe("auth form methods", () => {
  it("shows links and controls only for configured methods", async () => {
    const cases = [
      {
        label: "neither",
        setup() {
          clearAuthEnv();
        },
        emailLink: false,
        google: false,
      },
      {
        label: "google",
        setup() {
          clearAuthEnv();
          process.env.GOOGLE_CLIENT_ID = "id";
          process.env.GOOGLE_CLIENT_SECRET = "secret";
          process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
        },
        emailLink: false,
        google: true,
      },
      {
        label: "email link",
        setup() {
          clearAuthEnv();
          process.env.RESEND_API_KEY = "re_test";
          process.env.MAIL_FROM = "stride@example.com";
        },
        emailLink: true,
        google: false,
      },
      {
        label: "both",
        setup() {
          clearAuthEnv();
          process.env.GOOGLE_CLIENT_ID = "id";
          process.env.GOOGLE_CLIENT_SECRET = "secret";
          process.env.GOOGLE_CALLBACK_URL = "http://localhost:4321/auth/google/callback";
          process.env.RESEND_API_KEY = "re_test";
          process.env.MAIL_FROM = "stride@example.com";
        },
        emailLink: true,
        google: true,
      },
    ] as const;

    for (const item of cases) {
      item.setup();
      const html = await renderAuthForm(formProps());
      assert.equal(alertText(html), signupDuplicateMessage(), item.label);
      assert.equal(html.includes('href="/login"'), true, item.label);
      assert.equal(html.includes("Email link"), item.emailLink, item.label);
      assert.equal(html.includes("/login?method=link"), item.emailLink, item.label);
      const forcedLink = await renderAuthForm({ ...formProps(), method: "link" });
      assert.equal(forcedLink.includes("Email me a link"), item.emailLink, item.label);
      assert.equal(html.includes("Continue with Google"), item.google, item.label);
      assert.equal(html.includes("/auth/google?from=signup"), item.google, item.label);
      if (!item.emailLink) assert.equal(html.includes("method=link"), false, item.label);
      if (!item.google) assert.equal(html.includes("continue with Google"), false, item.label);
    }
  });
});
