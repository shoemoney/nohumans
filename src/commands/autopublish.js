import { updateConfig } from '../config.js';
import { describe, install, installed, probe, scrub, spec, uninstall } from '../schedule.js';
import { agentId } from './publish.js';
import { serverView } from './status.js';

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
    return fail('unknown_action', `Run \`nohumans autopublish <${ACTIONS.join('|')}>\`.`);
  }

  const s = spec(ctx);

  if (action === 'status') {
    const wanted = ctx.config.autopublish === true;
    // The config flag records what was asked for; only the plist/crontab says whether anything
    // will actually run. They disagree after a restored home directory or a hand-edited config,
    // and "enabled" over an empty crontab is the most expensive lie this command can tell.
    const onDisk = installed(s, scheduleOpts(ctx));
    ctx.out(
      ctx.json
        ? JSON.stringify({ enabled: wanted, installed: onDisk, hour: s.hour, minute: s.minute, argv: s.argv })
        : `autopublish: ${
            !wanted
              ? 'disabled'
              : onDisk
                ? 'enabled'
                : 'enabled in config, but no scheduled job is installed — nothing will run; rerun `nohumans autopublish enable`'
          }\n${describe(s)}`
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
  if (!agentId(ctx)) return fail('not_initialized', 'Run `nohumans init` first.');
  if (ctx.config.paused) return fail('agent_paused', 'Run `nohumans resume` before enabling autopublish.');
  if (!ctx.config.last_publish) {
    // A first publish that was held and then approved IS a manual publish, but nothing
    // promotes pending_publish on its own, so without this ask the gate never opens again.
    if (ctx.config.pending_publish?.post_id) await serverView(ctx);
    if (!ctx.config.last_publish) {
      return fail(
        'manual_publish_required',
        'Publish at least one post yourself with `nohumans publish`, then enable autopublish.'
      );
    }
  }
  if (s.warning) return fail('cli_not_pinned', `${s.warning}, then rerun \`nohumans autopublish enable\`.`);
  // A job with no distiller installs fine and then silently writes nothing, every day, forever.
  // A configured-but-unresolved executable is exactly that job: the id resolves, `which` does not.
  if (!s.adapter?.exe) {
    return fail(
      'no_adapter',
      s.adapter
        ? `The distiller \`${s.adapter.id}\` is configured but its executable was not found on PATH, so the scheduled job could never write a post — install its CLI (or pick another with \`nohumans config set adapter <id>\`), then rerun \`nohumans autopublish enable\`.`
        : 'No distiller is installed or configured — set one with `nohumans config set adapter <id>` (or install its CLI), then rerun `nohumans autopublish enable`.'
    );
  }
  // A shim in TMPDIR resolves today and is deleted by the OS before the job ever runs. Pinning
  // it installs a job that dies silently, so refuse here rather than guess which other
  // executable on PATH is the "real" one — the shim usually exists because it is the one that works.
  if (s.adapter.ephemeral) {
    return fail(
      'adapter_not_stable',
      `The distiller \`${s.adapter.id}\` resolves to ${s.adapter.exe}, inside this shell's temporary directory — the OS deletes it, and the scheduled job would then fail every day with no distiller. Run \`nohumans autopublish enable\` from a plain terminal (not a cmux/agent shell), where \`which ${s.adapter.bin}\` points at the installed CLI.`
    );
  }
  // A name the owner declared but this shell does not export is dropped without a word, and
  // `describe` renders only the vars that were carried — so the omission is invisible by
  // omission. It is also the likeliest outcome of the message above: the AIGATE_*/gateway
  // variables that motivate `adapter_env` are exported by the agent harness, and a plain
  // terminal usually has none of them.
  const declared = Array.isArray(ctx.config.adapter_env) ? ctx.config.adapter_env : [];
  const missing = declared.filter((k) => !s.env[k]);
  if (missing.length) {
    return fail(
      'adapter_env_missing',
      `\`adapter_env\` names ${missing.join(', ')}, but this shell exports ${missing.length > 1 ? 'none of them' : 'it'} — the job would run without ${missing.length > 1 ? 'them' : 'it'} and fail every day. Export ${missing.length > 1 ? 'them' : 'it'} here (or drop ${missing.length > 1 ? 'them' : 'it'} with \`nohumans config set adapter_env <names>\`), then rerun \`nohumans autopublish enable\`.`
    );
  }

  // Everything above is a guess about why an unattended run might fail. This is the measurement:
  // run the pinned distiller with the job's own environment and see. It is the only check that
  // catches a credential the job does not carry, whatever the variable is called.
  const check = await probe(s, scheduleOpts(ctx));
  if (!check.ok) {
    return fail(
      'adapter_unusable',
      scrub(
        `\`${s.adapter.exe}\` failed when run with the environment the scheduled job would give it, so the job could never write a post. It said: ${check.detail || '(nothing)'}\n` +
          `The job carries only ${Object.keys(s.env).join(', ')}; if the distiller authenticates through a wrapper or gateway, name the variables it needs with \`nohumans config set adapter_env NAME,NAME\` (they are read from this shell and stored 0600), then rerun \`nohumans autopublish enable\`.`,
        s
      )
    );
  }

  let job;
  try {
    job = install(s, scheduleOpts(ctx));
  } catch (err) {
    // The scheduler's own error text can quote the job we just handed it, credentials included.
    return fail(
      'schedule_install_failed',
      scrub(`${err.message} — fix the scheduler, then rerun \`nohumans autopublish enable\`.`, s)
    );
  }

  updateConfig(
    { autopublish: true, autopublish_schedule: { hour: s.hour, minute: s.minute, kind: job.kind } },
    ctx.profile,
    ctx.env
  );
  ctx.out(
    ctx.json
      ? JSON.stringify({ enabled: true, hour: s.hour, minute: s.minute, ...job })
      : `autopublish enabled\n${describe(s)}`
  );
  return 0;
}
