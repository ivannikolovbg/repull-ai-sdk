/**
 * Embedded `<RepullAgent />` evaluation harness — shared types.
 *
 * This harness is the agent counterpart to repull-studio's `kimi-eval`.
 * Where kimi-eval scores text/code generation (does the model emit a
 * working React component / SQL query), this harness scores agent
 * BEHAVIOUR — does the agent call the right tool, never hallucinate
 * tools that don't exist, return a non-trivial helpful answer, match
 * the user's language, and reference real numbers from the mock API
 * results (not invent them).
 *
 * Provider-agnostic: an "agent runner" is any function from prompt →
 * output. In CI we use a deterministic fixture runner driven by a mock
 * Repull API. NEVER calls live Anthropic, Moonshot, or Repull endpoints
 * — the harness is meant to be cheap and reproducible.
 */

/**
 * The 7-tool surface exposed by `createAgentHandler` in
 * `@repull/ai-sdk/agent`. Keep in sync with `src/agent/tools.ts` — the
 * prompts.json schema validates `expected_tools` against this set so a
 * typo in the prompt file fails CI.
 */
export type AgentToolName =
  | "getReservations"
  | "getCurrentPricing"
  | "getMarketContext"
  | "getRevenue"
  | "getOccupancyRate"
  | "searchGuests"
  | "getCleaningRota";

export const ALL_AGENT_TOOLS: AgentToolName[] = [
  "getReservations",
  "getCurrentPricing",
  "getMarketContext",
  "getRevenue",
  "getOccupancyRate",
  "searchGuests",
  "getCleaningRota",
];

/**
 * The 5 acceptance checks supported by the harness. The names mirror the
 * eval spec verbatim so an outside reader can match the spec doc to the
 * code without translation.
 */
export type CheckName =
  | "tool-selection"
  | "no-hallucinated-tools"
  | "helpful-response"
  | "language-match"
  | "data-fidelity";

/**
 * Tool-name requirement entry. Bare string = exact match required.
 * Nested array = OR-group (any one alternative satisfies). Use OR-groups
 * for legitimate ambiguity (e.g. "what's tonight's occupancy" can be
 * answered via `getOccupancyRate` OR `getReservations`).
 */
export type ToolRequirement = AgentToolName | AgentToolName[];

/** Categorisation so the score report can break down by area. */
export type PromptCategory =
  | "revenue"
  | "occupancy"
  | "reservations"
  | "pricing"
  | "guests"
  | "cleaning"
  | "market";

/**
 * IETF-style language tag for prompt+response. Defaults to "en". Spanish
 * prompts use "es" so the language-match check can verify the response
 * was returned in the same language.
 */
export type LanguageTag = "en" | "es";

export interface PromptItem {
  id: string;
  prompt: string;
  /** Plain-language explanation of what a correct answer looks like. */
  expected_intent: string;
  /** Tools the agent MUST call to answer correctly. */
  expected_tools: ToolRequirement[];
  category: PromptCategory;
  acceptance_checks: CheckName[];
  /** ISO language code for the user's prompt; default "en". */
  language?: LanguageTag;
  /** Mark-and-don't-delete flag for retired prompts. Keep IDs stable. */
  deprecated?: boolean;
}

export interface PromptFile {
  $schema?: string;
  version: number;
  description?: string;
  prompts: PromptItem[];
}

/**
 * A single tool-call captured during the agent run.
 *
 * `result` carries the (mock) data the tool returned. The data-fidelity
 * check inspects this against the response text — if the response
 * mentions a number, that number must appear in some tool result.
 */
export interface AgentToolCall {
  name: string;
  /** Raw arguments object passed to the tool. */
  args: unknown;
  /** Whether the tool returned `{ ok: true }`. */
  ok?: boolean;
  /** The tool's return value (mock data in CI). Used by data-fidelity. */
  result?: unknown;
}

export interface AgentOutput {
  /** Final assistant text (post-streaming). */
  text: string;
  /** Tool calls made during this turn, in order. */
  toolCalls: AgentToolCall[];
  /** Identifier of the runner ("fixture", "live-handler", "openai-gpt-4o"…). */
  runner: string;
  /** Optional latency in ms. */
  latencyMs?: number;
  /** Optional input/output token counts. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  reason?: string;
  details?: unknown;
}

export interface PromptResult {
  id: string;
  category: PromptCategory;
  runner: string;
  passed: boolean;
  checks: CheckResult[];
  output: AgentOutput;
}

export interface SuiteScore {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  perCheck: Record<CheckName, { total: number; passed: number; passRate: number }>;
  perCategory: Record<PromptCategory, { total: number; passed: number; passRate: number }>;
  results: PromptResult[];
}

export interface Baseline {
  capturedAt: string;
  runner: string;
  passRate: number;
  perCategory: Record<PromptCategory, number>;
  perPrompt?: Record<string, boolean>;
  /** Target pass-rate the suite must clear. CI gates on `passRate >= target`. */
  target?: number;
}

/** Pluggable agent-runner interface. */
export type AgentRunner = (
  prompt: PromptItem,
) => Promise<AgentOutput> | AgentOutput;
