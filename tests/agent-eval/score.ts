import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Baseline,
  CheckName,
  PromptCategory,
  PromptResult,
  SuiteScore,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALL_CHECKS: CheckName[] = [
  "tool-selection",
  "no-hallucinated-tools",
  "helpful-response",
  "language-match",
  "data-fidelity",
];
const ALL_CATEGORIES: PromptCategory[] = [
  "revenue",
  "occupancy",
  "reservations",
  "pricing",
  "guests",
  "cleaning",
  "market",
];

export function score(results: PromptResult[]): SuiteScore {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  const perCheck = Object.fromEntries(
    ALL_CHECKS.map((name) => {
      const relevant = results.flatMap((r) => r.checks.filter((c) => c.name === name));
      const tp = relevant.filter((c) => c.passed).length;
      return [
        name,
        {
          total: relevant.length,
          passed: tp,
          passRate: relevant.length === 0 ? 1 : tp / relevant.length,
        },
      ];
    }),
  ) as SuiteScore["perCheck"];

  const perCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => {
      const relevant = results.filter((r) => r.category === category);
      const tp = relevant.filter((r) => r.passed).length;
      return [
        category,
        {
          total: relevant.length,
          passed: tp,
          passRate: relevant.length === 0 ? 1 : tp / relevant.length,
        },
      ];
    }),
  ) as SuiteScore["perCategory"];

  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 1 : passed / total,
    perCheck,
    perCategory,
    results,
  };
}

export function defaultBaselinePath(): string {
  return join(__dirname, "baseline.json");
}

export function loadBaseline(path?: string): Baseline | null {
  const p = path ?? defaultBaselinePath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Baseline;
}

/** Default target pass-rate the suite must clear in CI. */
export const DEFAULT_TARGET_PASS_RATE = 0.9;

export function saveBaseline(
  suite: SuiteScore,
  runner: string,
  path?: string,
  target: number = DEFAULT_TARGET_PASS_RATE,
): void {
  const p = path ?? defaultBaselinePath();
  // If a baseline already exists, preserve its target so re-capturing
  // doesn't accidentally widen the gate without an explicit caller intent.
  const existing = loadBaseline(p);
  const finalTarget = existing?.target ?? target;
  const baseline: Baseline = {
    capturedAt: new Date().toISOString(),
    runner,
    target: finalTarget,
    passRate: suite.passRate,
    perCategory: Object.fromEntries(
      Object.entries(suite.perCategory).map(([k, v]) => [k, v.passRate]),
    ) as Baseline["perCategory"],
    perPrompt: Object.fromEntries(suite.results.map((r) => [r.id, r.passed])),
  };
  writeFileSync(p, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

/**
 * Compare a suite score against the saved baseline.
 *
 *  - regressed: prompts that were green at baseline and red now
 *  - improved:  prompts that were red at baseline and green now
 *  - dropPct:   absolute drop in overall pass-rate vs baseline (positive = regression)
 *
 * The CI gate is: dropPct <= 5 (5 percentage points). Configurable via
 * `--max-drop-pct`.
 */
export function diffBaseline(
  suite: SuiteScore,
  baseline: Baseline,
): {
  regressed: string[];
  improved: string[];
  dropPct: number;
  baselinePassRate: number;
  currentPassRate: number;
} {
  const regressed: string[] = [];
  const improved: string[] = [];
  const prev = baseline.perPrompt ?? {};
  for (const r of suite.results) {
    const wasPass = prev[r.id];
    if (wasPass === undefined) continue;
    if (wasPass && !r.passed) regressed.push(r.id);
    if (!wasPass && r.passed) improved.push(r.id);
  }
  const dropPct = (baseline.passRate - suite.passRate) * 100;
  return {
    regressed,
    improved,
    dropPct,
    baselinePassRate: baseline.passRate,
    currentPassRate: suite.passRate,
  };
}

export function formatScoreReport(suite: SuiteScore): string {
  const lines: string[] = [];
  lines.push(
    `RepullAgent Eval Suite — ${suite.passed}/${suite.total} passed (${(suite.passRate * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("By category:");
  for (const [cat, s] of Object.entries(suite.perCategory)) {
    if (s.total === 0) continue;
    lines.push(`  ${cat.padEnd(14)} ${s.passed}/${s.total} (${(s.passRate * 100).toFixed(1)}%)`);
  }
  lines.push("");
  lines.push("By check:");
  for (const [name, s] of Object.entries(suite.perCheck)) {
    if (s.total === 0) continue;
    lines.push(`  ${name.padEnd(18)} ${s.passed}/${s.total} (${(s.passRate * 100).toFixed(1)}%)`);
  }
  lines.push("");
  const fails = suite.results.filter((r) => !r.passed);
  if (fails.length) {
    lines.push("Failures:");
    for (const r of fails) {
      const reasons = r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.reason}`);
      lines.push(`  ${r.id} (${r.category}) — ${reasons.join("; ")}`);
    }
  }
  return lines.join("\n");
}
