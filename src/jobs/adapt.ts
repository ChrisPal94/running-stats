import { loadLocalEnv } from "../lib/load-env";
import { adaptRunLogLine } from "../lib/adapt-cron";
import { runAdaptCronLoop, runNocturnalAdaptation } from "../lib/adapt";

loadLocalEnv();

const cron = process.argv.includes("--cron");

if (cron) {
  await runAdaptCronLoop();
} else {
  const result = await runNocturnalAdaptation();
  console.log(adaptRunLogLine(result));
}
