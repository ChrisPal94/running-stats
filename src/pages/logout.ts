import type { APIRoute } from "astro";
import { logoutSession } from "../lib/auth";
import { publicOrigin } from "../lib/public-origin";
import { invalidFormResponse, readFormData } from "../lib/safe-form-data";

export const prerender = false;

/**
 * POST /logout requires an Origin that matches the public host.
 * A missing or foreign Origin is rejected. Referer is not a substitute.
 * Astro's `security.checkOrigin` still runs before this handler.
 */
function logoutOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !URL.canParse(origin)) return false;
  return new URL(origin).origin === publicOrigin(request);
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!logoutOriginAllowed(request)) {
    return new Response("Cross-site POST form submissions are forbidden", { status: 403 });
  }
  const formData = await readFormData(request);
  if (!formData) return invalidFormResponse();
  await logoutSession(cookies);
  return redirect("/login");
};

/** GET does not sign out. The settings control is a POST form. */
export const GET: APIRoute = ({ redirect }) => {
  return redirect("/login");
};
