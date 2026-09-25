import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** User-facing when a personal key cannot be stored. No secret material. */
export const INTERVALS_ENC_NOT_CONFIGURED = "Intervals encryption is not configured.";

export class IntervalsEncryptionError extends Error {
  constructor() {
    super(INTERVALS_ENC_NOT_CONFIGURED);
    this.name = "IntervalsEncryptionError";
  }
}

/** Ciphertext could not be opened with the configured key. Message has no key material. */
export class IntervalsDecryptError extends Error {
  constructor() {
    super("Intervals secret could not be read.");
    this.name = "IntervalsDecryptError";
  }
}

/**
 * Standard base64 for exactly 32 bytes (`openssl rand -base64 32`): 43 alphabet
 * characters and one `=` pad. Hex and unpadded base64 are not accepted.
 */
const ENC_SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

let loggedInvalidEncSecret = false;

function rejectEncSecret(raw: string): never {
  if (raw && !loggedInvalidEncSecret) {
    loggedInvalidEncSecret = true;
    console.error("[intervals] encryption secret is not configured");
  }
  throw new IntervalsEncryptionError();
}

/** False when `INTERVALS_KEY_ENC_SECRET` is missing or not 32-byte base64. Never throws. */
export function intervalsEncryptionReady(): boolean {
  try {
    intervalsEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * 32-byte key from `INTERVALS_KEY_ENC_SECRET`.
 * Generate with `openssl rand -base64 32`. Anything else is treated as missing.
 */
export function intervalsEncryptionKey(): Buffer {
  const raw = process.env.INTERVALS_KEY_ENC_SECRET?.trim() ?? "";
  if (!raw || !ENC_SECRET_PATTERN.test(raw)) rejectEncSecret(raw);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) rejectEncSecret(raw);
  return key;
}

/** AES-256-GCM payload `v1:iv:tag:ciphertext` (base64). Ciphertext does not contain the plaintext. */
export function encryptIntervalsApiKey(plaintext: string): string {
  const key = intervalsEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptIntervalsApiKey(payload: string): string {
  const key = intervalsEncryptionKey();
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new IntervalsDecryptError();
  const iv = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  const data = Buffer.from(parts[3] ?? "", "base64");
  if (iv.length !== 12 || tag.length !== 16 || data.length === 0) throw new IntervalsDecryptError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new IntervalsDecryptError();
  }
}
