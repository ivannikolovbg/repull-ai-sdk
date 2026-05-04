/**
 * Quota preflight + usage logging tests for `createAgentHandler`.
 *
 * Covers the AGENT-LIMITS wiring:
 *
 *   1. quota=200 → call proceeds
 *   2. quota=429 → handler returns 429 with the AGENT_QUOTA_EXCEEDED envelope
 *   3. quota network error → call proceeds (fail-OPEN) and a warning is logged
 *   4. usage 200 after success → no-op (record fired, customer unaffected)
 *   5. usage 5xx after success → no-op (logged, customer's response is still good)
 *
 * All fetch traffic — both Repull-side (quota / usage) and tool-side
 * (the `getReservations` mock data fetch) — flows through a single
 * `vi.fn` we install via `quotaFetch` + `globalThis.fetch`. The mock
 * is route-aware: it inspects the URL on each call and returns the
 * right body / status. NEVER hits live endpoints.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createAgentHandler } from '../src/agent/handler.js';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function chunks(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/**
 * A model that just emits a one-line text response, no tool calls.
 * We don't care about the model loop in these tests — only the
 * pre/post quota wiring around it.
 */
function trivialTextModel(text = 'ok') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: chunks([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'm', modelId: 'mock', timestamp: new Date() },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: 'stop',
          // V3 spec: usage is `{ inputTokens: { total }, outputTokens: { total } }`.
          usage: {
            inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
          },
        },
      ]),
    }),
  });
}

/**
 * Quota snapshot helpers. Match the dominator route's response shape
 * exactly: `{ data: { tier, calls, tokens, resetAt } }`.
 */
function quotaOk(remainingCalls = 99, remainingTokens = 199_980) {
  return new Response(
    JSON.stringify({
      data: {
        tier: 'free',
        calls: { used: 1, limit: 100, remaining: remainingCalls },
        tokens: { used: 20, limit: 200_000, remaining: remainingTokens },
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function quotaBlocked() {
  return new Response(
    JSON.stringify({
      error: {
        code: 'AGENT_QUOTA_EXCEEDED',
        message: 'Daily agent quota reached',
        fix: 'Upgrade your Studio plan or wait until quota resets',
        docs_url: '/docs/studio/pricing',
        resetAt: new Date(Date.now() + 1800_000).toISOString(),
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '1800',
      },
    },
  );
}

/**
 * Build a fetch mock that routes calls based on URL + method.
 * Tool-side reservation calls return an empty list because the
 * tests in this file don't drive the tool loop.
 */
function buildFetch(handlers: {
  onQuota: () => Promise<Response> | Response;
  onUsage?: (req: { url: string; init: RequestInit }) => Promise<Response> | Response;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    if (u.endsWith('/v1/agent/quota')) return handlers.onQuota();
    if (u.endsWith('/v1/agent/usage')) {
      return handlers.onUsage
        ? handlers.onUsage({ url: u, init: i })
        : new Response(
            JSON.stringify({ data: { id: '1', idempotent_replay: false } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
    }
    // Default: tool / data fetch — empty list keeps the model loop
    // happy without dragging unrelated assertions into these tests.
    return new Response('{"items":[]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('agent quota flow', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('1) quota=200 → call proceeds (model is invoked, response streams)', async () => {
    const { fetchImpl, calls } = buildFetch({ onQuota: () => quotaOk() });
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('hi there'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('hi there');

    // Preflight must have happened.
    const quotaCall = calls.find((c) => c.url.endsWith('/v1/agent/quota'));
    expect(quotaCall, 'preflight must hit /v1/agent/quota').toBeTruthy();
    expect((quotaCall!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test',
    );

    // Wait a tick for the fire-and-forget usage POST to land in the mock.
    await new Promise((r) => setTimeout(r, 25));
    expect(calls.find((c) => c.url.endsWith('/v1/agent/usage'))).toBeTruthy();
  });

  it('2) quota=429 → handler returns 429 with AGENT_QUOTA_EXCEEDED envelope', async () => {
    const modelDoStream = vi.fn();
    const blockedModel = new MockLanguageModelV3({ doStream: modelDoStream });

    const { fetchImpl } = buildFetch({ onQuota: () => quotaBlocked() });
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: blockedModel,
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as {
      error?: {
        code?: string;
        message?: string;
        fix?: string;
        docs_url?: string;
        resetAt?: string | null;
      };
    };
    expect(body.error?.code).toBe('AGENT_QUOTA_EXCEEDED');
    expect(typeof body.error?.message).toBe('string');
    // No "Kimi"/"Moonshot" leakage in user-facing copy — the AGENT-LIMITS
    // contract says we surface the Repull-branded envelope only.
    const everyString = JSON.stringify(body).toLowerCase();
    expect(everyString).not.toContain('kimi');
    expect(everyString).not.toContain('moonshot');

    // Critically: the model must NOT have been called.
    expect(modelDoStream).not.toHaveBeenCalled();
  });

  it('3) quota network error → call proceeds (fail-open) and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Quota fetch rejects (network error). Tool fetches still resolve so
    // the model loop completes normally.
    const { fetchImpl } = buildFetch({
      onQuota: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('after the failure'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('after the failure');

    // Warning was logged so SREs can see the fail-open in dashboards.
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('quota preflight') && m.includes('failing open'))).toBe(true);
  });

  it('4) usage 200 after success → no-op (record fired, response unaffected)', async () => {
    const { fetchImpl, calls } = buildFetch({
      onQuota: () => quotaOk(),
      onUsage: () =>
        new Response(
          JSON.stringify({ data: { id: 'rec_1', idempotent_replay: false } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('done'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('done');

    // Wait for the fire-and-forget usage POST.
    await new Promise((r) => setTimeout(r, 25));
    const usageCall = calls.find((c) => c.url.endsWith('/v1/agent/usage'));
    expect(usageCall, 'usage record must be POSTed').toBeTruthy();
    expect(usageCall!.init.method).toBe('POST');
    const body = JSON.parse(String(usageCall!.init.body)) as Record<string, unknown>;
    expect(typeof body.request_id).toBe('string');
    expect(body.tokens_in).toBe(12);
    expect(body.tokens_out).toBe(4);
    expect(body.fallback).toBe(false);
    expect(typeof body.latency_ms).toBe('number');
  });

  it('5) usage 5xx after success → no-op (logged, customer response is still good)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { fetchImpl, calls } = buildFetch({
      onQuota: () => quotaOk(),
      onUsage: () =>
        new Response('{"error":"db down"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('still works'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );

    // Customer's response is unaffected — the failure happens out-of-band.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('still works');

    // Wait for the fire-and-forget usage POST + retry to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Usage endpoint was hit (and retried once on 5xx), then bailed out.
    const usageCalls = calls.filter((c) => c.url.endsWith('/v1/agent/usage'));
    expect(usageCalls.length).toBeGreaterThanOrEqual(1);

    // A warning was logged but the response was already fine.
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('usage record') && m.includes('5xx'))).toBe(true);
  });
});
