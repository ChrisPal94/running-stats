import { loadLocalEnv } from "../lib/load-env";
import { runNocturnalAdaptation } from "../lib/adapt";

loadLocalEnv();

const result = await runNocturnalAdaptation();
console.log(
  `[adapt] wrote ${result.written} AdaptationEvent(s), patched ${result.patched} session(s) (${result.processed} plan(s) considered, ${result.skipped} skipped)`,
);
