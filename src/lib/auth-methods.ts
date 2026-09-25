import { configuredPublicOrigin, isProductionRuntime } from "./public-origin";

function trimmedEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Google sign-in can run only when every OAuth value is set and not blank. */
export function isGoogleLoginConfigured(): boolean {
  return Boolean(
    trimmedEnv("GOOGLE_CLIENT_ID") && trimmedEnv("GOOGLE_CLIENT_SECRET") && trimmedEnv("GOOGLE_CALLBACK_URL"),
  );
}

/**
 * Magic-link send can run when Resend is configured (`RESEND_API_KEY` and
 * `MAIL_FROM`, or `MAGIC_LINK_FROM` if `MAIL_FROM` is unset). Production also
 * needs `configuredPublicOrigin()`; without it the send path fails closed.
 * Dev may fall back to the request origin, so the public origin is not required.
 */
export function isMagicLinkConfigured(): boolean {
  const from = trimmedEnv("MAIL_FROM") || trimmedEnv("MAGIC_LINK_FROM");
  if (!trimmedEnv("RESEND_API_KEY") || !from) return false;
  if (isProductionRuntime() && !configuredPublicOrigin()) return false;
  return true;
}

/** Visible clause after “Sign in with” / “Start your plan with”. */
export function authOptionsClause(): string {
  const magic = isMagicLinkConfigured();
  const google = isGoogleLoginConfigured();
  if (magic && google) return "email and password, an email link, or continue with Google";
  if (magic) return "email and password or an email link";
  if (google) return "email and password or continue with Google";
  return "email and password";
}

/**
 * Duplicate password signup. Does not say whether the address is registered.
 * Names only the sign-in methods that are configured.
 */
export function signupDuplicateMessage(): string {
  const magic = isMagicLinkConfigured();
  const google = isGoogleLoginConfigured();
  const prefix = "Couldn’t create your account. If you already have one, ";
  if (magic && google) {
    return `${prefix}log in, sign in with an email link, or continue with Google.`;
  }
  if (google) return `${prefix}log in or continue with Google.`;
  if (magic) return `${prefix}log in or sign in with an email link.`;
  return `${prefix}log in.`;
}
