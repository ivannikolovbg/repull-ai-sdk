import { FIXTURE_CUSTOMER } from "./fixtures/customer.js";
import { callMockTool } from "./fixtures/mock-api.js";
import type {
  AgentOutput,
  AgentRunner,
  AgentToolCall,
  PromptItem,
  ToolRequirement,
} from "./types.js";

/**
 * Deterministic fixture runner — used by harness self-tests AND by
 * `npm run eval:agent --fast` for offline smoke runs in CI.
 *
 * For each prompt it:
 *  - Picks the FIRST tool from each `expected_tools` entry (OR-groups
 *    pick the first alternative) and emits a synthetic tool-call.
 *  - Synthesises a short final assistant message that references real
 *    fixture data — no invented numbers / guests / listings — so the
 *    no-hallucination check passes.
 *
 * The runner is intentionally simple. Its job is to exercise the harness,
 * not to be a smart agent. A real `<RepullAgent />` runner adapter for live
 * runs is provided as `liveAgentRunner()` below.
 */
export function fixtureRunner(): AgentRunner {
  return (prompt: PromptItem): AgentOutput => {
    const toolCalls = synthesizeToolCalls(prompt);
    const text = synthesizeText(prompt, toolCalls);
    return { text, toolCalls, runner: "fixture", latencyMs: 0 };
  };
}

function pickFirstTool(req: ToolRequirement): string {
  if (Array.isArray(req)) {
    const first = req[0];
    if (!first) throw new Error("ToolRequirement OR-group must have at least one tool");
    return first;
  }
  return req;
}

function synthesizeToolCalls(prompt: PromptItem): AgentToolCall[] {
  const today = "2026-05-04";
  const monthStart = "2026-05-01";
  const yearStart = "2026-01-01";
  return prompt.expected_tools.map((req) => {
    const name = pickFirstTool(req);
    const args = synthesizeArgs(name, today, monthStart, yearStart);
    // Drive the mock API so each tool call carries a real `result`. The
    // data-fidelity check inspects tool results when the response cites
    // numbers — synthesizing them here keeps the harness self-tests
    // honest without ever touching the real Repull API.
    const result = callMockTool(name, args);
    return { name, args, ok: true, result };
  });
}

function synthesizeArgs(
  toolName: string,
  today: string,
  monthStart: string,
  yearStart: string,
): Record<string, unknown> {
  switch (toolName) {
    case "getReservations":
      return { from: today, to: today };
    case "getCurrentPricing":
      return { listing_id: 4118, date: today };
    case "getMarketContext":
      return { city: "Lisbon", country: "Portugal" };
    case "getRevenue":
      return { from: monthStart, to: today };
    case "getOccupancyRate":
      return { from: monthStart, to: today };
    case "searchGuests":
      return { query: "Alice Johnson", limit: 10 };
    case "getCleaningRota":
      return { date: today };
    default:
      // Be defensive: harness self-tests cover unknown tools too.
      return { yearStart };
  }
}

/**
 * Synthesize the assistant-facing text. Numbers are derived from the
 * mock-api results attached to `toolCalls` — never invented — so the
 * data-fidelity check passes deterministically. Phrasing is deliberately
 * boring; the harness scores behaviour, not prose quality.
 *
 * For Spanish-language prompts, emits a short Spanish narrative so the
 * language-match check passes too.
 */
function synthesizeText(prompt: PromptItem, toolCalls: AgentToolCall[]): string {
  const isSpanish = prompt.language === "es";
  const lines: string[] = [];
  const calledNames = toolCalls.map((c) => c.name);
  if (isSpanish) {
    lines.push(
      `Resumen para ${FIXTURE_CUSTOMER.name}: usé ${calledNames.join(", ") || "ninguna herramienta"}.`,
    );
  } else {
    lines.push(
      `Looked at ${prompt.category} for ${FIXTURE_CUSTOMER.name} (customer ${FIXTURE_CUSTOMER.id}).`,
    );
    lines.push(`Tools called: ${calledNames.join(", ") || "none"}.`);
  }

  for (const call of toolCalls) {
    lines.push(narrate(call, isSpanish));
  }

  lines.push(
    isSpanish
      ? `Fuente: ${calledNames.join(" + ") || "ninguna"}.`
      : `Source: ${calledNames.join(" + ") || "(none)"}.`,
  );
  return lines.join(" ");
}

interface MaybeRevenue { total?: number; currency?: string }
interface MaybeOccupancy { occupancyPct?: number; bookedNights?: number; availableNights?: number }
interface MaybePricing { price?: number; currency?: string; listing_id?: number }
interface MaybeMarket { comp_avg?: number; top_quartile?: number; sample_size?: number; city?: string }
interface MaybeReservationsPayload { count?: number; data?: Array<{ id?: number; listing_id?: number }> }
interface MaybeGuestsPayload { count?: number; data?: Array<{ name?: string; reservation_count?: number }> }
interface MaybeCleaning { data?: Array<{ listing_id?: number; cleaner?: string }> }

