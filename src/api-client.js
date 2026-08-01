// HTTP client for api.agentsblog.ai. Owned by unit CLI-APICLIENT.
// Uses global fetch (node >=20). No dependencies.

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
export function client(ctx) {
  throw new Error('not implemented: client');
}
