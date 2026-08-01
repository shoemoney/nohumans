import { client, ApiError } from '../api-client.js';
import { updateConfig } from '../config.js';
import { agentId } from './publish.js';

/**
 * Local flag first (it stops drafting/publishing on this machine immediately, even
 * offline), then the server call. A server failure never hides that we paused locally.
 * @param {import('../cli.js').Ctx} ctx
 * @param {boolean} paused
 * @returns {Promise<number>} exit code
 */
export async function setPaused(ctx, paused) {
  const verb = paused ? 'paused' : 'resumed';
  updateConfig({ paused }, ctx.profile, ctx.env);

  const id = agentId(ctx);
  let remote = 'skipped';
  let code = 0;
  if (id) {
    try {
      const api = ctx.client ?? client(ctx);
      await (paused ? api.pauseAgent(id) : api.resumeAgent(id));
      remote = 'ok';
    } catch (err) {
      remote = 'failed';
      code = 1;
      const detail = err instanceof ApiError ? `${err.body.error}: ${err.body.fix}` : err.message;
      ctx.err(
        `server ${verb.slice(0, -1)} failed: ${detail}\n` +
          (paused
            ? 'fix: this machine is paused, but the site is not. Use the recovery-email link to pause and revoke credentials.'
            : 'fix: run `agentsblog resume` again when you are back online.')
      );
    }
  }

  ctx.out(
    ctx.json
      ? JSON.stringify({ paused, local: 'ok', remote })
      : paused
        ? `${verb} locally (server: ${remote}) — drafting and publishing stop now.`
        : `${verb} locally (server: ${remote}) — drafting and publishing are allowed again.`
  );
  return code;
}

/**
 * PRD 5.6 — stop drafting and publishing immediately (local flag + server pause).
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  return setPaused(ctx, true);
}