/**
 * Narrate a single tool call from its actual mock result. Each branch is
 * defensive — the input is `unknown` from the dispatch — and only emits
 * numbers that are present in the result payload.
 */
function narrate(call: AgentToolCall, spanish: boolean): string {
  switch (call.name) {
    case "getRevenue": {
      const r = (call.result ?? {}) as MaybeRevenue;
      if (typeof r.total !== "number") return "";
      return spanish
        ? `Ingresos confirmados: ${r.total} ${r.currency ?? "EUR"}.`
        : `Booked revenue: ${r.total} ${r.currency ?? "EUR"}.`;
    }
    case "getOccupancyRate": {
      const r = (call.result ?? {}) as MaybeOccupancy;
      if (typeof r.occupancyPct !== "number") return "";
      return spanish
        ? `Ocupación: ${r.occupancyPct}%.`
        : `Occupancy: ${r.occupancyPct}% (${r.bookedNights ?? 0} of ${r.availableNights ?? 0} nights).`;
    }
    case "getCurrentPricing": {
      const r = (call.result ?? {}) as MaybePricing;
      if (typeof r.price !== "number") return "";
      return spanish
        ? `Precio actual: ${r.price} ${r.currency ?? "EUR"} por noche para alojamiento ${r.listing_id ?? ""}.`
        : `Current nightly price: ${r.price} ${r.currency ?? "EUR"} for listing ${r.listing_id ?? ""}.`;
    }
    case "getMarketContext": {
      const r = (call.result ?? {}) as MaybeMarket;
      if (typeof r.comp_avg !== "number") return "";
      return spanish
        ? `${r.city ?? ""}: comp medio ${r.comp_avg}, cuartil superior ${r.top_quartile ?? 0} (n=${r.sample_size ?? 0}).`
        : `${r.city ?? ""}: comp avg ${r.comp_avg}, top-quartile ${r.top_quartile ?? 0} (n=${r.sample_size ?? 0}).`;
    }
    case "getReservations": {
      const r = (call.result ?? {}) as MaybeReservationsPayload;
      const first = r.data?.[0];
      if (!first || typeof first.id !== "number") {
        return spanish ? "Sin reservas en el rango." : "No reservations in range.";
      }
      return spanish
        ? `Tienes ${r.count ?? 0} reservas; primera ${first.id} en alojamiento ${first.listing_id ?? "?"}.`
        : `You have ${r.count ?? 0} reservations; first id ${first.id} on listing ${first.listing_id ?? "?"}.`;
    }
    case "searchGuests": {
      const r = (call.result ?? {}) as MaybeGuestsPayload;
      const g = r.data?.[0];
      if (!g) return spanish ? "Sin huéspedes coincidentes." : "No matching guests.";
      return spanish
        ? `Huésped principal: ${g.name ?? ""} con ${g.reservation_count ?? 0} estancias.`
        : `Top guest match: ${g.name ?? ""} with ${g.reservation_count ?? 0} stays.`;
    }
    case "getCleaningRota": {
      const r = (call.result ?? {}) as MaybeCleaning;
      const rows = r.data ?? [];
      const ids = rows.map((row) => row.listing_id).filter((x): x is number => typeof x === "number");
      return spanish
        ? `Limpieza programada para ${rows.length} alojamientos${ids.length ? ` (${ids.join(", ")})` : ""}.`
        : `Cleaning scheduled for ${rows.length} listings${ids.length ? ` (${ids.join(", ")})` : ""}.`;
    }
    default:
      return "";
  }
}

/**
 * Live-handler runner — wires up a deployed `createAgentHandler` route.
 *
 * Not used in CI. Wired by `live-run.ts` and gated behind an explicit
 * env var so a CI accident can't burn API budget.
 */
export interface LiveRunnerOptions {
  /** URL of the customer-deployed `/api/agent/chat` endpoint. */
  endpoint: string;
  /** Optional auth header to forward (e.g. "Bearer <token>"). */
  authHeader?: string;
  /** Optional system-prompt override per turn. */
  systemPrompt?: string;
  /** Per-call timeout in ms. Default 60000. */
  timeoutMs?: number;
}

export function liveAgentRunner(opts: LiveRunnerOptions): AgentRunner {
  if (!opts.endpoint) {
    throw new Error("liveAgentRunner: `endpoint` is required.");
  }
  return async (prompt: PromptItem): Promise<AgentOutput> => {
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(opts.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt.prompt }],
          ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`agent endpoint ${res.status}: ${await res.text()}`);
      }
      const text = await res.text();
      // The bundled handler streams plain text and does NOT surface tool
      // calls in the response body. Live tool-fidelity scoring requires
      // server-side instrumentation (out of scope here) — for now the
      // live runner records an empty toolCalls array and the harness
      // tool-fidelity check will fail loudly, signalling that the
      // instrumentation hook needs to be wired.
      return {
        text,
        toolCalls: [],
        runner: "live-handler",
        latencyMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}
