/**
 * @repull/ai-sdk — Vercel AI SDK tool bindings + embedded `<RepullAgent />`.
 *
 * ## Tools (server-side, model-agnostic)
 *
 * Drop these into any `streamText` / `generateText` / Tool agent call to give
 * the model live access to the Repull platform — listings, reservations,
 * channels, and Connect-session creation.
 *
 * @example
 * ```ts
 * import { streamText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { RepullClient, repullTools } from '@repull/ai-sdk';
 *
 * const client = new RepullClient({ apiKey: process.env.REPULL_API_KEY! });
 *
 * const result = await streamText({
 *   model: openai('gpt-4o'),
 *   tools: repullTools(client),
 *   prompt: 'List my last 10 reservations',
 * });
 *
 * for await (const chunk of result.textStream) process.stdout.write(chunk);
 * ```
 *
 * ## Embedded agent (`<RepullAgent />`)
 *
 * For studio-deployed customer apps:
 * - **Server route**: `import { createAgentHandler } from '@repull/ai-sdk/agent'`
 * - **React widget**: `import { RepullAgent } from '@repull/ai-sdk/react'`
 * - **Vanilla JS widget**: `import { RepullAgent } from '@repull/ai-sdk/headless'`
 *
 * The widget posts to `/api/agent/chat` and the customer's deployed app brokers
 * the call with the customer-scoped `REPULL_API_KEY`. The agent in customer A's
 * app can never see customer B's data.
 */

export { RepullClient, RepullApiError } from './client.js';
export type { RepullClientOptions } from './client.js';

export { repullTools } from './tools.js';
export type { RepullToolName, RepullToolResult } from './tools.js';

export { repullAgentTools, createAgentHandler } from './agent/handler.js';
export type {
  AgentChatMessage,
  AgentChatRequest,
  AgentHandlerOptions,
  AgentToolName,
  AgentToolResult,
  AgentToolSet,
} from './agent/index.js';
