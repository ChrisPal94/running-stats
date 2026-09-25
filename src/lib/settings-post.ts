import { denyIntervalsPostCsrf } from "./intervals";
import { isSameOrigin } from "./public-origin";
import { invalidFormResponse, readFormData } from "./safe-form-data";
import {
  handleSettingsPost,
  normalizeFeedbackCadence,
  type FeedbackCadence,
  type IntervalsRunPickerState,
} from "./training";

export type SettingsPostResult =
  | { kind: "response"; response: Response }
  | { kind: "redirect"; location: string }
  | {
      kind: "render";
      cadenceError: string;
      intervalsError: string;
      athleteIdDraft: string;
      runPicker: IntervalsRunPickerState | null;
      selectedCadence: FeedbackCadence;
    };

/**
 * Settings POST. A non-form body is 400 before any write.
 * Intervals CSRF still runs before the generic origin check, and both still
 * run only after a form body has been read (intent decides which check applies).
 */
export async function applySettingsPost(
  request: Request,
  userId: string,
  planCadence: FeedbackCadence,
): Promise<SettingsPostResult> {
  const formData = await readFormData(request);
  if (!formData) return { kind: "response", response: invalidFormResponse() };

  const intent = String(formData.get("intent") ?? "").trim();
  let selectedCadence = planCadence;
  if (intent === "save-cadence") {
    selectedCadence = normalizeFeedbackCadence(String(formData.get("feedbackCadence") ?? ""));
  }

  const csrfDenied = denyIntervalsPostCsrf(request, intent);
  if (csrfDenied) return { kind: "response", response: csrfDenied };

  if (!isSameOrigin(request)) {
    return {
      kind: "render",
      cadenceError: "This request could not be verified. Try again.",
      intervalsError: "",
      athleteIdDraft: "",
      runPicker: null,
      selectedCadence,
    };
  }

  const athleteIdDraft =
    intent === "intervals-connect"
      ? String(formData.get("intervalsAthleteId") ?? "").trim().slice(0, 16)
      : "";
  const result = await handleSettingsPost(userId, formData);
  if (result.ok) {
    if ("picker" in result) {
      return {
        kind: "render",
        cadenceError: "",
        intervalsError: "",
        athleteIdDraft,
        runPicker: result.picker,
        selectedCadence,
      };
    }
    return { kind: "redirect", location: result.redirect };
  }
  if (result.status === 403) {
    return {
      kind: "response",
      response: new Response(result.error, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    };
  }
  if (result.section === "intervals") {
    return {
      kind: "render",
      cadenceError: "",
      intervalsError: result.error,
      athleteIdDraft,
      runPicker: null,
      selectedCadence,
    };
  }
  return {
    kind: "render",
    cadenceError: result.error,
    intervalsError: "",
    athleteIdDraft,
    runPicker: null,
    selectedCadence,
  };
}
