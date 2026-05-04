/**
 * Headless `RepullAgent` — vanilla-JS API for embedding the agent in a non-React
 * app (or anywhere a script tag can run). Mounts a floating bubble + chat panel
 * with the same UX as the React component, no React dependency.
 *
 * @example
 * ```ts
 * import { RepullAgent } from '@repull/ai-sdk/headless';
 *
 * const agent = RepullAgent.init({
 *   endpoint: '/api/agent/chat',
 *   position: 'bottom-right',
 * });
 *
 * agent.open();
 * agent.send('How many bookings this week?');
 * agent.close();
 * ```
 */

export type AgentPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type AgentTheme = 'light' | 'dark' | 'auto';

export interface RepullAgentInitOptions {
  /** Endpoint to POST chat messages to. Defaults to `/api/agent/chat`. */
  endpoint?: string;
  /** Float position. Defaults to `'bottom-right'`. */
  position?: AgentPosition;
  /** Panel width in px. Defaults to `380`. */
  width?: number;
  /** Panel height in px. Defaults to `560`. */
  height?: number;
  /** Light / dark / auto. Defaults to `'auto'`. */
  theme?: AgentTheme;
  /** Headline. */
  title?: string;
  /** Greeting shown when the panel opens. */
  greeting?: string;
  /** Suggested prompts. */
  suggestedPrompts?: string[];
  /** Extra HTTP headers (e.g. CSRF token). */
  headers?: Record<string, string>;
  /**
   * `apiKey` is intentionally NOT accepted here — the headless SDK runs in
   * the browser and must never see the customer's Repull API key. The key
   * stays server-side, brokered by the customer-deployed `/api/agent/chat`
   * endpoint (powered by `createAgentHandler`).
   *
   * This field is reserved purely to fail-fast if a caller passes one by
   * mistake.
   */
  apiKey?: never;
  /** Where to mount the widget. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

const DEFAULT_PROMPTS = [
  'How many bookings this week?',
  'Why is my pricing low for Saturday?',
  'Email me a daily summary',
];

const DEFAULT_GREETING =
  "Hi — I have access to your reservations, calendar, pricing, revenue, and cleaning rota. Ask me anything.";

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

/**
 * Public instance returned by `RepullAgent.init()`. Holds DOM references and
 * exposes imperative methods. Mostly stable — adding new methods is
 * backwards-compatible.
 */
export interface RepullAgentInstance {
  open(): void;
  close(): void;
  toggle(): void;
  send(text: string): Promise<void>;
  destroy(): void;
  /** Returns whether the chat panel is currently visible. */
  isOpen(): boolean;
}

/* ---------------------------- public API ---------------------------- */

export const RepullAgent = {
  /**
   * Mount a floating chat widget. Idempotent only in the sense that calling
   * `init` twice creates two widgets — call `destroy()` first if remounting.
   */
  init(options: RepullAgentInitOptions = {}): RepullAgentInstance {
    if (typeof document === 'undefined') {
      throw new Error('RepullAgent.init() must be called in a browser environment.');
    }
    if ('apiKey' in options && options.apiKey != null) {
      throw new Error(
        'RepullAgent: do NOT pass `apiKey` to the browser SDK. The Repull API key must stay server-side; ' +
          'the agent talks to /api/agent/chat which holds the key.',
      );
    }

    const cfg = {
      endpoint: options.endpoint ?? '/api/agent/chat',
      position: options.position ?? ('bottom-right' as AgentPosition),
      width: options.width ?? 380,
      height: options.height ?? 560,
      theme: options.theme ?? ('auto' as AgentTheme),
      title: options.title ?? 'Repull Agent',
      greeting: options.greeting ?? DEFAULT_GREETING,
      prompts: options.suggestedPrompts ?? DEFAULT_PROMPTS,
      headers: options.headers ?? {},
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      container: options.container ?? document.body,
    };

    const state: { open: boolean; messages: ChatMessage[]; streaming: boolean; abort: AbortController | null } = {
      open: false,
      messages: [],
      streaming: false,
      abort: null,
    };

    /* ---------- root ---------- */
    const root = document.createElement('div');
    root.setAttribute('data-repull-agent', '');
    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483000',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      ...positionStyle(cfg.position),
    } as CSSStyleDeclarationLike);
    cfg.container.appendChild(root);

    /* ---------- theme ---------- */
    const applyTheme = (): void => {
      const palette = resolveTheme(cfg.theme) === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
      root.style.setProperty('--repull-agent-bg', palette.bg);
      root.style.setProperty('--repull-agent-fg', palette.fg);
      root.style.setProperty('--repull-agent-muted', palette.muted);
      root.style.setProperty('--repull-agent-border', palette.border);
      root.style.setProperty('--repull-agent-accent', palette.accent);
      root.style.setProperty('--repull-agent-accent-fg', palette.accentFg);
      root.style.setProperty('--repull-agent-bubble-user', palette.bubbleUser);
      root.style.setProperty('--repull-agent-bubble-assistant', palette.bubbleAssistant);
    };
    applyTheme();
    let themeMql: MediaQueryList | null = null;
    let themeListener: (() => void) | null = null;
    if (cfg.theme === 'auto' && typeof window !== 'undefined' && window.matchMedia) {
      themeMql = window.matchMedia('(prefers-color-scheme: dark)');
      themeListener = applyTheme;
      themeMql.addEventListener?.('change', themeListener);
    }

