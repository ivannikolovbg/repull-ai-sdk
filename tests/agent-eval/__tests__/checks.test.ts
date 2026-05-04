/**
 * Self-tests for the 5 acceptance checks. Each check has at least one
 * positive case (passes when expected) and one negative case (fails when
 * expected) so a regression in the check logic is caught at PR time.
 */
import { describe, expect, it } from "vitest";
import { checkToolSelection } from "../checks/tool-selection.js";
import { checkNoHallucinatedTools } from "../checks/no-hallucinated-tools.js";
import { checkHelpfulResponse } from "../checks/helpful-response.js";
import { checkLanguageMatch } from "../checks/language-match.js";
import { checkDataFidelity } from "../checks/data-fidelity.js";
import type { AgentOutput, PromptItem } from "../types.js";

const out = (text: string, toolCalls: AgentOutput["toolCalls"] = []): AgentOutput => ({
  text,
  toolCalls,
  runner: "fixture",
});

const basePrompt: PromptItem = {
  id: "test",
  prompt: "p",
  expected_intent: "x",
  expected_tools: ["getRevenue"],
  category: "revenue",
  acceptance_checks: ["tool-selection"],
};

describe("tool-selection", () => {
  it("passes when the required tool was called", () => {
    const r = checkToolSelection(basePrompt, out("ok", [{ name: "getRevenue", args: {} }]));
    expect(r.passed).toBe(true);
  });

  it("fails when the required tool is missing", () => {
    const r = checkToolSelection(basePrompt, out("ok", []));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/getRevenue/);
  });

  it("OR-group passes when any one alternative is called", () => {
    const orPrompt: PromptItem = {
      ...basePrompt,
      expected_tools: [["getOccupancyRate", "getReservations"]],
    };
    const r = checkToolSelection(orPrompt, out("ok", [{ name: "getReservations", args: {} }]));
    expect(r.passed).toBe(true);
  });

  it("OR-group fails when no alternative is called", () => {
    const orPrompt: PromptItem = {
      ...basePrompt,
      expected_tools: [["getOccupancyRate", "getReservations"]],
    };
    const r = checkToolSelection(orPrompt, out("ok", [{ name: "getRevenue", args: {} }]));
    expect(r.passed).toBe(false);
  });

  it("AND requirement fails when one of multiple tools is missing", () => {
    const multi: PromptItem = {
      ...basePrompt,
      expected_tools: ["getRevenue", "getOccupancyRate"],
    };
    const r = checkToolSelection(multi, out("ok", [{ name: "getRevenue", args: {} }]));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/getOccupancyRate/);
  });
});

describe("no-hallucinated-tools", () => {
  it("passes when every called tool is in the 7-tool surface", () => {
    const r = checkNoHallucinatedTools(
      out("ok", [
        { name: "getRevenue", args: {} },
        { name: "getOccupancyRate", args: {} },
      ]),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when the agent calls an invented tool", () => {
    const r = checkNoHallucinatedTools(
      out("ok", [{ name: "magicallyPredictRevenue", args: {} }]),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/magicallyPredictRevenue/);
  });

  it("passes when no tool was called (empty list, no hallucinations)", () => {
    const r = checkNoHallucinatedTools(out("ok", []));
    expect(r.passed).toBe(true);
  });
});

describe("helpful-response", () => {
  it("flags too-short output", () => {
    const r = checkHelpfulResponse(out("hi"));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too short/);
  });

  it("flags too-long output", () => {
    const r = checkHelpfulResponse(out("x".repeat(5_000)));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too long/);
  });

  it("passes a reasonable PM-style answer", () => {
    const r = checkHelpfulResponse(
      out("Booked revenue this month is 1,881 EUR across 3 confirmed reservations. Source: getRevenue."),
    );
    expect(r.passed).toBe(true);
  });

  it("flags a generic 'I can't help' refusal", () => {
    const r = checkHelpfulResponse(
      out("I'm sorry, but I can't help with that question right now. Please contact support."),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/refusal/);
  });

  it("flags placeholder tokens like FAKE/Lorem", () => {
    const r = checkHelpfulResponse(
      out("Here is the revenue summary: Lorem ipsum dolor sit amet for the requested window."),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/placeholder/);
  });

  it("flags raw runtime artefacts like [object Object]", () => {
    const r = checkHelpfulResponse(
      out("Revenue this month: [object Object] across the workspace, fetched from getRevenue."),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/raw dump/);
  });
});

describe("language-match", () => {
  it("passes when an English prompt gets an English response", () => {
    const prompt: PromptItem = { ...basePrompt, language: "en" };
    const r = checkLanguageMatch(
      prompt,
      out("The revenue this month is 1881 EUR and the occupancy is solid."),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when a Spanish prompt gets an English response", () => {
    const prompt: PromptItem = { ...basePrompt, language: "es" };
    const r = checkLanguageMatch(
      prompt,
      out("The revenue this month is 1881 EUR and the occupancy is solid."),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/es/);
  });

  it("passes when a Spanish prompt gets a Spanish response", () => {
    const prompt: PromptItem = { ...basePrompt, language: "es" };
    const r = checkLanguageMatch(
      prompt,
      out("Tienes 3 reservas confirmadas hoy. La ocupación es del 67%."),
    );
    expect(r.passed).toBe(true);
  });

  it("skips gracefully when no language tokens are detectable", () => {
    const prompt: PromptItem = { ...basePrompt, language: "en" };
    const r = checkLanguageMatch(prompt, out("9001 4118 EUR"));
    expect(r.passed).toBe(true);
  });
});

describe("data-fidelity", () => {
  it("passes when every numeric token in the response is present in some tool result", () => {
    const r = checkDataFidelity(
      out("Booked revenue: 1881 EUR across 3 confirmed reservations.", [
        {
          name: "getRevenue",
          args: { from: "2026-05-01", to: "2026-05-04" },
          result: { total: 1881, currency: "EUR", count: 3 },
        },
      ]),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when the response invents a number not present in any tool result", () => {
    const r = checkDataFidelity(
      out("Booked revenue: 12,500 EUR across the month.", [
        {
          name: "getRevenue",
          args: { from: "2026-05-01", to: "2026-05-04" },
          result: { total: 1881, currency: "EUR" },
        },
      ]),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/12,500/);
  });

  it("fails when the response cites numbers but no tool was called", () => {
    const r = checkDataFidelity(
      out("Booked revenue this month: 12,500 EUR (+23% MoM).", []),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/no tool was called/);
  });

  it("passes a number-free narrative response with no tool calls", () => {
    const r = checkDataFidelity(out("No reservations matched your filter."));
    expect(r.passed).toBe(true);
  });

  it("matches comma-formatted numbers against raw integers in tool results", () => {
    const r = checkDataFidelity(
      out("Booked revenue: 1,881 EUR.", [
        {
          name: "getRevenue",
          args: { from: "2026-05-01", to: "2026-05-04" },
          result: { total: 1881, currency: "EUR" },
        },
      ]),
    );
    expect(r.passed).toBe(true);
  });
});
