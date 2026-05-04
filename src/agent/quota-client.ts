/**
 * Quota preflight + usage logging client for the embedded `<RepullAgent />`
 * SDK handler.
 *
 * Talks to two endpoints on the customer-scoped Repull API:
 *
 *   GET  /v1/agent/quota   → snapshot of today's calls/tokens caps
 *   POST /v1/agent/usage   → idempotent record of one LLM round-trip
 *
 * Design rules:
 *
 * - **Fail-OPEN on infra hiccups.** A network error or 5xx response from
 *   either endpoint MUST NOT block the customer's chat request. Better
 *   to bill us a few free calls than break a deployed customer app
 *   over a transient infra problem.
 * - **Hard caps still enforce.** A 200 response with `remaining = 0`
 *   (or 429 from the quota endpoint) is a real cap-hit and the handler
 *   surfaces a `AGENT_QUOTA_EXCEEDED` envelope.
 * - **1s timeout per call.** Quota is a hot path on every chat turn —
 *   we cannot let a slow Atlas DB stall every customer's bot.
 * - **One transient retry on 5xx / network.** The endpoint is on the
 *   same VPC as the SDK runtime in production but Vercel cold-starts
 *   and Atlas pgbouncer recycles still happen. One retry, then
 *   fail-open.
 *
 * The handler in `handler.ts` consumes this module via two narrow
 * function exports, so the surface for the surgical wiring stays small.
 */

/**
 * Snapshot returned by `GET /v1/agent/quota`. Mirrors the dominator
 * route shape exactly so we never silently drift.
 */
export interface QuotaSnapshot {
  tier: 'free' | 'starter' | 'pro' | string;
  calls: { used: number; limit: number; remaining: number };
  tokens: { used: number; limit: number; remaining: number };
  resetAt: string;
}

/**
 * Outcome of the preflight probe. The handler branches on `kind`:
 *
 * - `allowed`  — call may proceed, snapshot included for headers.
 * - `blocked`  — hard cap-hit, return 429 with the snapshot.
 * - `failOpen` — infra error talking to Repull; let the call through
 *   and log a warning. The snapshot is `null` because we don't know.
 */
export type QuotaPreflightResult =
  | { kind: 'allowed'; snapshot: QuotaSnapshot }
  | { kind: 'blocked'; snapshot: QuotaSnapshot | null; retryAfterSec?: number }
  | { kind: 'failOpen'; reason: string };

/**
 * Body shape POSTed to `/v1/agent/usage`. Snake_case to match the
 * Repull API contract; the wrapper in `handler.ts` builds this from
 * the camelCase result of the model run.
 */
export interface UsageRecordInput {
  request_id: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  latency_ms?: number;
  fallback?: boolean;
  /**
   * Optional Studio project id. When set, the usage row is attributed
   * to a specific project so the dashboard's per-project rollup
   * (USAGE-DASHBOARD top-projects + PROJECT-ANALYTICS agent_calls
   * metric) can count it. Off-Studio SDK installs leave this unset.
   */
  project_id?: number;
}

/**
 * Caller-supplied options for both helpers. We accept a custom `fetch`
 * so tests can mock without monkey-patching `globalThis.fetch`, and an
 * `onWarn` so the handler can surface fail-open events to its own
 * logger of choice (default: `console.warn`).
 */
export interface QuotaClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Per-call timeout, default 1000ms. Lower bound is 100ms (sanity). */
  timeoutMs?: number;
  /** Logger hook. Default: `console.warn`. Pass `() => {}` to silence. */
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Sentinel string we surface in `failOpen.reason` so tests can match. */
export const QUOTA_FAIL_OPEN_NETWORK = 'quota_endpoint_unreachable';
export const QUOTA_FAIL_OPEN_5XX = 'quota_endpoint_5xx';
export const USAGE_FAIL_OPEN_NETWORK = 'usage_endpoint_unreachable';
export const USAGE_FAIL_OPEN_5XX = 'usage_endpoint_5xx';

const DEFAULT_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 100;

/**
 * Run a single fetch with an `AbortController`-driven timeout. Returns
 * `null` on network error / abort so callers can branch without try/
 * catch noise at every site.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(MIN_TIMEOUT_MS, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Preflight: ask Repull whether this customer can issue another agent
 * turn right now. See {@link QuotaPreflightResult} for the contract.
 *
 * Retry policy: one retry on network failure / 5xx. Beyond that we
 * fail-OPEN — the customer's bot must keep working even if our
 * quota service is having a bad day.
 *
 * Hard cap signaling:
 *   - HTTP 429 from the endpoint → `blocked` (with `Retry-After`).
 *   - HTTP 200 + `remaining.calls <= 0` (or tokens) → `blocked`.
 *   - HTTP 200 + remaining > 0 → `allowed`.
 */
