import type { AgentOutput, CheckResult, LanguageTag, PromptItem } from "../types.js";

/**
 * Language-match check.
 *
 * The vanio-agent eval suite (vanio repo, tier 2) discovered that prompt
 * tweaks regularly cause the agent to answer in the wrong language — a
 * Spanish-speaking property manager asks "¿cuántas reservas tengo hoy?"
 * and gets an English reply. We catch that here.
 *
 * Lightweight detection: count distinctive tokens for each supported
 * language. The check passes if the response language matches the prompt
 * language tag (default "en"). Tokens are picked to be common in chat
 * responses, not in code — avoiding false positives on dates, IDs, etc.
 */

const SPANISH_TOKENS = [
  "reserva",
  "reservas",
  "huésped",
  "huespedes",
  "ocupación",
  "tienes",
  "hoy",
  "limpieza",
  "alojamiento",
  "noche",
  "noches",
  "el ",
  "la ",
  "los ",
  "las ",
  "para ",
  " es ",
  " del ",
];

const ENGLISH_TOKENS = [
  "the ",
  " is ",
  " has ",
  " have ",
  " are ",
  "today",
  "tonight",
  "guest",
  "guests",
  "reservation",
  "reservations",
  "occupancy",
  "tomorrow",
  " and ",
];

function scoreTokens(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of tokens) {
    if (lower.includes(t)) n++;
  }
  return n;
}

function detectLanguage(text: string): LanguageTag | "unknown" {
  const en = scoreTokens(text, ENGLISH_TOKENS);
  const es = scoreTokens(text, SPANISH_TOKENS);
  if (en === 0 && es === 0) return "unknown";
  return en >= es ? "en" : "es";
}

export function checkLanguageMatch(prompt: PromptItem, output: AgentOutput): CheckResult {
  const expected: LanguageTag = prompt.language ?? "en";
  const actual = detectLanguage(output.text ?? "");
  if (actual === "unknown") {
    return {
      name: "language-match",
      passed: true,
      details: { skipped: "no language tokens detected", expected },
    };
  }
  if (actual !== expected) {
    return {
      name: "language-match",
      passed: false,
      reason: `expected response in ${expected}, got ${actual}`,
      details: { expected, actual },
    };
  }
  return { name: "language-match", passed: true, details: { expected, actual } };
}
