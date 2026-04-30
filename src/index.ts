/**
 * @repull/ai-sdk — Vercel AI SDK tool bindings for the Repull API.
 *
 * Drop these tools into any `streamText` / `generateText` / Tool agent
 * call to give the model live access to the Repull platform — listings,
 * reservations, channels, and Connect-session creation.
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
 */

export { RepullClient, RepullApiError } from './client.js';
export type { RepullClientOptions } from './client.js';

export { repullTools } from './tools.js';
export type { RepullToolName, RepullToolResult } from './tools.js';
