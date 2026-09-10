import { loadLocalEnv } from "../lib/load-env";
import { runAdaptCronLoop, runNocturnalAdaptation } from "../lib/adapt";

loadLocalEnv();

const cron = process.argv.includes("--cron");

if (cron) {
  await runAdaptCronLoop();
} else {
  const result = await runNocturnalAdaptation();
  console.log(
    `[adapt] wrote ${result.written} AdaptationEvent(s), patched ${result.patched} session(s) (${result.processed} plan(s) considered, ${result.skipped} skipped, ${result.llmFailed} LLM failed)`,
  );
}
