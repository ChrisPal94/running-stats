import type { APIRoute } from "astro";
import { LOGGED_OUT_ALL_PATH, logoutSession } from "../lib/auth";
import { configuredPublicOrigin, publicOrigin } from "../lib/public-origin";

export const prerender = false;

/**
 * POST /logout requires an Origin that matches the allowed public origin.
 * `configuredPublicOrigin()` (`PUBLIC_ORIGIN`, then Astro `site`) wins, so a
 * spoofed `X-Forwarded-Host` is ignored. When that origin is unset, this falls
 * back to `publicOrigin(request)`, including in production. A missing or
 * foreign Origin is rejected. Referer is not a substitute.
 * Astro's `security.checkOrigin` still runs before this handler.
 */
function logoutOriginAllowed(request: Request): boolean {
  const expected = configuredPublicOrigin() ?? publicOrigin(request);
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !URL.canParse(origin)) return false;
  return new URL(origin).origin === expected;
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!logoutOriginAllowed(request)) {
    return new Response("Cross-site POST form submissions are forbidden", { status: 403 });
  }
  await logoutSession(cookies);
  return redirect(LOGGED_OUT_ALL_PATH);
};

/** GET does not sign out. The settings control is a POST form. */
export const GET: APIRoute = ({ redirect }) => {
  return redirect("/login");
};
