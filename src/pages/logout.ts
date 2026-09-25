import type { APIRoute } from "astro";
import { logoutSession } from "../lib/auth";
import { requestPublicOrigin } from "../lib/public-origin";

export const prerender = false;

/** `/login` reads `signedOut=1` and shows the all-devices confirmation. */
export const LOGGED_OUT_ALL_PATH = "/login?signedOut=1";

/**
 * POST /logout requires an Origin that matches `requestPublicOrigin()`
 * (`PUBLIC_ORIGIN`, then Astro `site`). It does not trust `X-Forwarded-Host`.
 * A missing or foreign Origin is rejected. Production without that origin
 * fails closed (`null`). Referer is not a substitute.
 * Astro's `security.checkOrigin` still runs before this handler.
 */
function logoutOriginAllowed(request: Request): boolean {
  const expected = requestPublicOrigin(request);
  if (!expected) return false;
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
