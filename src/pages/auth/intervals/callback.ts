import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/auth";
import { INTERVALS_CONNECT_UNAVAILABLE, INTERVALS_OAUTH_CALENDAR_SCOPE } from "../../../lib/intervals";
import { clearIntervalsOAuthState, finishIntervalsOAuth } from "../../../lib/intervals-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const user = await getCurrentUser(cookies);
  if (!user) {
    clearIntervalsOAuthState(cookies);
    return redirect("/login");
  }
  try {
    const result = await finishIntervalsOAuth(request, cookies, user.id);
    if (result.kind === "connected") return redirect("/settings?toast=intervals-connected");
    if (result.kind === "cancelled") return redirect("/settings");
    const toast =
      result.kind === "error" && result.message === INTERVALS_OAUTH_CALENDAR_SCOPE
        ? "intervals-calendar"
        : result.kind === "error" && result.message === INTERVALS_CONNECT_UNAVAILABLE
          ? "intervals-unavailable"
          : "intervals-error";
    return redirect(`/settings?toast=${toast}`);
  } catch {
    console.error("[intervals] oauth callback failed");
    clearIntervalsOAuthState(cookies);
    return redirect("/settings?toast=intervals-error");
  }
};
