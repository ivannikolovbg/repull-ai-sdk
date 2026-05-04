/**
 * Tests for the per-project attribution wedge in `createAgentHandler`.
 *
 * The SDK now forwards a Studio `projectId` to `/v1/agent/usage` so
 * `agent_usage_log.project_id` gets stamped — that's what makes the
 * dominator dashboard's per-project rollup return non-zero counts.
 *
 * Coverage:
 *   1. explicit `projectId` in handler options → POST body has `project_id`
 *   2. `REPULL_PROJECT_ID` env var fallback → POST body has `project_id`
 *   3. neither set (off-Studio install) → POST body OMITS `project_id`
 *      (rows persist with NULL — no-op for the per-project rollup)
 *   4. invalid `projectId` (NaN / negative / non-integer) → silently
 *      dropped, body omits `project_id`
 *
 * Test setup mirrors `agent-quota-flow.test.ts` — same fetch mock,
 * same trivial model.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
        },
      ]),
    }),
  });
}

function quotaOk() {
  return new Response(
    JSON.stringify({
      data: {
        tier: 'free',
        calls: { used: 1, limit: 100, remaining: 99 },
        tokens: { used: 7, limit: 200_000, remaining: 199_993 },
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function buildFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    if (u.endsWith('/v1/agent/quota')) return quotaOk();
    if (u.endsWith('/v1/agent/usage')) {
      return new Response(
        JSON.stringify({ data: { id: '1', idempotent_replay: false } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{"items":[]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function getUsageBody(
  calls: Array<{ url: string; init: RequestInit }>,
): Promise<Record<string, unknown> | null> {
  // Wait for the fire-and-forget usage POST to land in the mock.
  await new Promise((r) => setTimeout(r, 25));
  const usageCall = calls.find((c) => c.url.endsWith('/v1/agent/usage'));
  if (!usageCall) return null;
  return JSON.parse(String(usageCall.init.body)) as Record<string, unknown>;
}

describe('agent project_id forwarding', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.REPULL_PROJECT_ID;

  beforeEach(() => {
    delete process.env.REPULL_PROJECT_ID;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.REPULL_PROJECT_ID;
    else process.env.REPULL_PROJECT_ID = originalEnv;
    vi.restoreAllMocks();
  });

  it('1) explicit projectId option → POST body carries project_id', async () => {
    const { fetchImpl, calls } = buildFetch();
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('hi'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
      projectId: 4242,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(res.status).toBe(200);

    const body = await getUsageBody(calls);
    expect(body).toBeTruthy();
    expect(body!.project_id).toBe(4242);
    // The other AGENT-LIMITS fields stay intact.
    expect(typeof body!.request_id).toBe('string');
    expect(body!.tokens_in).toBe(5);
    expect(body!.tokens_out).toBe(2);
  });

  it('2) REPULL_PROJECT_ID env fallback → POST body carries project_id', async () => {
    process.env.REPULL_PROJECT_ID = '7777';
    const { fetchImpl, calls } = buildFetch();
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('hi'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
      // No `projectId` option — the env var must take effect.
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(res.status).toBe(200);

    const body = await getUsageBody(calls);
    expect(body).toBeTruthy();
    // Env var was a string — the handler coerces to a number so the
    // dominator route's strict `typeof === 'number'` validator
    // accepts it.
    expect(body!.project_id).toBe(7777);
  });

  it('3) no projectId + no env → POST body OMITS project_id (off-Studio install)', async () => {
    const { fetchImpl, calls } = buildFetch();
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('hi'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(res.status).toBe(200);

    const body = await getUsageBody(calls);
    expect(body).toBeTruthy();
    expect('project_id' in body!).toBe(false);
  });

  it('4) invalid projectId (negative / non-integer / NaN) → silently dropped', async () => {
    process.env.REPULL_PROJECT_ID = 'not-a-number';
    const { fetchImpl, calls } = buildFetch();
    globalThis.fetch = fetchImpl;

    const handler = createAgentHandler({
      apiKey: 'sk_test',
      baseUrl: 'https://api.repull.test',
      model: trivialTextModel('hi'),
      fallbackModel: null,
      quotaFetch: fetchImpl,
      // Numeric input — but negative + non-integer paths are also
      // covered: they all resolve to `undefined` in `resolveProjectId`.
      projectId: -1,
    });

    const res = await handler(
      makeRequest({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(res.status).toBe(200);

    const body = await getUsageBody(calls);
    expect(body).toBeTruthy();
    expect('project_id' in body!).toBe(false);
  });
});