export async function preflightQuota(opts: QuotaClientOptions): Promise<QuotaPreflightResult> {
  const fetchImpl = opts.fetch ?? fetch;
  const onWarn = opts.onWarn ?? defaultWarn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = joinUrl(opts.baseUrl, '/v1/agent/quota');
  const init: RequestInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
      'User-Agent': '@repull/ai-sdk',
    },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
    if (res === null) {
      // Network error / timeout. Retry once, then fail-open.
      if (attempt === 0) continue;
      onWarn('[repull-agent] quota preflight network error — failing open', { url });
      return { kind: 'failOpen', reason: QUOTA_FAIL_OPEN_NETWORK };
    }

    if (res.status === 429) {
      const snapshot = await safeReadSnapshot(res);
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      return { kind: 'blocked', snapshot, retryAfterSec: retryAfter };
    }

    if (res.status >= 500) {
      // Server error. Retry once, then fail-open.
      if (attempt === 0) continue;
      onWarn('[repull-agent] quota preflight 5xx — failing open', { url, status: res.status });
      return { kind: 'failOpen', reason: QUOTA_FAIL_OPEN_5XX };
    }

    if (res.status >= 200 && res.status < 300) {
      const snapshot = await safeReadSnapshot(res);
      if (!snapshot) {
        // Malformed body — treat as fail-open rather than guess at limits.
        onWarn('[repull-agent] quota preflight body malformed — failing open', { url });
        return { kind: 'failOpen', reason: QUOTA_FAIL_OPEN_5XX };
      }
      const callsLeft = snapshot.calls?.remaining ?? 0;
      const tokensLeft = snapshot.tokens?.remaining ?? 0;
      if (callsLeft <= 0 || tokensLeft <= 0) {
        return { kind: 'blocked', snapshot };
      }
      return { kind: 'allowed', snapshot };
    }

    // Any other 4xx (auth issues, etc.) — block. We do NOT retry 4xx
    // because retrying a 401 with the same key is just noise.
    onWarn('[repull-agent] quota preflight non-success status', { url, status: res.status });
    return { kind: 'failOpen', reason: `quota_endpoint_status_${res.status}` };
  }

  // Unreachable — the loop always returns. Belt-and-suspenders.
  return { kind: 'failOpen', reason: QUOTA_FAIL_OPEN_NETWORK };
}

/**
 * Best-effort POST to `/v1/agent/usage`. Idempotent on `request_id`
 * server-side, so retries are safe. Always resolves — never throws —
 * because a usage-record failure must NEVER affect the customer's
 * already-streamed response.
 */
export async function recordUsage(
  input: UsageRecordInput,
  opts: QuotaClientOptions,
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const onWarn = opts.onWarn ?? defaultWarn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = joinUrl(opts.baseUrl, '/v1/agent/usage');
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': '@repull/ai-sdk',
    },
    body: JSON.stringify(input),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
    if (res === null) {
      if (attempt === 0) continue;
      onWarn('[repull-agent] usage record network error — accepting silent loss', {
        url,
        request_id: input.request_id,
      });
      return;
    }

    if (res.status >= 200 && res.status < 300) {
      // Drain the body to free the socket but ignore content; the
      // SDK has no use for the post-record snapshot today.
      try {
        await res.text();
      } catch {
        // Ignored — the write succeeded server-side.
      }
      return;
    }

    if (res.status >= 500) {
      if (attempt === 0) continue;
      onWarn('[repull-agent] usage record 5xx — accepting silent loss', {
        url,
        status: res.status,
        request_id: input.request_id,
      });
      return;
    }

    // 4xx (validation, auth) — log once, do not retry. The customer's
    // chat already streamed, so we can't surface this anyway.
    onWarn('[repull-agent] usage record non-success status', {
      url,
      status: res.status,
      request_id: input.request_id,
    });
    return;
  }
}

/**
 * Generate a request id used as the idempotency key on the usage
 * endpoint. We don't depend on `crypto.randomUUID` directly because
 * older Node versions (<19) didn't expose it on `globalThis.crypto`
 * by default. We feature-detect; otherwise we synthesize a 32-char
 * random hex from `Math.random` — collision-acceptable since the
 * server treats duplicates as idempotent replays anyway.
 */
export function newRequestId(): string {
  const c: { randomUUID?: () => string } | undefined =
    (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return `req_${out}`;
}

async function safeReadSnapshot(res: Response): Promise<QuotaSnapshot | null> {
  try {
    const raw = (await res.json()) as { data?: QuotaSnapshot } | QuotaSnapshot;
    if (!raw || typeof raw !== 'object') return null;
    // Dominator wraps real responses in `{ data: ... }`; tests / older
    // servers may return the snapshot at the root. Accept both shapes.
    const candidate = (raw as { data?: QuotaSnapshot }).data ?? (raw as QuotaSnapshot);
    if (
      candidate &&
      typeof candidate === 'object' &&
      'calls' in candidate &&
      'tokens' in candidate
    ) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  // RFC 7231 also allows HTTP-date format, but the dominator route
  // emits seconds. Skip the date parser to keep the surface small.
  return undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function defaultWarn(message: string, meta?: Record<string, unknown>): void {
  if (meta) console.warn(message, meta);
  else console.warn(message);
}
