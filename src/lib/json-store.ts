import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

let writeQueue: Promise<void> = Promise.resolve();

/** Same directory as the auth user store (`AUTH_DATA_DIR` or `.data`). */
export function dataDir(): string {
  return process.env.AUTH_DATA_DIR?.trim() || join(process.cwd(), ".data");
}

export function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function readJsonFile<T>(filename: string, fallback: T): Promise<T> {
  const path = join(dataDir(), filename);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile<T>(filename: string, data: T): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const dest = join(dir, filename);
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, dest);
}