    /* ---------- bubble (closed state) ---------- */
    const bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.setAttribute('aria-label', `Open ${cfg.title}`);
    bubble.textContent = '\u{1F4AC}';
    Object.assign(bubble.style, {
      width: '56px',
      height: '56px',
      borderRadius: '28px',
      border: 'none',
      background: 'var(--repull-agent-accent)',
      color: 'var(--repull-agent-accent-fg)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
      cursor: 'pointer',
      fontSize: '22px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    } as CSSStyleDeclarationLike);
    root.appendChild(bubble);

    /* ---------- panel (open state, lazily built once) ---------- */
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', cfg.title);
    Object.assign(panel.style, {
      width: `${cfg.width}px`,
      height: `${cfg.height}px`,
      background: 'var(--repull-agent-bg)',
      color: 'var(--repull-agent-fg)',
      border: '1px solid var(--repull-agent-border)',
      borderRadius: '16px',
      boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
    } as CSSStyleDeclarationLike);
    root.appendChild(panel);

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 14px',
      borderBottom: '1px solid var(--repull-agent-border)',
    } as CSSStyleDeclarationLike);
    const titleEl = document.createElement('strong');
    titleEl.textContent = cfg.title;
    titleEl.style.fontSize = '14px';
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '8px',
      height: '8px',
      borderRadius: '8px',
      background: 'var(--repull-agent-accent)',
      display: 'inline-block',
      marginRight: '8px',
    } as CSSStyleDeclarationLike);
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.appendChild(dot);
    left.appendChild(titleEl);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, iconBtnStyle);
    header.appendChild(left);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    Object.assign(body.style, {
      flex: '1',
      padding: '14px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    } as CSSStyleDeclarationLike);
    panel.appendChild(body);

    // Composer
    const form = document.createElement('form');
    Object.assign(form.style, {
      borderTop: '1px solid var(--repull-agent-border)',
      padding: '10px',
      display: 'flex',
      alignItems: 'flex-end',
      gap: '6px',
      background: 'var(--repull-agent-bg)',
    } as CSSStyleDeclarationLike);
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.placeholder = 'Ask about your bookings, pricing, revenue...';
    Object.assign(textarea.style, {
      flex: '1',
      resize: 'none',
      border: '1px solid var(--repull-agent-border)',
      borderRadius: '10px',
      padding: '8px 10px',
      fontSize: '13px',
      background: 'transparent',
      color: 'var(--repull-agent-fg)',
      outline: 'none',
      fontFamily: 'inherit',
    } as CSSStyleDeclarationLike);
    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.setAttribute('aria-label', 'Start voice input');
    micBtn.textContent = '\u{1F3A4}';
    Object.assign(micBtn.style, iconBtnStyle);
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.textContent = 'Send';
    Object.assign(sendBtn.style, {
      background: 'var(--repull-agent-accent)',
      color: 'var(--repull-agent-accent-fg)',
      border: 'none',
      borderRadius: '10px',
      padding: '8px 12px',
      fontSize: '13px',
      cursor: 'pointer',
    } as CSSStyleDeclarationLike);
    form.appendChild(textarea);
    form.appendChild(micBtn);
    form.appendChild(sendBtn);
    panel.appendChild(form);

    /* ---------- render ---------- */
    const renderBody = (): void => {
      body.innerHTML = '';
      if (state.messages.length === 0) {
        const greet = document.createElement('div');
        greet.style.color = 'var(--repull-agent-muted)';
        greet.style.fontSize = '13px';
        greet.textContent = cfg.greeting;
        body.appendChild(greet);
        const list = document.createElement('div');
        Object.assign(list.style, {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          marginTop: '8px',
        } as CSSStyleDeclarationLike);
        for (const p of cfg.prompts) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = p;
          Object.assign(btn.style, {
            textAlign: 'left',
            background: 'transparent',
            color: 'var(--repull-agent-fg)',
            border: '1px solid var(--repull-agent-border)',
            borderRadius: '10px',
            padding: '8px 10px',
            fontSize: '13px',
            cursor: 'pointer',
          } as CSSStyleDeclarationLike);
          btn.onclick = (): void => {
            void instance.send(p);
          };
          list.appendChild(btn);
        }
        body.appendChild(list);
      } else {
        for (const m of state.messages) {
          body.appendChild(renderBubble(m));
        }
      }
      body.scrollTop = body.scrollHeight;
    };

    /* ---------- behavior ---------- */
    const setOpen = (next: boolean): void => {
      state.open = next;
      bubble.style.display = next ? 'none' : 'flex';
      panel.style.display = next ? 'flex' : 'none';
      if (next) renderBody();
    };

    bubble.onclick = (): void => setOpen(true);
    closeBtn.onclick = (): void => setOpen(false);

    form.onsubmit = (e: Event): void => {
      e.preventDefault();
      const v = textarea.value;
      if (!v.trim() || state.streaming) return;
      textarea.value = '';
      void instance.send(v);
    };
    textarea.onkeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = textarea.value;
        if (!v.trim() || state.streaming) return;
        textarea.value = '';
        void instance.send(v);
      }
    };

    micBtn.onclick = (): void => {
      const SR = getSpeechRecognition();
      if (!SR) {
        textarea.placeholder = 'Voice not supported in this browser.';
        return;
      }
      const r = new SR();
      r.lang = navigator.language || 'en-US';
      r.interimResults = true;
      r.continuous = false;
      let finalTr = '';
      r.onresult = (ev): void => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const result = ev.results[i];
          if (!result) continue;
          const alt = result[0];
          if (!alt) continue;
          if (result.isFinal) finalTr += alt.transcript;
          else interim += alt.transcript;
        }
        textarea.value = finalTr || interim;
      };
      r.onend = (): void => {
        micBtn.style.color = 'var(--repull-agent-muted)';
        if (finalTr.trim()) void instance.send(finalTr);
      };
      r.onerror = (): void => {
        micBtn.style.color = 'var(--repull-agent-muted)';
      };
      micBtn.style.color = 'var(--repull-agent-accent)';
      r.start();
    };

    /* ---------- instance ---------- */
    const instance: RepullAgentInstance = {
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!state.open),
      isOpen: () => state.open,
      destroy: () => {
        state.abort?.abort();
        if (themeMql && themeListener) themeMql.removeEventListener?.('change', themeListener);
        root.remove();
      },
      send: async (text: string): Promise<void> => {
        const trimmed = text.trim();
        if (!trimmed || state.streaming) return;
        if (!state.open) setOpen(true);
        const userMsg: ChatMessage = { role: 'user', content: trimmed };
        const pendingMsg: ChatMessage = { role: 'assistant', content: '', pending: true };
        state.messages.push(userMsg, pendingMsg);
        state.streaming = true;
        renderBody();

        const controller = new AbortController();
        state.abort = controller;
        try {
          const res = await cfg.fetchImpl(cfg.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...cfg.headers },
            body: JSON.stringify({
              messages: state.messages
                .filter((m) => !m.pending)
                .map((m) => ({ role: m.role, content: m.content })),
            }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const t = await safeText(res);
            updateLastPending(state.messages, `Error: ${res.status} ${t || res.statusText}`, false);
            renderBody();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let acc = '';
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            acc += decoder.decode(value, { stream: true });
            updateLastPending(state.messages, acc, true);
            renderBody();
          }
          updateLastPending(state.messages, acc, false);
          renderBody();
        } catch (err) {
          const msg =
            (err as Error)?.name === 'AbortError'
              ? '(stopped)'
              : `Error: ${(err as Error)?.message ?? 'unknown'}`;
          updateLastPending(state.messages, msg, false);
          renderBody();
        } finally {
          state.streaming = false;
          state.abort = null;
        }
      },
    };

    return instance;
  },
};

