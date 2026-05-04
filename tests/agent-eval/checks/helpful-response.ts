import type { AgentOutput, CheckResult } from "../types.js";

/**
 * helpful-response check.
 *
 * The embedded chat widget exists to answer property-manager questions.
 * A response is helpful when it:
 *   - is long enough to plausibly carry an answer (>50 chars by default),
 *   - is short enough to fit in the chat window (<4 KB by default —
 *     anything longer is runaway generation or a leaked system prompt),
 *   - is NOT a generic refusal ("I can't help with that"),
 *   - contains no placeholder tokens ("FAKE", "TODO", "Lorem ipsum"),
 *   - contains no raw runtime artefacts ("[object Object]").
 *
 * The deny phrases are intentionally narrow — we want to flag *surrender*
 * answers, not legitimate "I tried but the API returned an error" ones.
 * Real error surfacing ("the pricing endpoint returned 502") is helpful;
 * "I can't help with that" with no detail is not.
 */
const DEFAULT_MIN_CHARS = 50;
const DEFAULT_MAX_CHARS = 4_000;

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi (?:can(?:no|')t|am unable to) (?:help|assist|answer)\b/i,
  /\bi (?:do not|don'?t) have (?:access to|the (?:ability|tools))\b/i,
  /\bi'?m (?:sorry|afraid)[, ]+(?:but )?i (?:can(?:no|')t|am unable)/i,
  /\bsorry,? (?:i can(?:no|')t|that(?:'s| is) (?:beyond|outside))/i,
  /\bunable to (?:help|assist|answer|provide)/i,
];

const PLACEHOLDER_RE = /(FAKE|LOREM|TODO|XXXX|placeholder|lorem ipsum)/i;
const RAW_DUMP_RE = /\[object Object\]|undefined undefined|null null/;

export interface HelpfulResponseOptions {
  minChars?: number;
  maxChars?: number;
}

export function checkHelpfulResponse(
  output: AgentOutput,
  opts: HelpfulResponseOptions = {},
): CheckResult {
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const text = (output.text ?? "").trim();
  const len = text.length;

  if (len < minChars) {
    return {
      name: "helpful-response",
      passed: false,
      reason: `response too short: ${len} chars (min ${minChars})`,
      details: { length: len, minChars, maxChars },
    };
  }
  if (len > maxChars) {
    return {
      name: "helpful-response",
      passed: false,
      reason: `response too long: ${len} chars (max ${maxChars})`,
      details: { length: len, minChars, maxChars },
    };
  }
  const placeholder = text.match(PLACEHOLDER_RE);
  if (placeholder) {
    return {
      name: "helpful-response",
      passed: false,
      reason: `response contains placeholder token: "${placeholder[0]}"`,
      details: { token: placeholder[0] },
    };
  }
  const rawDump = text.match(RAW_DUMP_RE);
  if (rawDump) {
    return {
      name: "helpful-response",
      passed: false,
      reason: `response contains raw dump artefact: "${rawDump[0]}"`,
      details: { token: rawDump[0] },
    };
  }
  for (const re of REFUSAL_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return {
        name: "helpful-response",
        passed: false,
        reason: `response is a generic refusal: "${m[0]}"`,
        details: { matchedPattern: re.source, snippet: m[0] },
      };
    }
  }
  return { name: "helpful-response", passed: true, details: { length: len } };
}
