const URLENCODED = "application/x-www-form-urlencoded";
const MULTIPART = "multipart/form-data";

/** MIME type without parameters. Missing and empty values are not forms. */
export function formMimeType(contentType: string | null | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isFormContentType(contentType: string | null | undefined): boolean {
  const mime = formMimeType(contentType);
  return mime === URLENCODED || mime === MULTIPART;
}

/** Plain 400. No stack trace and no echo of the request body. */
export function invalidFormResponse(): Response {
  return new Response("Expected a form submission.", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Parse a POST body that is `application/x-www-form-urlencoded` or `multipart/form-data`.
 * Returns null when the content type is missing or not a form, or when the body cannot be parsed.
 */
export async function readFormData(request: Request): Promise<FormData | null> {
  if (!isFormContentType(request.headers.get("content-type"))) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
