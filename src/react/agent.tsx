/**
 * `<RepullAgent />` — embedded chat-bubble component for Studio-built customer apps.
 *
 * The bubble floats in a corner of the customer's app. Clicking it opens a panel
 * wired to the customer's `/api/agent/chat` endpoint (powered by `createAgentHandler`).
 *
 * The agent runs with the CUSTOMER's Repull API key (injected at deploy time as
 * `REPULL_API_KEY`). The auth boundary is enforced server-side by the Repull API —
 * the agent in customer A's app cannot see customer B's data.
 */
import * as React from 'react';

/* ---------------------------- types ---------------------------- */

export type AgentPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left';

export type AgentTheme = 'light' | 'dark' | 'auto';

export interface RepullAgentProps {
  /** Endpoint to POST chat messages to. Defaults to `/api/agent/chat`. */
  endpoint?: string;
  /** Float position. Defaults to `'bottom-right'`. */
  position?: AgentPosition;
  /** Panel width in px. Defaults to `380`. */
  width?: number;
  /** Panel height in px. Defaults to `560`. */
  height?: number;
  /** Light / dark / auto. Defaults to `'auto'` (uses `prefers-color-scheme`). */
  theme?: AgentTheme;
  /** Headline shown above the chat. Defaults to `'Repull Agent'`. */
  title?: string;
  /** Greeting shown when the panel opens for the first time. */
  greeting?: string;
  /** Suggested prompts. Defaults to a PM-flavored set. */
  suggestedPrompts?: string[];
  /** Whether to start with the panel open. Defaults to `false`. */
  defaultOpen?: boolean;
  /** Extra HTTP headers (e.g. CSRF token). */
  headers?: Record<string, string>;
  /** Callback when the panel is opened or closed. */
  onOpenChange?: (open: boolean) => void;
  /** Optional fetch override (for tests / custom transport). */
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Marks an in-flight assistant message that's still streaming. */
  pending?: boolean;
}

const DEFAULT_PROMPTS = [
  'How many bookings this week?',
  'Why is my pricing low for Saturday?',
  'Email me a daily summary',
];

const DEFAULT_GREETING =
  "Hi — I have access to your reservations, calendar, pricing, revenue, and cleaning rota. Ask me anything.";

/* ---------------------------- component ---------------------------- */

