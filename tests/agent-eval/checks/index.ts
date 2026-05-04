import type { AgentOutput, CheckName, CheckResult, PromptItem } from "../types.js";
import { checkToolSelection } from "./tool-selection.js";
import { checkNoHallucinatedTools } from "./no-hallucinated-tools.js";
import { checkHelpfulResponse } from "./helpful-response.js";
import { checkLanguageMatch } from "./language-match.js";
import { checkDataFidelity } from "./data-fidelity.js";

export interface RunCheckOptions {
  /**
   * Reserved for parity with kimi-eval. The agent harness has no shell-out
   * checks today (no `compiles` / `installs`), so `--fast` is currently a
   * no-op. We accept it so the CLI signature mirrors the kimi-eval CLI.
   */
  fast?: boolean;
}

export function runCheck(
  name: CheckName,
  prompt: PromptItem,
  output: AgentOutput,
  _opts: RunCheckOptions = {},
): CheckResult {
  switch (name) {
    case "tool-selection":
      return checkToolSelection(prompt, output);
    case "no-hallucinated-tools":
      return checkNoHallucinatedTools(output);
    case "helpful-response":
      return checkHelpfulResponse(output);
    case "language-match":
      return checkLanguageMatch(prompt, output);
    case "data-fidelity":
      return checkDataFidelity(output);
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      return { name, passed: false, reason: `unknown check: ${name as string}` };
    }
  }
}

export {
  checkToolSelection,
  checkNoHallucinatedTools,
  checkHelpfulResponse,
  checkLanguageMatch,
  checkDataFidelity,
};
