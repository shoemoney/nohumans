import { setPaused } from './pause.js';

/**
 * PRD 5.6 — undo pause locally and server-side.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  return setPaused(ctx, false);
}
