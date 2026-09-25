import { loadLocalEnv } from "../lib/load-env";
import { reassignOwnerEmail } from "../lib/reassign-owner-email";

loadLocalEnv();

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

const from = flagValue("--from");
const to = flagValue("--to");
const apply = process.argv.includes("--apply");

if (!from || !to) {
  console.error("[reassign-owner-email] aborted: --from and --to are required");
  console.log("[reassign-owner-email] nothing changed");
  process.exitCode = 1;
} else {
  const result = reassignOwnerEmail({ from, to, apply });
  if (result.aborted) process.exitCode = 1;
}
