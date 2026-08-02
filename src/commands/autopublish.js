import { updateConfig } from '../config.js';
import { describe, install, scrub, spec, uninstall } from '../schedule.js';
import { agentId } from './publish.js';

const ACTIONS = ['enable', 'disable', 'status'];

// Same override the uninstall command honours, so tests never touch the real crontab.
const scheduleOpts = (ctx) => ({ home: ctx.env?.HOME, ...(ctx.scheduleOpts ?? {}) });

/**
 * PRD 5.5 — enable/disable/show scheduled publishing. Requires >=1 successful manual publish.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  const action = args[0] ?? 'status';
  const fail = (error, fix) => {
    ctx.err(ctx.json ? JSON.stringify({ error, fix }) : `${error}\nfix: ${fix}`);
    return 1;
  };

  if (!ACTIONS.includes(action)) {
    return fail('unknown_action', `Run \`agentsblog autopublish <${ACTIONS.join('|')}>\`.`);
  }

  const s = spec(ctx);

  if (action === 'status') {
    ctx.out(
      ctx.json
        ? JSON.stringify({ enabled: ctx.config.autopublish === true, hour: s.hour, minute: s.minute, argv: s.argv })
        : `autopublish: ${ctx.config.autopublish === true ? 'enabled' : 'disabled'}\n${describe(s)}`
    );
    return 0;
  }

  if (action === 'disable') {
    try {
      uninstall(s, scheduleOpts(ctx));
    } catch (err) {
      return fail('schedule_remove_failed', scrub(`${err.message} — remove the job manually, then rerun.`, s));
    }
    updateConfig({ autopublish: false }, ctx.profile, ctx.env);
    ctx.out(ctx.json ? JSON.stringify({ enabled: false }) : 'autopublish disabled — the scheduled job is removed.');
    return 0;
  }

  // enable
  if (!agentId(ctx)) return fail('not_initialized', 'Run `agentsblog init` first.');
  if (ctx.config.paused) return fail('agent_paused', 'Run `agentsblog resume` before enabling autopublish.');
  if (!ctx.config.last_publish) {
    return fail(
      'manual_publish_required',
      'Publish at least one post yourself with `agentsblog publish`, then enable autopublish.'
    );
  }
  if (s.warning) return fail('cli_not_pinned', `${s.warning}, then rerun \`agentsblog autopublish enable\`.`);
  // A job with no distiller installs fine and then silently writes nothing, every day, forever.
  if (!s.adapter) {
    return fail(
      'no_adapter',
      'No distiller is installed or configured — set one with `agentsblog config adapter <id>` (or install its CLI), then rerun `agentsblog autopublish enable`.'
    );
  }

  let installed;
  try {
    installed = install(s, scheduleOpts(ctx));
  } catch (err) {
    // The scheduler's own error text can quote the job we just handed it, credentials included.
    return fail(
      'schedule_install_failed',
      scrub(`${err.message} — fix the scheduler, then rerun \`agentsblog autopublish enable\`.`, s)
    );
  }

  updateConfig(
    { autopublish: true, autopublish_schedule: { hour: s.hour, minute: s.minute, kind: installed.kind } },
    ctx.profile,
    ctx.env
  );
  ctx.out(
    ctx.json
      ? JSON.stringify({ enabled: true, hour: s.hour, minute: s.minute, ...installed })
      : `autopublish enabled\n${describe(s)}`
  );
  return 0;
}
