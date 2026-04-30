import createClient from 'openapi-fetch';

/**
 * Options for constructing a {@link RepullClient}.
 */
export interface RepullClientOptions {
  /** Repull API key (https://repull.dev/dashboard). */
  apiKey: string;
  /** Override the API base URL. Defaults to `https://api.repull.dev`. */
  baseUrl?: string;
  /**
   * Custom fetch implementation. Defaults to the global `fetch`.
   * Useful for retries, logging, or running under non-standard runtimes.
   */
  fetch?: typeof fetch;
  /** Optional extra headers merged onto every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

/**
 * Thin typed client over `api.repull.dev`. Used by {@link repullTools} and
 * exposed so callers can swap in custom fetch / base URL / headers.
 *
 * The client itself is intentionally unopinionated — it does NOT add retries,
 * caching, or rate-limit handling. Wrap it externally (e.g. in `executeWithBackoff`)
 * if you need those behaviors.
 */
export class RepullClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly customFetch?: typeof fetch;

  /**
   * `openapi-fetch` typed-ish client. We don't ship the generated types in
   * this thin package, so we accept `any` here and rely on Zod schemas at
   * the tool boundary for validation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: ReturnType<typeof createClient<any>>;

  constructor(opts: RepullClientOptions) {
    if (!opts?.apiKey) {
      throw new Error('RepullClient: `apiKey` is required.');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.repull.dev').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.extraHeaders = opts.headers ?? {};
    this.customFetch = opts.fetch;

    this.raw = createClient({
      baseUrl: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': '@repull/ai-sdk',
        ...this.extraHeaders,
      },
      fetch: this.customFetch,
    });
  }

  /**
   * Generic request helper used by tool `execute` functions. Returns
   * the parsed JSON body on success, throws a {@link RepullApiError}
   * on non-2xx responses.
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init?: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (init?.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    if (init?.signal) {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      const fetchImpl = this.customFetch ?? fetch;
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': '@repull/ai-sdk',
          ...this.extraHeaders,
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      throw new RepullApiError(response.status, parsed, `${method} ${path} failed: ${response.status}`);
    }

    return parsed as T;
  }
}

/**
 * Error thrown by {@link RepullClient.request} on non-2xx responses.
 * Tool `execute` functions catch this and surface a structured error
 * shape to the model, so it can recover (or apologize) gracefully.
 */
export class RepullApiError extends Error {
  override readonly name = 'RepullApiError';
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}
