import type { AgentOutput, AgentToolCall, CheckResult } from "../types.js";

/**
 * Data-fidelity check.
 *
 * The deepest failure mode in chat-widget agents: the agent calls the
 * right tool, the tool returns real data, but the response text invents
 * a different number. Stripe-style "we paid out 12,500 EUR" when the
 * tool actually returned 1,881 EUR.
 *
 * Strategy:
 *  - Extract numeric / date tokens from `output.text`.
 *  - Walk the JSON of every `toolCall.result` and collect numeric / date
 *    tokens it contains.
 *  - Every quantitative token in the text MUST appear somewhere in the
 *    union of tool results, OR be a "small" token we whitelist (years
 *    like 2026, day-of-month references, and token strings like
 *    "1-2 bullets" from the system-prompt boilerplate).
 *
 *  - If the response contains numbers AND no tool was called, that's
 *    instant fail (the agent fabricated data).
 *
 * This is intentionally conservative — it only fires when there's clear
 * mismatch. False negatives are acceptable; false positives would gate
 * good responses.
 */

const NUMBER_RE = /\b\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** Boilerplate tokens that frequently appear in agent prose; whitelist. */
const WHITELIST = new Set<string>([
  "1",
  "2",
  "3",
  "4",
  "5",
  "10",
  "100",
  "1-2",
  "100%",
]);

function collectFromValue(v: unknown, into: Set<string>): void {
  if (v == null) return;
  if (typeof v === "number") {
    into.add(String(v));
    // Also add the formatted-with-commas form.
    if (Math.abs(v) >= 1000) into.add(v.toLocaleString("en-US"));
    return;
  }
  if (typeof v === "string") {
    for (const m of v.matchAll(NUMBER_RE)) into.add(m[0]);
    for (const m of v.matchAll(ISO_DATE_RE)) into.add(m[0]);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectFromValue(x, into);
    return;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) collectFromValue(x, into);
  }
}

function collectFromTools(calls: AgentToolCall[]): Set<string> {
  const out = new Set<string>();
  for (const call of calls) {
    collectFromValue(call.args, out);
    if ("result" in call) collectFromValue(call.result, out);
  }
  return out;
}

export function checkDataFidelity(output: AgentOutput): CheckResult {
  const text = output.text ?? "";
  const numbers: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) numbers.push(m[0]);
  const dates: string[] = [];
  for (const m of text.matchAll(ISO_DATE_RE)) dates.push(m[0]);

  // Dates are part of the numbers regex too; subtract them.
  const dateSet = new Set(dates);
  const onlyNumbers = numbers.filter((n) => !dateSet.has(n));

  if (onlyNumbers.length === 0 && dates.length === 0) {
    return {
      name: "data-fidelity",
      passed: true,
      details: { skipped: "no quantitative tokens in response" },
    };
  }

  if (output.toolCalls.length === 0) {
    return {
      name: "data-fidelity",
      passed: false,
      reason: "response makes quantitative claims but no tool was called",
      details: { numbers: onlyNumbers, dates },
    };
  }

  const allowed = collectFromTools(output.toolCalls);

  const missing: string[] = [];
  for (const n of onlyNumbers) {
    if (WHITELIST.has(n)) continue;
    if (allowed.has(n)) continue;
    // Allow comma-stripped match.
    if (allowed.has(n.replace(/,/g, ""))) continue;
    missing.push(n);
  }
  for (const d of dates) {
    if (allowed.has(d)) continue;
    missing.push(d);
  }

  if (missing.length === 0) {
    return {
      name: "data-fidelity",
      passed: true,
      details: { numbers: onlyNumbers, dates, allowedSize: allowed.size },
    };
  }
  return {
    name: "data-fidelity",
    passed: false,
    reason: `response cites tokens not present in any tool result: ${missing.join(", ")}`,
    details: { missing, allowedSize: allowed.size },
  };
}
