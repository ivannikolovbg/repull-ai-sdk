# Changelog

## 0.2.1 — 2026-05-04

### Added

- **Quota preflight + usage logging in `createAgentHandler`.** Wires the
  `AGENT-LIMITS` contract shipped in dominator PR #87 (`b4b83e3`):
  - **Before** the model call, the handler GETs `/v1/agent/quota`. A
    hard cap-hit (HTTP 429, or HTTP 200 with `remaining <= 0`) returns
    a `429` response with the `AGENT_QUOTA_EXCEEDED` envelope —
    `{ error: { code, message, fix, docs_url, resetAt } }` and a
    `Retry-After` header.
  - **After** the model call, the handler POSTs `/v1/agent/usage` with
    `{ request_id, tokens_in, tokens_out, model, latency_ms, fallback }`.
    Idempotent on `request_id` server-side, so the SDK retry on
    transient 5xx is safe.
- **`src/agent/quota-client.ts`** — narrow client encapsulating the
  fetch logic. 1s per-call timeout, one transient retry on
  network/5xx, then **fail-OPEN**: a quota-endpoint outage MUST NOT
  break the customer's app. Hard caps still enforce.

### Changed

- `createAgentHandler` accepts a new optional `quotaFetch` for tests
  and custom runtimes. Defaults to the global `fetch`.
- Customer-facing error copy in `502` responses no longer references
  internal model names. Uses "Repull AI" instead.

### Fixed

- The post-stream usage record awaits `result.totalUsage` so token
  counts are final before the POST. A no-op `.catch()` is attached to
  the eagerly-captured `totalUsage` Promise so a model outage doesn't
  surface as a Node unhandled rejection.

## 0.2.0 — 2026-05-04

- Embedded `<RepullAgent />` chat widget + `createAgentHandler()`.

## 0.1.0

- Initial `@repull/ai-sdk` — Vercel AI SDK tool bindings for Repull.
