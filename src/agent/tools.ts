import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { RepullApiError, type RepullClient } from '../client.js';

/**
 * Result envelope shared by every embedded-agent tool. Successful calls return
 * `{ ok: true, data }`, failures return `{ ok: false, error }` so the model
 * can recover (apologize / retry / ask the user) instead of hard-aborting.
 */
export type AgentToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { status: number | null; message: string; body?: unknown } };

function toErrorResult(err: unknown): AgentToolResult<never> {
  if (err instanceof RepullApiError) {
    return { ok: false, error: { status: err.status, message: err.message, body: err.body } };
  }
  if (err instanceof Error) {
    return { ok: false, error: { status: null, message: err.message } };
  }
  return { ok: false, error: { status: null, message: String(err) } };
}

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date YYYY-MM-DD.');

/* ─────────────────────────── input schemas ─────────────────────────── */

const GetReservationsInput = z.object({
  from: IsoDate.describe('Range start (inclusive), ISO YYYY-MM-DD. Compared against check-in date.'),
  to: IsoDate.describe('Range end (inclusive), ISO YYYY-MM-DD. Compared against check-in date.'),
  status: z
    .enum(['pending', 'confirmed', 'cancelled', 'completed'])
    .optional()
    .describe('Filter by reservation status.'),
  listing_id: z
    .union([z.number().int().positive(), z.string().min(1)])
    .optional()
    .describe('Restrict to a single listing/property by Repull listing ID.'),
});

const GetCurrentPricingInput = z.object({
  listing_id: z
    .union([z.number().int().positive(), z.string().min(1)])
    .describe('Repull listing ID to fetch pricing for.'),
  date: IsoDate.describe('Calendar date to fetch nightly price for, ISO YYYY-MM-DD.'),
});

const SearchGuestsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('Free-text query — matched against guest name, email, and phone.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50).'),
});

/* ─────────────────────────── tool factory ─────────────────────────── */

export interface AgentToolSet {
  getReservations: Tool;
  getCurrentPricing: Tool;
  searchGuests: Tool;
}

/**
 * Build the embedded-agent tool set bound to a {@link RepullClient}.
 *
 * These tools are intentionally PM-flavored aggregations — designed for
 * a chat widget the property manager hits every day ("bookings this
 * week?", "what's listing 4118 priced at tonight?", "look up this
 * guest"). They map to high-level Repull API endpoints; in production
 * the customer's deployed Studio app brokers them with the
 * customer-scoped API key.
 *
 * The same `AgentToolResult<T>` envelope used in {@link repullTools}
 * applies — failures return `{ ok: false, error }` so the model can
 * recover gracefully.
 */
export function repullAgentTools(client: RepullClient): AgentToolSet {
  return {
    getReservations: tool({
      description:
        'List reservations whose check-in date falls in the given range. Optional filters: ' +
        '`status` (pending/confirmed/cancelled/completed), `listing_id`. Read-only. ' +
        'Use this for "how many bookings this week?", "show me cancellations in May", etc.',
      inputSchema: GetReservationsInput,
      execute: async (input): Promise<AgentToolResult<unknown>> => {
        try {
          const data = await client.request<unknown>('GET', '/v1/reservations', {
            query: {
              checkInFrom: input.from,
              checkInTo: input.to,
              ...(input.status ? { status: input.status } : {}),
              ...(input.listing_id !== undefined ? { listingId: input.listing_id } : {}),
              limit: 100,
            },
          });
          return { ok: true, data };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    }),

    getCurrentPricing: tool({
      description:
        'Fetch the nightly price currently being advertised for a listing on a given date. ' +
        'Returns the calendar entry (price, currency, min-stay, availability). Read-only.',
      inputSchema: GetCurrentPricingInput,
      execute: async (input): Promise<AgentToolResult<unknown>> => {
        try {
          const listingId = encodeURIComponent(String(input.listing_id));
          const data = await client.request<unknown>(
            'GET',
            `/v1/listings/${listingId}/pricing`,
            { query: { date: input.date } },
          );
          return { ok: true, data };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    }),

    searchGuests: tool({
      description:
        'Free-text search across the guest CRM (name / email / phone). Returns matching guests ' +
        'with reservation counts. Read-only.',
      inputSchema: SearchGuestsInput,
      execute: async (input): Promise<AgentToolResult<unknown>> => {
        try {
          const data = await client.request<unknown>('GET', '/v1/guests', {
            query: { q: input.query, ...(input.limit ? { limit: input.limit } : {}) },
          });
          return { ok: true, data };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    }),
  };
}

/** Names of every tool returned by {@link repullAgentTools}. */
export type AgentToolName = keyof AgentToolSet;
