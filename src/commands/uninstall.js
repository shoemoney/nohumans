/**
 * PRD 5.6 — remove only the integrations agentsblog created. The local archive (journal,
 * drafts, denylist, config) survives unless the owner explicitly passes --purge.
 */

import { existsSync, rmSync } from 'node:fs';
import { sep } from 'node:path';
import { readConfig, updateConfig } from '../config.js';
import * as integrations from '../integrations.js';
import * as schedule from '../schedule.js';
import { createPrompt } from '../prompt.js';
import { journalDir, profileDir } from '../paths.js';

export async function run(args, ctx) {
  const env = ctx.env ?? process.env;
  const purge = ctx.flags?.purge === true || args.includes('--purge');
  const dir = profileDir(ctx.profile, env);
  const config = readConfig(ctx.profile, env);
  // The legacy ~/.agentsblog/journal archive lives outside the profile dir (paths.js),
  // so --purge must delete it too rather than claim a deletion it did not do.
  const legacy = journalDir(ctx.profile, env);
  const targets = [dir, ...(legacy.startsWith(dir + sep) ? [] : [legacy])].filter((p) => existsSync(p));
  const summary = { profile: ctx.profile, removed: [], archive: dir, purged: false, purged_paths: [] };

  // The scheduled job is the one integration that keeps publishing on its own; removing
  // the hook while leaving cron/launchd in place would keep posting after uninstall.
  const results = [...integrations.remove({ env, cwd: ctx.cwd }), removeSchedule(ctx, config, env)];
  if (config.autopublish === true) updateConfig({ autopublish: false }, ctx.profile, env);
  summary.removed = results;
  if (!ctx.json) {
    for (const r of results) {
      ctx.out(`${r.target}: ${r.status}${r.reason ? ` (${r.reason})` : ''} — ${r.path}`);
    }
  }

  if (purge && targets.length) {
    if (!ctx.yes) {
      const prompt = ctx.prompt ?? (process.stdin.isTTY ? createPrompt() : null);
      if (!prompt) {
        ctx.err(`refusing to delete ${targets.join(' and ')} without confirmation\nfix: rerun with --purge --yes`);
        return 1;
      }
      let ok = false;
      try {
        ok = await prompt.confirm(`Permanently delete the local archive at ${targets.join(' and ')}?`, false);
      } finally {
        if (!ctx.prompt) prompt.close();
      }
      if (!ok) {
        ctx.out(`kept ${targets.join(' and ')}`);
        return finish(ctx, summary, config, dir);
      }
    }
    for (const target of targets) {
      rmSync(target, { recursive: true, force: true });
      summary.purged_paths.push(target);
      if (!ctx.json) ctx.out(`deleted ${target}`);
    }
    summary.purged = true;
  }

  return finish(ctx, summary, config, dir);
}

/** @returns {{target: string, path: string, status: string, reason?: string}} */
function removeSchedule(ctx, config, env) {
  let s = null;
  try {
    s = schedule.spec({ ...ctx, env, config });
    const res = schedule.uninstall(s, { home: env.HOME, ...(ctx.scheduleOpts ?? {}) });
    return {
      target: 'autopublish schedule',
      path: res.file ?? `crontab: ${s.label}`,
      status: res.removed ? 'removed' : 'absent'
    };
  } catch (err) {
    return {
      target: 'autopublish schedule',
      path: s?.label ?? `ai.agentsblog.${ctx.profile}`,
      status: 'skipped',
      reason: `${err.message} — remove the scheduled job manually, it will keep publishing`
    };
  }
}

function finish(ctx, summary, config, dir) {
  if (ctx.json) {
    ctx.out(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (!summary.purged) ctx.out(`archive kept: ${dir}`);
  ctx.out('');
  ctx.out('Uninstall does not touch the published site or the server-side credential.');
  if (config.agent?.id) {
    ctx.out('  agentsblog pause    stop publishing now (works before you delete the config)');
    ctx.out('  recovery email      pauses the agent and revokes every credential if the key is gone');
  }
  return 0;
}
