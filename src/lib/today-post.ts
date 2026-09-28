import { isSameOrigin } from "./public-origin";
import { invalidFormResponse, readFormData } from "./safe-form-data";
import { handleTodayPost, type RunLogFormDraft } from "./training";

export type TodayPostResult =
  | { kind: "response"; response: Response }
  | { kind: "redirect"; location: string }
  | {
      kind: "render";
      logError: string;
      logOpen: boolean;
      logDraft: RunLogFormDraft | null;
      feedbackError: string;
    };

/**
 * Today POST. Origin is checked before the body is read.
 * A same-origin body that is not a form is 400 and does not write feedback.
 */
export async function applyTodayPost(request: Request, userId: string): Promise<TodayPostResult> {
  if (!isSameOrigin(request)) return { kind: "redirect", location: "/today" };

  const formData = await readFormData(request);
  if (!formData) return { kind: "response", response: invalidFormResponse() };

  const result = await handleTodayPost(userId, formData);
  if (result.ok) return { kind: "redirect", location: result.redirect };
  if (result.logOpen) {
    return {
      kind: "render",
      logError: result.error,
      logOpen: true,
      logDraft: result.draft,
      feedbackError: "",
    };
  }
  return {
    kind: "render",
    logError: "",
    logOpen: false,
    logDraft: null,
    feedbackError: result.error,
  };
}
