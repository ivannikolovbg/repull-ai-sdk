/**
 * Smoke tests for the vanilla-JS `RepullAgent.init()` API.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RepullAgent } from '../src/headless/agent.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('headless RepullAgent', () => {
  it('mounts a bubble and toggles open/close', () => {
    const agent = RepullAgent.init();
    const root = document.querySelector('[data-repull-agent]') as HTMLElement;
    expect(root).toBeTruthy();
    expect(agent.isOpen()).toBe(false);
    agent.open();
    expect(agent.isOpen()).toBe(true);
    agent.toggle();
    expect(agent.isOpen()).toBe(false);
    agent.destroy();
    expect(document.querySelector('[data-repull-agent]')).toBe(null);
  });

  it('refuses to accept an apiKey in browser code (security boundary)', () => {
    expect(() =>
      RepullAgent.init({
        // @ts-expect-error — runtime check that catches stray browser-side keys
        apiKey: 'sk_should_never_be_in_browser',
      }),
    ).toThrow(/apiKey/);
  });

  it('send() POSTs to the configured endpoint and renders streaming output', async () => {
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Two bookings.'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const agent = RepullAgent.init({
      endpoint: '/api/agent/chat',
      fetchImpl,
    });
    await agent.send('hi');
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe('/api/agent/chat');
    expect(document.body.textContent).toContain('Two bookings.');
    agent.destroy();
  });
});
