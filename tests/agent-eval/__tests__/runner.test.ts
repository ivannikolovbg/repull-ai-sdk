/**
 * Self-tests for the runner + score modules.
 *
 * These tests prove the harness behaves correctly on synthetic inputs;
 * they are independent of any LLM and never call the network. Every
 * assertion exercises a behaviour a real CI run would depend on.
 */
import { describe, expect, it } from "vitest";
import { evaluatePrompt, loadPrompts, runSuite } from "../runner.js";
import { fixtureRunner } from "../runners.js";
import { diffBaseline, score } from "../score.js";
import type { AgentRunner, Baseline, PromptItem } from "../types.js";

describe("loadPrompts", () => {
  it("loads the bundled prompts.json with at least 30 prompts", () => {
    const file = loadPrompts();
    expect(file.version).toBeGreaterThanOrEqual(1);
    expect(file.prompts.length).toBeGreaterThanOrEqual(30);
    expect(file.prompts.length).toBeLessThanOrEqual(50);
  });

  it("every prompt has an id, category, expected tools, and ≥1 check", () => {
    const file = loadPrompts();
    for (const p of file.prompts) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.acceptance_checks.length).toBeGreaterThan(0);
      expect(Array.isArray(p.expected_tools)).toBe(true);
      expect([
        "revenue",
        "occupancy",
        "reservations",
        "pricing",
        "guests",
        "cleaning",
        "market",
      ]).toContain(p.category);
    }
  });

  it("prompt ids are unique across the suite", () => {
    const file = loadPrompts();
    const ids = new Set<string>();
    for (const p of file.prompts) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
  });

  it("includes at least one Spanish-language prompt for language-match coverage", () => {
    const file = loadPrompts();
    const spanish = file.prompts.filter((p) => p.language === "es");
    expect(spanish.length).toBeGreaterThanOrEqual(1);
  });

  it("every expected_tools entry references a known tool name", () => {
    const file = loadPrompts();
    const known = new Set([
      "getReservations",
      "getCurrentPricing",
      "getMarketContext",
      "getRevenue",
      "getOccupancyRate",
      "searchGuests",
      "getCleaningRota",
    ]);
    for (const p of file.prompts) {
      for (const entry of p.expected_tools) {
        const names = Array.isArray(entry) ? entry : [entry];
        for (const n of names) expect(known.has(n)).toBe(true);
      }
    }
  });
});

describe("evaluatePrompt", () => {
  const runner = fixtureRunner();

  it("produces a passing result on the fixture runner for a well-formed prompt", async () => {
    const prompt: PromptItem = {
      id: "smoke-rev",
      prompt: "How much revenue this month?",
      expected_intent: "Call getRevenue.",
      expected_tools: ["getRevenue"],
      category: "revenue",
      acceptance_checks: [
        "tool-selection",
        "no-hallucinated-tools",
        "helpful-response",
        "language-match",
        "data-fidelity",
      ],
    };
    const r = await evaluatePrompt(prompt, runner);
    expect(r.passed).toBe(true);
    expect(r.checks.find((c) => c.name === "tool-selection")?.passed).toBe(true);
    expect(r.output.toolCalls.map((c) => c.name)).toContain("getRevenue");
  });

  it("fails when the runner skips the required tool", async () => {
    const broken: AgentRunner = () => ({
      text: "I think it's around 12,500 EUR.",
      toolCalls: [],
      runner: "broken",
    });
    const prompt: PromptItem = {
      id: "fail-tool-selection",
      prompt: "x",
      expected_intent: "x",
      expected_tools: ["getRevenue"],
      category: "revenue",
      acceptance_checks: ["tool-selection", "data-fidelity"],
    };
    const r = await evaluatePrompt(prompt, broken);
    expect(r.passed).toBe(false);
    expect(r.checks.some((c) => c.name === "tool-selection" && !c.passed)).toBe(true);
  });

  it("treats deprecated prompts as auto-pass and skips checks", async () => {
    const prompt: PromptItem = {
      id: "old-prompt",
      prompt: "irrelevant",
      expected_intent: "n/a",
      expected_tools: ["getRevenue"],
      category: "revenue",
      acceptance_checks: ["tool-selection"],
      deprecated: true,
    };
    const r = await evaluatePrompt(prompt, runner);
    expect(r.passed).toBe(true);
    expect(r.checks.length).toBe(0);
    expect(r.runner).toBe("skipped");
  });
});

describe("runSuite + score + baseline", () => {
  it("runs the full suite against the fixture runner with 100% pass-rate", async () => {
    const results = await runSuite(fixtureRunner());
    const s = score(results);
    expect(s.total).toBeGreaterThanOrEqual(30);
    expect(s.passRate).toBe(1);
    expect(s.perCategory.revenue.total).toBeGreaterThan(0);
    expect(s.perCategory.cleaning.total).toBeGreaterThan(0);
    expect(s.perCheck["tool-selection"].total).toBeGreaterThan(0);
    expect(s.perCheck["data-fidelity"].total).toBeGreaterThan(0);
  }, 30_000);

  it("runSuite respects the filter predicate", async () => {
    const results = await runSuite(fixtureRunner(), {
      filter: (id) => id.startsWith("rev-"),
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id.startsWith("rev-")).toBe(true);
    }
  });

  it("score() handles an empty result list without dividing by zero", () => {
    const s = score([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(1);
    expect(s.perCategory.revenue.passRate).toBe(1);
  });

  it("loads the bundled baseline.json and asserts ≥ 90% target", async () => {
    const { loadBaseline } = await import("../score.js");
    const baseline = loadBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline?.target).toBeDefined();
    expect(baseline!.target!).toBeGreaterThanOrEqual(0.9);
  });

  it("baseline diff flags regressions and improvements", () => {
    const baseline: Baseline = {
      capturedAt: new Date().toISOString(),
      runner: "fixture",
      passRate: 1,
      perCategory: {
        revenue: 1,
        occupancy: 1,
        reservations: 1,
        pricing: 1,
        guests: 1,
        cleaning: 1,
        market: 1,
      },
      perPrompt: { a: true, b: false },
    };
    const suite = score([
      {
        id: "a",
        category: "revenue",
        runner: "fixture",
        passed: false,
        checks: [],
        output: { text: "", toolCalls: [], runner: "fixture" },
      },
      {
        id: "b",
        category: "revenue",
        runner: "fixture",
        passed: true,
        checks: [],
        output: { text: "", toolCalls: [], runner: "fixture" },
      },
    ]);
    const diff = diffBaseline(suite, baseline);
    expect(diff.regressed).toEqual(["a"]);
    expect(diff.improved).toEqual(["b"]);
    expect(diff.dropPct).toBeCloseTo(50, 1);
  });
});
