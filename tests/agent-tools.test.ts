/**
 * Tool-dispatch tests — exercise each tool's `execute` against a mocked
 * Repull HTTP layer, verify endpoint + query mapping, and confirm the
 * `{ ok, data }` envelope.
 */
import { describe, it, expect, vi } from 'vitest';
import { RepullClient } from '../src/client.js';
import { repullAgentTools } from '../src/agent/tools.js';

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function makeClient(responseBody: unknown, status = 200) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new RepullClient({
    apiKey: 'sk_test_customer_a',
    baseUrl: 'https://api.repull.test',
    fetch: fetchImpl,
  });
  return { client, calls, fetchImpl };
}

describe('repullAgentTools', () => {
  it('getReservations dispatches GET /v1/reservations with date range', async () => {
    const { client, calls } = makeClient({ items: [{ id: 1 }] });
    const tools = repullAgentTools(client);
    const exec = tools.getReservations.execute as (i: unknown, o?: unknown) => Promise<unknown>;
    const result = (await exec({ from: '2026-05-01', to: '2026-05-07' }, {})) as {
      ok: true;
      data: unknown;
    };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ items: [{ id: 1 }] });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/reservations');
    expect(url.searchParams.get('checkInFrom')).toBe('2026-05-01');
    expect(url.searchParams.get('checkInTo')).toBe('2026-05-07');
  });

  it('getCurrentPricing dispatches GET /v1/listings/:id/pricing', async () => {
    const { client, calls } = makeClient({ price: 199, currency: 'USD' });
    const tools = repullAgentTools(client);
    const exec = tools.getCurrentPricing.execute as (i: unknown, o?: unknown) => Promise<unknown>;
    const result = (await exec({ listing_id: 4118, date: '2026-05-09' }, {})) as {
      ok: true;
      data: unknown;
    };
    expect(result.ok).toBe(true);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/listings/4118/pricing');
    expect(url.searchParams.get('date')).toBe('2026-05-09');
  });

  it('getMarketContext hits /v1/market/context with city + country', async () => {
    const { client, calls } = makeClient({ avgPrice: 220 });
    const tools = repullAgentTools(client);
    const exec = tools.getMarketContext.execute as (i: unknown, o?: unknown) => Promise<unknown>;
    await exec({ city: 'Lisbon', country: 'PT' }, {});
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/market/context');
    expect(url.searchParams.get('city')).toBe('Lisbon');
    expect(url.searchParams.get('country')).toBe('PT');
  });

  it('getRevenue, getOccupancyRate, searchGuests, getCleaningRota route correctly', async () => {
    const { client, calls } = makeClient({});
    const tools = repullAgentTools(client);
    await (tools.getRevenue.execute as (i: unknown, o?: unknown) => Promise<unknown>)(
      { from: '2026-04-01', to: '2026-04-30' },
      {},
    );
    await (tools.getOccupancyRate.execute as (i: unknown, o?: unknown) => Promise<unknown>)(
      { from: '2026-04-01', to: '2026-04-30' },
      {},
    );
    await (tools.searchGuests.execute as (i: unknown, o?: unknown) => Promise<unknown>)(
      { query: 'Maria' },
      {},
    );
    await (tools.getCleaningRota.execute as (i: unknown, o?: unknown) => Promise<unknown>)(
      { date: '2026-05-04' },
      {},
    );
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/analytics/revenue');
    expect(new URL(calls[1]!.url).pathname).toBe('/v1/analytics/occupancy');
    expect(new URL(calls[2]!.url).pathname).toBe('/v1/guests');
    expect(new URL(calls[2]!.url).searchParams.get('q')).toBe('Maria');
    expect(new URL(calls[3]!.url).pathname).toBe('/v1/cleaning/rota');
  });

  it('returns { ok: false, error } envelope on non-2xx', async () => {
    const { client } = makeClient({ message: 'forbidden' }, 403);
    const tools = repullAgentTools(client);
    const exec = tools.getReservations.execute as (i: unknown, o?: unknown) => Promise<unknown>;
    const result = (await exec({ from: '2026-05-01', to: '2026-05-07' }, {})) as {
      ok: false;
      error: { status: number };
    };
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(403);
  });

  it('validates input — bad date format is rejected by Zod', () => {
    const { client } = makeClient({});
    const tools = repullAgentTools(client);
    const schema = (tools.getReservations as unknown as { inputSchema: { safeParse: (x: unknown) => { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ from: 'yesterday', to: '2026-05-07' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-05-01', to: '2026-05-07' }).success).toBe(true);
    void client;
  });
});

/* ────────────────────── auth scoping (multi-tenant) ────────────────────── */

describe('auth scoping — agent in customer A app cannot read customer B data', () => {
  it('always sends the customer-scoped Bearer token; never leaks across tenants', async () => {
    const seenAuth: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      if (auth) seenAuth.push(auth);
      return new Response('{"items":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const customerA = new RepullClient({
      apiKey: 'sk_customer_A',
      baseUrl: 'https://api.repull.test',
      fetch: fetchImpl,
    });
    const customerB = new RepullClient({
      apiKey: 'sk_customer_B',
      baseUrl: 'https://api.repull.test',
      fetch: fetchImpl,
    });
    const toolsA = repullAgentTools(customerA);
    const toolsB = repullAgentTools(customerB);

    const execA = toolsA.getReservations.execute as (i: unknown, o?: unknown) => Promise<unknown>;
    const execB = toolsB.getReservations.execute as (i: unknown, o?: unknown) => Promise<unknown>;

    await execA({ from: '2026-05-01', to: '2026-05-07' }, {});
    await execB({ from: '2026-05-01', to: '2026-05-07' }, {});

    expect(seenAuth).toEqual(['Bearer sk_customer_A', 'Bearer sk_customer_B']);
    // Sanity: the two clients are isolated — customer A's tool never sees
    // customer B's key on its requests.
    expect(seenAuth[0]).not.toContain('sk_customer_B');
    expect(seenAuth[1]).not.toContain('sk_customer_A');
  });
});
