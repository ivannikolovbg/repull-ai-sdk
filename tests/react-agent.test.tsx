/**
 * Smoke tests for the embedded `<RepullAgent />` React component.
 * Asserts: floating bubble renders, click opens the panel, suggested
 * prompts render, and a click on a prompt POSTs to the configured endpoint.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RepullAgent } from '../src/react/agent.js';

afterEach(() => {
  cleanup();
});

function makeStreamingFetch(chunks: string[]) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }) as unknown as typeof fetch;
}

describe('<RepullAgent />', () => {
  it('renders a floating bubble button when closed', () => {
    render(<RepullAgent />);
    const bubble = screen.getByRole('button', { name: /open repull agent/i });
    expect(bubble).toBeTruthy();
  });

  it('opens the chat panel when the bubble is clicked', () => {
    render(<RepullAgent />);
    const bubble = screen.getByRole('button', { name: /open repull agent/i });
    fireEvent.click(bubble);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Default suggested prompts should appear
    expect(screen.getByText('How many bookings this week?')).toBeTruthy();
  });

  it('streams responses from the chat endpoint when a prompt is clicked', async () => {
    const fetchImpl = makeStreamingFetch(['Hello, ', 'host!']);
    render(
      <RepullAgent
        defaultOpen
        endpoint="/test-endpoint"
        fetchImpl={fetchImpl}
        suggestedPrompts={['Test prompt']}
      />,
    );
    fireEvent.click(screen.getByText('Test prompt'));

    await waitFor(() => {
      expect(screen.getByText(/hello, host!/i)).toBeTruthy();
    });

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const [, init] = calls[0] as [unknown, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user', content: 'Test prompt' });
  });

  it('shows a configurable title and accepts custom dimensions', () => {
    render(<RepullAgent defaultOpen title="Beyondbnb Assistant" width={420} height={600} />);
    expect(screen.getByText('Beyondbnb Assistant')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const style = (dialog as HTMLElement).style;
    expect(style.width).toBe('420px');
    expect(style.height).toBe('600px');
  });

  it('respects the position prop', () => {
    const { container } = render(<RepullAgent position="top-left" />);
    const root = container.querySelector('[data-repull-agent]') as HTMLElement;
    expect(root.style.top).toBe('24px');
    expect(root.style.left).toBe('24px');
  });

  it('renders a voice input button (Web Speech API surface)', () => {
    render(<RepullAgent defaultOpen />);
    const mic = screen.getByRole('button', { name: /start voice input/i });
    expect(mic).toBeTruthy();
  });

  it('voice input shows a friendly error when SpeechRecognition is missing', () => {
    // jsdom has no SpeechRecognition by default — clicking the mic should
    // surface a helpful error instead of throwing.
    render(<RepullAgent defaultOpen />);
    const mic = screen.getByRole('button', { name: /start voice input/i });
    fireEvent.click(mic);
    expect(screen.getByText(/voice input is not supported/i)).toBeTruthy();
  });

  it('voice input transcribes a final result and dispatches a send', async () => {
    const fetchImpl = makeStreamingFetch(['ack']);
    // Fake SpeechRecognition that fires onresult + onend on .start()
    class FakeSR {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        queueMicrotask(() => {
          this.onresult?.({
            resultIndex: 0,
            results: {
              length: 1,
              0: { isFinal: true, length: 1, 0: { transcript: 'how many bookings this week' } },
            },
          });
          this.onend?.();
        });
      }
      stop(): void {}
    }
    (window as unknown as { SpeechRecognition: typeof FakeSR }).SpeechRecognition = FakeSR;

    render(<RepullAgent defaultOpen endpoint="/voice-endpoint" fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));

    await waitFor(() => {
      const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBe(1);
      const init = calls[0]![1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content).toMatch(/how many bookings this week/i);
    });

    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  });
});
