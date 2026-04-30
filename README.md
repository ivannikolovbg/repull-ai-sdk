# @repull/ai-sdk

Vercel AI SDK tool bindings for the [Repull](https://repull.dev) API.

Drop these tools into any `streamText` / `generateText` call (or any AI SDK Tool agent) and your model gets live, typed access to the Repull platform — properties, reservations, Airbnb listings, and the Connect-session flow that wires up new providers.

```ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { RepullClient, repullTools } from '@repull/ai-sdk';

const client = new RepullClient({ apiKey: process.env.REPULL_API_KEY! });

const result = streamText({
  model: openai('gpt-4o'),
  tools: repullTools(client),
  prompt: 'List my last 10 reservations',
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

That's it. Same pattern works for `@ai-sdk/anthropic`, `@ai-sdk/google`, or any other AI SDK provider — the tools are model-agnostic.

## Install

```bash
npm install @repull/ai-sdk ai zod
# plus a model provider, e.g.
npm install @ai-sdk/openai
```

`ai` and `zod` are peer dependencies — bring your own version (AI SDK 4.x / 5.x / 6.x are all supported).

## Auth

Get an API key at <https://repull.dev/dashboard> and pass it to the client:

```ts
const client = new RepullClient({
  apiKey: process.env.REPULL_API_KEY!,
  baseUrl: 'https://api.repull.dev', // default
  timeoutMs: 30_000,                  // default
});
```

The key is sent as `Authorization: Bearer …` on every request. Don't ship the key to the browser — call the AI SDK from a Next.js Route Handler / Server Action / Edge function.

## Tools

`repullTools(client)` returns six tools, ready to drop into the AI SDK:

| Tool | API endpoint | Mutates? | What it does |
|---|---|---|---|
| `listReservations` | `GET /v1/reservations` | no | List reservations across all channels, with filters for platform, status, and check-in date range. |
| `getReservation` | `GET /v1/reservations/{id}` | no | Fetch a single reservation by Repull ID. |
| `listAirbnbListings` | `GET /v1/channels/airbnb/listings` | no | List Airbnb listings on the connected account. |
| `listProperties` | `GET /v1/properties` | no | List properties under management across all connected providers. |
| `healthCheck` | `GET /v1/health` | no | Verify the API is reachable and the key works. |
| `createConnectSession` | `POST /v1/connect/{provider}` | yes | Start a Repull Connect flow for a provider — returns OAuth URL (Airbnb) or activates a credential-based connection (PMS). The only mutating tool in this set. |

Inputs are validated with [Zod](https://zod.dev). Outputs follow `{ ok: true, data } | { ok: false, error }` so the model can recover from API errors instead of hard-aborting the stream.

## Run the example

A complete, runnable demo lives in [`examples/chat.ts`](./examples/chat.ts):

```bash
REPULL_API_KEY=sk_repull_... \
OPENAI_API_KEY=sk-... \
  npx tsx examples/chat.ts
```

## Use only some tools

The returned object is plain — destructure or `omit` freely:

```ts
const { listReservations, listProperties } = repullTools(client);

await streamText({
  model: openai('gpt-4o'),
  tools: { listReservations, listProperties }, // read-only subset
  prompt: '...',
});
```

## Mix with your own tools

```ts
import { tool } from 'ai';
import { z } from 'zod';

const tools = {
  ...repullTools(client),
  greet: tool({
    description: 'Say hello to a guest',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  }),
};
```

## Errors

Failed API calls don't throw out of `execute` — they return `{ ok: false, error: { status, message, body } }` so the model can apologize, retry, or escalate. If you want classic exception flow for non-tool callsites, the underlying `RepullApiError` is also exported:

```ts
import { RepullApiError } from '@repull/ai-sdk';
```

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, ship products on it. The Repull API itself is gated by your API key; this SDK is a thin, free wrapper.

## Links

- Repull platform & dashboard — <https://repull.dev>
- API reference — <https://api.repull.dev/openapi.json>
- Vercel AI SDK docs — <https://ai-sdk.dev>
- Issues & feature requests — <https://github.com/ivannikolovbg/repull-ai-sdk/issues>