export function RepullAgent(props: RepullAgentProps): React.ReactElement {
  const {
    endpoint = '/api/agent/chat',
    position = 'bottom-right',
    width = 380,
    height = 560,
    theme = 'auto',
    title = 'Repull Agent',
    greeting = DEFAULT_GREETING,
    suggestedPrompts = DEFAULT_PROMPTS,
    defaultOpen = false,
    headers,
    onOpenChange,
    fetchImpl,
  } = props;

  const [open, setOpen] = React.useState(defaultOpen);
  const [input, setInput] = React.useState('');
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [isListening, setIsListening] = React.useState(false);
  const [voiceError, setVoiceError] = React.useState<string | null>(null);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const setOpenAnd = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  /* ------------- send a message ------------- */
  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput('');
      const userMsg: ChatMessage = { role: 'user', content: trimmed };
      const pendingMsg: ChatMessage = { role: 'assistant', content: '', pending: true };
      setMessages((prev) => [...prev, userMsg, pendingMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const fetchFn = fetchImpl ?? fetch;

      try {
        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
          body: JSON.stringify({
            messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const errText = await safeText(res);
          setMessages((prev) =>
            replaceLastPending(prev, `Error: ${res.status} ${errText || res.statusText}`),
          );
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = '';
        // Read the streaming text response until done
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          acc += chunk;
          setMessages((prev) => replaceLastPending(prev, acc, true));
        }
        setMessages((prev) => replaceLastPending(prev, acc, false));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          setMessages((prev) => replaceLastPending(prev, '(stopped)'));
        } else {
          setMessages((prev) =>
            replaceLastPending(prev, `Error: ${(err as Error)?.message ?? 'unknown'}`),
          );
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [endpoint, fetchImpl, headers, isStreaming, messages],
  );

  /* ------------- voice input (Web Speech API) ------------- */
  const startListening = React.useCallback(() => {
    setVoiceError(null);
    const SR = getSpeechRecognition();
    if (!SR) {
      setVoiceError('Voice input is not supported in this browser.');
      return;
    }
    const recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    let finalTranscript = '';
    recognition.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalTranscript += alt.transcript;
        } else {
          interim += alt.transcript;
        }
      }
      setInput(finalTranscript || interim);
    };
    recognition.onerror = (ev: SpeechRecognitionErrorEvent) => {
      setVoiceError(ev.error || 'voice-error');
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      if (finalTranscript.trim()) {
        void send(finalTranscript);
      }
    };
    recognition.start();
    setIsListening(true);
  }, [send]);

  const stopListening = React.useCallback(() => {
    setIsListening(false);
    // The active recognition closes itself on `recognition.stop()`; users
    // who want full control can wrap this component. Default UX: rely on
    // `onend` -> `setIsListening(false)`.
  }, []);

  /* ------------- effects ------------- */
  React.useEffect(() => {
    // Auto-scroll to bottom on new messages.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /* ------------- styles ------------- */
  const resolvedTheme = useResolvedTheme(theme);
  const palette = resolvedTheme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  const corner = positionToStyle(position);

  const showGreeting = messages.length === 0;

  return (
    <div
      data-repull-agent
      data-theme={resolvedTheme}
      style={{
        position: 'fixed',
        zIndex: 2147483000,
        ...corner,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        ...({
          ['--repull-agent-bg' as string]: palette.bg,
          ['--repull-agent-fg' as string]: palette.fg,
          ['--repull-agent-muted' as string]: palette.muted,
          ['--repull-agent-border' as string]: palette.border,
          ['--repull-agent-accent' as string]: palette.accent,
          ['--repull-agent-accent-fg' as string]: palette.accentFg,
          ['--repull-agent-bubble-user' as string]: palette.bubbleUser,
          ['--repull-agent-bubble-assistant' as string]: palette.bubbleAssistant,
        } as React.CSSProperties),
      }}
    >
      {open ? (
        <div
          role="dialog"
          aria-label={title}
          style={{
            width,
            height,
            background: 'var(--repull-agent-bg)',
            color: 'var(--repull-agent-fg)',
            border: '1px solid var(--repull-agent-border)',
            borderRadius: 16,
            boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              borderBottom: '1px solid var(--repull-agent-border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 8,
                  background: 'var(--repull-agent-accent)',
                  display: 'inline-block',
                }}
              />
              <strong style={{ fontSize: 14 }}>{title}</strong>
            </div>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => setOpenAnd(false)}
              style={iconBtnStyle}
            >
              {'×'}
            </button>
          </div>

          {/* messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              padding: 14,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {showGreeting ? (
              <>
                <div style={{ color: 'var(--repull-agent-muted)', fontSize: 13 }}>{greeting}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  {suggestedPrompts.map((p) => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => void send(p)}
                      style={{
                        textAlign: 'left',
                        background: 'transparent',
                        color: 'var(--repull-agent-fg)',
                        border: '1px solid var(--repull-agent-border)',
                        borderRadius: 10,
                        padding: '8px 10px',
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              messages.map((m, i) => <Bubble key={i} message={m} />)
            )}
          </div>

          {/* composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            style={{
              borderTop: '1px solid var(--repull-agent-border)',
              padding: 10,
              display: 'flex',
              alignItems: 'flex-end',
              gap: 6,
              background: 'var(--repull-agent-bg)',
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder={isListening ? 'Listening...' : 'Ask about your bookings, pricing, revenue...'}
              style={{
                flex: 1,
                resize: 'none',
                border: '1px solid var(--repull-agent-border)',
                borderRadius: 10,
                padding: '8px 10px',
                fontSize: 13,
                background: 'transparent',
                color: 'var(--repull-agent-fg)',
                outline: 'none',
                fontFamily: 'inherit',
              }}
              disabled={isStreaming}
            />
            <button
              type="button"
              aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
              onClick={isListening ? stopListening : startListening}
              style={{
                ...iconBtnStyle,
                color: isListening ? 'var(--repull-agent-accent)' : 'var(--repull-agent-muted)',
              }}
            >
              {isListening ? '■' : '\u{1F3A4}'}
            </button>
            <button
              type="submit"
              aria-label="Send message"
              disabled={!input.trim() || isStreaming}
              style={{
                background: 'var(--repull-agent-accent)',
                color: 'var(--repull-agent-accent-fg)',
                border: 'none',
                borderRadius: 10,
                padding: '8px 12px',
                fontSize: 13,
                cursor: input.trim() && !isStreaming ? 'pointer' : 'default',
                opacity: input.trim() && !isStreaming ? 1 : 0.5,
              }}
            >
              {isStreaming ? '...' : 'Send'}
            </button>
          </form>

          {voiceError ? (
            <div
              role="status"
              style={{
                background: 'var(--repull-agent-bg)',
                color: 'var(--repull-agent-muted)',
                padding: '6px 12px',
                fontSize: 11,
                borderTop: '1px solid var(--repull-agent-border)',
              }}
            >
              {voiceError}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open ${title}`}
          onClick={() => setOpenAnd(true)}
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            border: 'none',
            background: 'var(--repull-agent-accent)',
            color: 'var(--repull-agent-accent-fg)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
            cursor: 'pointer',
            fontSize: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {'\u{1F4AC}'}
        </button>
      )}
    </div>
  );
}

/* ---------------------------- helpers ---------------------------- */

function Bubble({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        background: isUser ? 'var(--repull-agent-bubble-user)' : 'var(--repull-agent-bubble-assistant)',
        color: 'var(--repull-agent-fg)',
        padding: '8px 11px',
        borderRadius: 12,
        fontSize: 13,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.45,
      }}
    >
      {message.content || (message.pending ? '...' : '')}
    </div>
  );
}

function replaceLastPending(prev: ChatMessage[], text: string, stillPending = false): ChatMessage[] {
  const next = prev.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const item = next[i];
    if (item && item.role === 'assistant' && (item.pending || !stillPending)) {
      next[i] = { role: 'assistant', content: text, pending: stillPending };
      return next;
    }
  }
  next.push({ role: 'assistant', content: text, pending: stillPending });
  return next;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

const LIGHT_PALETTE = {
  bg: '#ffffff',
  fg: '#0b0b0c',
  muted: '#5a5a64',
  border: 'rgba(0,0,0,0.08)',
  accent: '#0b0b0c',
  accentFg: '#ffffff',
  bubbleUser: '#0b0b0c',
  bubbleAssistant: '#f3f3f5',
};
const DARK_PALETTE = {
  bg: '#0b0b0c',
  fg: '#f5f5f7',
  muted: '#9b9ba3',
  border: 'rgba(255,255,255,0.10)',
  accent: '#f5f5f7',
  accentFg: '#0b0b0c',
  bubbleUser: '#f5f5f7',
  bubbleAssistant: 'rgba(255,255,255,0.06)',
};

function useResolvedTheme(theme: AgentTheme): 'light' | 'dark' {
  const [resolved, setResolved] = React.useState<'light' | 'dark'>(() => {
    if (theme !== 'auto') return theme;
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  React.useEffect(() => {
    if (theme !== 'auto') {
      setResolved(theme);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (): void => setResolved(mq.matches ? 'dark' : 'light');
    fn();
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, [theme]);
  return resolved;
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--repull-agent-muted)',
  fontSize: 18,
  cursor: 'pointer',
  padding: 4,
  lineHeight: 1,
};

function positionToStyle(p: AgentPosition): React.CSSProperties {
  switch (p) {
    case 'bottom-left':
      return { bottom: 24, left: 24 };
    case 'top-right':
      return { top: 24, right: 24 };
    case 'top-left':
      return { top: 24, left: 24 };
    case 'bottom-right':
    default:
      return { bottom: 24, right: 24 };
  }
}

/* ---- Web Speech API typing (kept loose to avoid lib.dom dependency) ---- */
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult | undefined;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative | undefined;
}
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionErrorEvent {
  error: string;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default RepullAgent;
