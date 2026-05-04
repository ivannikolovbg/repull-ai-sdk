import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { RepullClient } from '../client.js';
import { repullAgentTools, type AgentToolSet } from './tools.js';

/**
 * Minimal chat message shape accepted by {@link createAgentHandler}. The
 * handler accepts the canonical OpenAI-style `{ role, content }` messages
 * so any front-end can drive it (the bundled `<RepullAgent />` component
 * sends exactly this shape).
 */
export interface AgentChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Request body POSTed to the customer-side `/api/agent/chat` endpoint.
 */
export interface AgentChatRequest {
  messages: AgentChatMessage[];
  /**
   * Optional per-call override of the system prompt. Useful for studio
   * templates that want to inject brand voice / customer tone.
   */
  systemPrompt?: string;
}

export interface AgentHandlerOptions {
  /**
   * Customer-scoped Repull API key. Studio runtimes inject this at deploy
   * time as `REPULL_API_KEY`. Each customer's deployed app gets its OWN
   * key — the agent in customer A's app can never see customer B's data
   * because the key is the auth boundary, enforced server-side by the
   * Repull API.
   */
  apiKey: string;
  /** Override the Repull API base URL. */
  baseUrl?: string;
  /**
   * Primary model. Defaults to Kimi K2 via the Vercel AI Gateway slug
   * `'moonshotai/kimi-k2'`. Pass any AI SDK `LanguageModel` to override
   * (e.g. `openai('gpt-4o')`, `anthropic('claude-sonnet-4-5')`).
   */
  model?: LanguageModel;
  /**
   * Fallback model used if `model` rejects the call (rate-limit, model
   * outage, etc.). Defaults to Claude Sonnet 4.5 via the gateway slug
   * `'anthropic/claude-sonnet-4-5'`. Set `null` to disable the fallback.
   */
  fallbackModel?: LanguageModel | null;
  /**
   * System prompt for the agent. The default is tuned for property
   * managers and instructs the model to use the bundled tools rather
   * than guessing. Override per-deployment for brand voice.
   */
  systemPrompt?: string;
  /**
   * Max tool-call loop iterations per chat turn. Defaults to 8 — enough
   * for "ask → tool → reflect → tool → answer" without runaway loops.
   */
  maxSteps?: number;
  /**
   * Override the tool set. Defaults to {@link repullAgentTools}. Pass a
   * subset to restrict scope (e.g. read-only deployments).
   */
  tools?: ToolSet;
}

const DEFAULT_SYSTEM_PROMPT = `You are Repull Agent — an embedded AI assistant for the property manager who installed this app.

You have access to live data tools that read THIS workspace's reservations, listings, pricing, revenue, occupancy, guest CRM, and cleaning rota. Use them. NEVER guess numbers, dates, or guest details — call the tool.

When a tool returns \`{ ok: false, error }\`, surface the error briefly and suggest a next step (re-auth, contact support, narrow the date range). Do NOT invent fallback data.

Be concise. Lead with the answer, then 1-2 bullets of context. Format dates as \`YYYY-MM-DD\`. Use the workspace's local currency when the data carries one — do NOT convert.`;

/**
 * String-form gateway model slug. The AI SDK exports a `gateway` provider
 * but pulling it here would force every consumer to install the gateway
 * package even if they pass their own model. Instead we accept a string
 * (which the AI SDK resolves through the registered gateway / provider
 * registry) OR a fully constructed `LanguageModel`.
 *
 * The string form keeps the bundle slim and matches how the AI SDK is
 * meant to be used in v6+ ("model: 'moonshotai/kimi-k2'" is valid).
 */
const DEFAULT_PRIMARY_MODEL = 'moonshotai/kimi-k2' as unknown as LanguageModel;
const DEFAULT_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-5' as unknown as LanguageModel;

/**
 * Build a stateless server-side handler that powers `/api/agent/chat` on
 * a Studio-deployed customer app.
 *
 * Pattern:
 * ```ts
 * // app/api/agent/chat/route.ts
 * import { createAgentHandler } from '@repull/ai-sdk/agent';
 * export const POST = createAgentHandler({ apiKey: process.env.REPULL_API_KEY! });
 * ```
 *
 * Every studio template auto-includes this route. The agent runs with the
 * customer's API key — the Repull API enforces scoping, so the agent in
 * customer A's app cannot read customer B's data.
 */
