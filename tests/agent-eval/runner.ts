import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCheck, type RunCheckOptions } from "./checks/index.js";
import type {
  AgentRunner,
  AgentOutput,
  CheckResult,
  PromptFile,
  PromptItem,
  PromptResult,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RunSuiteOptions extends RunCheckOptions {
  /** Filter prompt ids (substring or predicate). */
  filter?: (id: string) => boolean;
  /** Path to prompts.json. Defaults to the bundled file next to this module. */
  promptsPath?: string;
  /** Concurrency. Default 4. */
  concurrency?: number;
}

export function defaultPromptsPath(): string {
  return join(__dirname, "prompts.json");
}

export function loadPrompts(path?: string): PromptFile {
  const p = path ?? defaultPromptsPath();
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as PromptFile;
  if (!parsed.prompts || !Array.isArray(parsed.prompts)) {
    throw new Error(`prompts.json malformed: ${p}`);
  }
  return parsed;
}

/**
 * Score one prompt against one runner. Pure: no I/O beyond what the runner
 * itself does and what individual checks do.
 */
export async function evaluatePrompt(
  prompt: PromptItem,
  runner: AgentRunner,
  opts: RunCheckOptions = {},
): Promise<PromptResult> {
  if (prompt.deprecated) {
    const skipped: AgentOutput = { text: "", toolCalls: [], runner: "skipped" };
    return {
      id: prompt.id,
      category: prompt.category,
      runner: "skipped",
      passed: true,
      checks: [],
      output: skipped,
    };
  }
  const output = await runner(prompt);
  const checks: CheckResult[] = [];
  for (const name of prompt.acceptance_checks) {
    checks.push(runCheck(name, prompt, output, opts));
  }
  const passed = checks.every((c) => c.passed);
  return {
    id: prompt.id,
    category: prompt.category,
    runner: output.runner,
    passed,
    checks,
    output,
  };
}

/**
 * Run the full suite. Concurrency-bounded so a real-API runner doesn't
 * stampede the upstream chat handler.
 */
export async function runSuite(
  runner: AgentRunner,
  opts: RunSuiteOptions = {},
): Promise<PromptResult[]> {
  const file = loadPrompts(opts.promptsPath);
  const filtered = opts.filter ? file.prompts.filter((p) => opts.filter!(p.id)) : file.prompts;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const results: PromptResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= filtered.length) return;
      const item = filtered[i];
      if (!item) return;
      const r = await evaluatePrompt(item, runner, opts);
      results[i] = r;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
