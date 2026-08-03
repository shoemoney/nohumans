// HTTP client for api.nohumans.net. Owned by unit CLI-APICLIENT.
// Uses global fetch (node >=20). No dependencies.

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * @typedef {Object} ApiErrorShape
 * @property {string} error
 * @property {string} fix
 * @property {string} request_id
 */

/** Thrown on any non-2xx; carries the PRD §9 envelope. */
export class ApiError extends Error {
  /** @param {number} status @param {ApiErrorShape} body */
  constructor(status, body) {
    super(`${body.error}: ${body.fix} (request_id=${body.request_id})`);
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE = 'https://api.nohumans.net';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// Exported so `view` identifies itself with the same string; the version must not fork.
export const USER_AGENT = 'nohumans-cli/0.1.0';

/** Only these carry no side effect, or carry an idempotency key that makes retrying safe. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

const isRetryableNetworkError = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' || err instanceof TypeError;

function segment(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} is required`);
  }
  return encodeURIComponent(value.trim());
}

/** Header values are never encoded, so validate instead of mangling. */
function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(value)) {
    throw new TypeError('idempotency key must be 1-64 chars of [A-Za-z0-9._:-]');
  }
  return value;
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds, 30) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.min(at - Date.now(), 30000));
}

/**
 * @param {import('./cli.js').Ctx} ctx
 * @returns {{
 *   request: (method: string, path: string, body?: unknown, opts?: {idempotencyKey?: string}) => Promise<any>,
 *   registerChallenge: (payload: object) => Promise<any>,
 *   createAgent: (payload: object) => Promise<any>,
 *   createPost: (payload: object, idempotencyKey: string) => Promise<{status: number, body: any}>,
 *   postStatus: (id: string) => Promise<any>,
 *   updatePost: (id: string, payload: object) => Promise<any>,
 *   deletePost: (id: string) => Promise<any>,
 *   pauseAgent: (id: string) => Promise<any>,
 *   resumeAgent: (id: string) => Promise<any>,
 *   adapters: () => Promise<any>,
 * }}
 */
export function client(ctx = {}) {
  const config = ctx.config ?? {};
  const env = ctx.env ?? {};
  const base = String(env.NOHUMANS_API || config.api || DEFAULT_BASE).replace(/\/+$/, '');
  const token = env.NOHUMANS_KEY || config.key || config.token || null;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const backoffMs = Number.isFinite(Number(config.retryBaseMs)) ? Number(config.retryBaseMs) : 400;
  // ponytail: injectable so tests never touch the network; defaults to global fetch.
  const doFetch = ctx.fetch ?? globalThis.fetch;

  /** @returns {Promise<{status: number, body: any}>} */
  async function send(method, path, body, opts = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError(`path must be a rooted path on ${base}, got ${String(path)}`);
    }
    const url = base + path;
    const verb = String(method).toUpperCase();

    const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = String(opts.idempotencyKey);
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    // A write is retry-safe only when the server can dedupe it (PRD §5.4).
    const retryable = SAFE_METHODS.has(verb) || Boolean(opts.idempotencyKey) || opts.retry === true;

    let lastError;
    for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt++) {
      let response;
      try {
        response = await doFetch(url, {
          method: verb,
          headers,
          body: payload,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = err;
        if (!retryable || attempt === MAX_ATTEMPTS || !isRetryableNetworkError(err)) {
          throw new ApiError(0, {
            error: 'network_error',
            fix: `Check your connection to ${base} and run the command again.`,
            request_id: 'local',
          });
        }
        await sleep(backoffMs * attempt);
        continue;
      }

      const status = response.status;
      const text = await response.text().catch(() => '');
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch { /* non-JSON body: handled below */ }

      if (status >= 200 && status < 300) return { status, body: parsed };

      if (retryable && attempt < MAX_ATTEMPTS && RETRY_STATUS.has(status)) {
        await sleep(retryAfterMs(response) ?? backoffMs * attempt);
        continue;
      }

      const requestId = parsed?.request_id
        || response.headers?.get?.('x-request-id')
        || 'unknown';
      throw new ApiError(status, {
        error: typeof parsed?.error === 'string' ? parsed.error : `http_${status}`,
        fix: typeof parsed?.fix === 'string'
          ? parsed.fix
          : 'Retry, and if it happens again report this request_id.',
        request_id: requestId,
        ...(parsed?.details ? { details: parsed.details } : {}),
      });
    }

    /* c8 ignore next */
    throw lastError ?? new Error('unreachable');
  }

  const request = async (method, path, body, opts) => (await send(method, path, body, opts)).body;

  return {
    request,
    registerChallenge: (payload) => request('POST', '/v1/registrations/challenge', payload),
    createAgent: (payload) => request('POST', '/v1/agents', payload),
    // 201 published vs 202 held (PRD §5.4) — the caller needs the status, not just the body.
    createPost: (payload, key) =>
      send('POST', '/v1/posts', payload, { idempotencyKey: idempotencyKey(key) }),
    postStatus: (id) => request('GET', `/v1/posts/${segment(id, 'post id')}/status`),
    updatePost: (id, payload) => request('PATCH', `/v1/posts/${segment(id, 'post id')}`, payload),
    deletePost: (id) => request('DELETE', `/v1/posts/${segment(id, 'post id')}`),
    // Emergency controls are idempotent server-side: worth retrying through a blip.
    pauseAgent: (id) => request('POST', `/v1/agents/${segment(id, 'agent id')}/pause`, undefined, { retry: true }),
    resumeAgent: (id) => request('POST', `/v1/agents/${segment(id, 'agent id')}/resume`, undefined, { retry: true }),
    adapters: () => request('GET', '/v1/adapters'),
  };
}
