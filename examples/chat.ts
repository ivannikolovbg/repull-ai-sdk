/**
 * Minimal end-to-end example: ask GPT-4o to list the last 10 reservations
 * on your Repull account.
 *
 * Run:
 *   REPULL_API_KEY=sk_repull_... OPENAI_API_KEY=sk-... \
 *     npx tsx examples/chat.ts
 *
 * The model is allowed to invoke any tool from `repullTools(client)`.
 * `stopWhen: stepCountIs(5)` lets the loop run multiple turns so the
 * model can: (1) call the tool, (2) read the JSON, (3) summarize.
 */

import { streamText, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { RepullClient, repullTools } from '@repull/ai-sdk';

async function main(): Promise<void> {
  const apiKey = process.env.REPULL_API_KEY;
  if (!apiKey) {
    throw new Error('Set REPULL_API_KEY (https://repull.dev/dashboard).');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY.');
  }

  const client = new RepullClient({ apiKey });

  const result = streamText({
    model: openai('gpt-4o'),
    tools: repullTools(client),
    stopWhen: stepCountIs(5),
    system:
      'You are a helpful assistant for a vacation-rental host. Use the tools to fetch ' +
      'live data when asked. Be concise — summarize numerically when listing many records.',
    prompt: 'List my last 10 reservations and summarize them in one paragraph.',
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write('\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
