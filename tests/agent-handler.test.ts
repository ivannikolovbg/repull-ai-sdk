/**
 * Handler tests — validates request shape, model-fallback behavior, and
 * proves end-to-end tool dispatch with a mocked AI SDK model.
 *
 * We use the AI SDK's official `MockLanguageModelV3` test helper so the
 * handler runs `streamText` for real (no monkey-patching). The mock model
 * scripts a tool-call -> tool-result -> final text turn, which is the
 * exact loop a real Kimi K2 / Claude call would execute.
 */
import { describe, it, expect, vi } from 'vitest';
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

describe('createAgentHandler', () => {
  it('rejects empty / malformed message bodies', async () => {
    const handler = createAgentHandler({
      apiKey: 'sk_test',
      model: new MockLanguageModelV3({
        doStream: async () => ({ stream: chunks([]) }),
      }),
      fallbackModel: null,
    });
    const res = await handler(makeRequest({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it('runs a tool-call → tool-result → final text loop end-to-end', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ items: [{ id: 1, status: 'confirmed' }, { id: 2, status: 'confirmed' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const callIdx = { n: 0 };
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callIdx.n += 1;
        if (callIdx.n === 1) {
          // Turn 1: model calls getReservations
          return {
            stream: chunks([
              { type: 'stream-start', warnings: [] },
              { type: 'response-metadata', id: 'm1', modelId: 'mock', timestamp: new Date() },
              {
                type: 'tool-call',
                toolCallId: 'call_1',
                toolName: 'getReservations',
                input: JSON.stringify({ from: '2026-05-01', to: '2026-05-07' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
              },
            ]),
          };
        }
        // Turn 2: after the tool result, the model emits a final answer
        return {
          stream: chunks([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'm2', modelId: 'mock', timestamp: new Date() },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'You have 2 confirmed bookings this week.' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 60, outputTokens: 12, totalTokens: 72 },
            },
          ]),
        };
      },
    });

    const handler = createAgentHandler({
      apiKey: 'sk_test_customer_a',
      baseUrl: 'https://api.repull.test',
      model,
      fallbackModel: null,
    });
    // Inject the fetch mock by recreating the handler with a custom client
    // is awkward — instead we shadow global fetch for this test scope.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const res = await handler(
        makeRequest({ messages: [{ role: 'user', content: 'How many bookings this week?' }] }),
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('2 confirmed bookings');

      // Tool dispatch should have hit the Repull API once with the Bearer token.
      expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
      const url = String(firstCall[0]);
      const init = firstCall[1] as RequestInit;
      expect(url).toContain('/v1/reservations');
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toBe('Bearer sk_test_customer_a');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the secondary model when the primary throws', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"items":[]}', { status: 200 })) as unknown as typeof fetch;
    const primary = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('primary outage');
      },
    });
    const fallback = new MockLanguageModelV3({
      doStream: async () => ({
        stream: chunks([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: 'm', modelId: 'mock-fb', timestamp: new Date() },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'fallback answer' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      }),
    });
    const handler = createAgentHandler({
      apiKey: 'sk_test',
      model: primary,
      fallbackModel: fallback,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }));
      // Primary throws synchronously inside streamText -> handler catches & uses fallback.
      // Fallback header is set on the response.
      expect(res.headers.get('x-repull-agent-fallback')).toBe('1');
      const text = await res.text();
      expect(text).toContain('fallback answer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to construct without an API key', () => {
    expect(() => createAgentHandler({ apiKey: '' })).toThrow(/apiKey/);
  });
});
