#!/usr/bin/env tsx
import { runSuite } from "./runner.js";
import {
  diffBaseline,
  formatScoreReport,
  loadBaseline,
  saveBaseline,
  score,
} from "./score.js";
import { fixtureRunner, liveAgentRunner } from "./runners.js";
import type { AgentRunner } from "./types.js";

interface Args {
  runner: "fixture" | "live";
  fast: boolean;
  updateBaseline: boolean;
  filter?: string;
  maxDropPct: number;
  json: boolean;
  endpoint?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runner: "fixture",
    fast: false,
    updateBaseline: false,
    maxDropPct: 5,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    switch (v) {
      case "--runner":
        a.runner = argv[++i] as Args["runner"];
        break;
      case "--fast":
        a.fast = true;
        break;
      case "--update-baseline":
        a.updateBaseline = true;
        break;
      case "--filter":
        a.filter = argv[++i];
        break;
      case "--max-drop-pct":
        a.maxDropPct = Number(argv[++i]);
        break;
      case "--json":
        a.json = true;
        break;
      case "--endpoint":
        a.endpoint = argv[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run eval:agent -- [options]",
      "",
      "Options:",
      "  --runner <fixture|live>    which runner to use (default fixture; CI default)",
      "  --endpoint <url>           live runner: URL of the deployed /api/agent/chat",
      "  --fast                     reserved (no-op today; matches kimi-eval CLI)",
      "  --update-baseline          write current scores to baseline.json",
      "  --filter <substring>       only run prompt ids containing substring",
      "  --max-drop-pct <n>         fail if pass-rate dropped > n points (default 5)",
      "  --json                     emit machine-readable JSON instead of text",
      "",
      "Examples:",
      "  npm run eval:agent -- --runner fixture",
      "  npm run eval:agent -- --runner live --endpoint https://app.example.com/api/agent/chat",
      "",
    ].join("\n"),
  );
}

function pickRunner(args: Args): AgentRunner {
  switch (args.runner) {
    case "fixture":
      return fixtureRunner();
    case "live": {
      if (!args.endpoint) {
        throw new Error("--runner live requires --endpoint <url>");
      }
      return liveAgentRunner({ endpoint: args.endpoint });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runner = pickRunner(args);
  const filter = args.filter ? (id: string) => id.includes(args.filter!) : undefined;

  const results = await runSuite(runner, { fast: args.fast, filter });
  const suite = score(results);

  if (args.updateBaseline) {
    saveBaseline(suite, args.runner);
    process.stdout.write(`Baseline updated: pass-rate ${(suite.passRate * 100).toFixed(1)}%\n`);
    return;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(suite, null, 2) + "\n");
  } else {
    process.stdout.write(formatScoreReport(suite) + "\n");
  }

  const baseline = loadBaseline();
  if (baseline) {
    const diff = diffBaseline(suite, baseline);
    if (!args.json) {
      const targetStr = baseline.target !== undefined ? ` (target ${(baseline.target * 100).toFixed(1)}%)` : "";
      process.stdout.write(
        `\nBaseline: ${(diff.baselinePassRate * 100).toFixed(1)}%${targetStr} (captured ${baseline.capturedAt}, runner ${baseline.runner})\n` +
          `Drop:     ${diff.dropPct.toFixed(1)} pts\n` +
          `Regressed: ${diff.regressed.join(", ") || "none"}\n` +
          `Improved:  ${diff.improved.join(", ") || "none"}\n`,
      );
    }
    if (diff.dropPct > args.maxDropPct) {
      process.stderr.write(
        `\nFAIL: pass-rate dropped ${diff.dropPct.toFixed(1)} pts (max ${args.maxDropPct})\n`,
      );
      process.exit(1);
    }
    if (baseline.target !== undefined && suite.passRate < baseline.target) {
      process.stderr.write(
        `\nFAIL: pass-rate ${(suite.passRate * 100).toFixed(1)}% is below target ${(baseline.target * 100).toFixed(1)}%\n`,
      );
      process.exit(1);
    }
  } else if (!args.json) {
    process.stdout.write("\nNo baseline found. Run with --update-baseline to capture one.\n");
  }
  if (suite.failed > 0) process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`eval crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(3);
});