/* ---------------------------- helpers ---------------------------- */

function renderBubble(m: ChatMessage): HTMLElement {
  const isUser = m.role === 'user';
  const el = document.createElement('div');
  Object.assign(el.style, {
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    maxWidth: '85%',
    background: isUser
      ? 'var(--repull-agent-bubble-user)'
      : 'var(--repull-agent-bubble-assistant)',
    color: 'var(--repull-agent-fg)',
    padding: '8px 11px',
    borderRadius: '12px',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: '1.45',
  } as CSSStyleDeclarationLike);
  el.textContent = m.content || (m.pending ? '...' : '');
  return el;
}

function updateLastPending(arr: ChatMessage[], text: string, stillPending: boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item && item.role === 'assistant') {
      item.content = text;
      item.pending = stillPending;
      return;
    }
  }
}

function positionStyle(p: AgentPosition): Record<string, string> {
  switch (p) {
    case 'bottom-left':
      return { bottom: '24px', left: '24px' };
    case 'top-right':
      return { top: '24px', right: '24px' };
    case 'top-left':
      return { top: '24px', left: '24px' };
    case 'bottom-right':
    default:
      return { bottom: '24px', right: '24px' };
  }
}

function resolveTheme(theme: AgentTheme): 'light' | 'dark' {
  if (theme !== 'auto') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

const iconBtnStyle: Record<string, string> = {
  background: 'transparent',
  border: 'none',
  color: 'var(--repull-agent-muted)',
  fontSize: '18px',
  cursor: 'pointer',
  padding: '4px',
  lineHeight: '1',
};

/* ---- Web Speech API typing (kept loose; lib.dom does not always include this) ---- */
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { resultIndex: number; results: SpeechRecognitionResultListLike }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [i: number]: { isFinal: boolean; length: number; [i: number]: { transcript: string } | undefined } | undefined;
}
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * `Object.assign` on `style` accepts a partial CSS-like dict — TS gets cranky
 * about the strict CSSStyleDeclaration shape, so we widen it locally.
 */
type CSSStyleDeclarationLike = Record<string, string>;
