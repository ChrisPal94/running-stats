import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/auth";
import { clearIntervalsOAuthState, startIntervalsOAuth } from "../../../lib/intervals-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const user = await getCurrentUser(cookies);
  if (!user) {
    clearIntervalsOAuthState(cookies);
    return redirect("/login");
  }
  try {
    const { location } = startIntervalsOAuth(request, cookies, user.id);
    return redirect(location);
  } catch {
    console.error("[intervals] oauth start failed");
    return redirect("/settings?toast=intervals-error");
  }
};
