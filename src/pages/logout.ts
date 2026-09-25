import type { APIRoute } from "astro";
import { logoutSession } from "../lib/auth";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  await logoutSession(cookies);
  return redirect("/login");
};

export const GET: APIRoute = ({ redirect }) => {
  return redirect("/login");
};