export function createAgentHandler(opts: AgentHandlerOptions): (req: Request) => Promise<Response> {
  if (!opts?.apiKey) {
    throw new Error('createAgentHandler: `apiKey` is required (set REPULL_API_KEY).');
  }
  const client = new RepullClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const tools: ToolSet = opts.tools ?? (repullAgentTools(client) as unknown as ToolSet);
  const primaryModel = opts.model ?? DEFAULT_PRIMARY_MODEL;
  const fallbackModel = opts.fallbackModel === null ? null : (opts.fallbackModel ?? DEFAULT_FALLBACK_MODEL);
  const maxSteps = opts.maxSteps ?? 8;
  const baseSystem = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return async function handler(req: Request): Promise<Response> {
    let body: AgentChatRequest;
    try {
      body = (await req.json()) as AgentChatRequest;
    } catch {
      return jsonError(400, 'Invalid JSON body');
    }
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return jsonError(400, '`messages` must be a non-empty array.');
    }

    const messages: ModelMessage[] = body.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })) as ModelMessage[];

    const system = body.systemPrompt
      ? `${baseSystem}\n\n---\n\n${body.systemPrompt}`
      : baseSystem;

    /**
     * Probe the model by reading the first chunk of `textStream`. If it
     * errors before yielding anything we know the model is dead and can
     * fall back; if it yields, we re-stream the buffered chunk + the rest
     * to the client. Avoids "primary failed mid-response, can't fall back"
     * because by then the stream is already partly consumed.
     *
     * The AI SDK's `streamText` swallows errors into `onError` by default
     * (just logs them and ends the stream), so we must capture errors
     * explicitly via the callback.
     */
    const tryStream = async (
      model: LanguageModel,
    ): Promise<
      | { ok: true; chunks: string[]; iter: AsyncIterator<string>; errBox: { err: unknown } }
      | { ok: false; err: unknown }
    > => {
      const errBox: { err: unknown } = { err: null };
      const result = streamText({
        model,
        tools,
        messages,
        system,
        stopWhen: stepCountIs(maxSteps),
        onError: ({ error }) => {
          errBox.err = error;
        },
      });
      try {
        const iter = result.textStream[Symbol.asyncIterator]();
        const next = await iter.next();
        if (errBox.err) return { ok: false, err: errBox.err };
        if (next.done) {
          // Stream ended without yielding — could mean tool-only run or empty.
          // Treat as success; the consumer iterator will handle re-checking errBox.
          return { ok: true, chunks: [], iter, errBox };
        }
        return { ok: true, chunks: [next.value], iter, errBox };
      } catch (err) {
        return { ok: false, err };
      }
    };

    const primary = await tryStream(primaryModel);
    if (primary.ok) {
      return wrappedStreamResponse(primary.chunks, primary.iter, primary.errBox);
    }
    if (!fallbackModel) {
      return jsonError(502, primary.err instanceof Error ? primary.err.message : 'Primary model failed.');
    }
    const fb = await tryStream(fallbackModel);
    if (fb.ok) {
      return wrappedStreamResponse(fb.chunks, fb.iter, fb.errBox, { 'x-repull-agent-fallback': '1' });
    }
    return jsonError(502, fb.err instanceof Error ? fb.err.message : 'Both models failed.');
  };
}

/**
 * Stream a buffered head + remaining iterator to the client as plain text.
 * We can't use `result.toTextStreamResponse()` directly because we already
 * consumed the first chunk during the probe-for-fallback step.
 */
function wrappedStreamResponse(
  buffered: string[],
  iter: AsyncIterator<string>,
  errBox: { err: unknown },
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const c of buffered) controller.enqueue(encoder.encode(c));
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const n = await iter.next();
          if (n.done) break;
          controller.enqueue(encoder.encode(n.value));
        }
        if (errBox.err) {
          controller.error(errBox.err);
          return;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...extraHeaders,
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export { repullAgentTools } from './tools.js';
export type { AgentToolName, AgentToolResult, AgentToolSet } from './tools.js';
