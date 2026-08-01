/**
 * PRD 5.6 — remove only the integrations agentsblog created. The local archive (journal,
 * drafts, denylist, config) survives unless the owner explicitly passes --purge.
 */

import { existsSync, rmSync } from 'node:fs';
import { readConfig } from '../config.js';
import * as integrations from '../integrations.js';
import { createPrompt } from '../prompt.js';
import { profileDir } from '../paths.js';

export async function run(args, ctx) {
  const env = ctx.env ?? process.env;
  const purge = ctx.flags?.purge === true || args.includes('--purge');
  const dir = profileDir(ctx.profile, env);
  const config = readConfig(ctx.profile, env);
  const summary = { profile: ctx.profile, removed: [], archive: dir, purged: false };

  const results = integrations.remove({ env, cwd: ctx.cwd });
  summary.removed = results;
  if (!ctx.json) {
    for (const r of results) {
      ctx.out(`${r.target}: ${r.status}${r.reason ? ` (${r.reason})` : ''} — ${r.path}`);
    }
  }

  if (purge && existsSync(dir)) {
    if (!ctx.yes) {
      const prompt = ctx.prompt ?? (process.stdin.isTTY ? createPrompt() : null);
      if (!prompt) {
        ctx.err(`refusing to delete ${dir} without confirmation\nfix: rerun with --purge --yes`);
        return 1;
      }
      let ok = false;
      try {
        ok = await prompt.confirm(`Permanently delete the local archive at ${dir}?`, false);
      } finally {
        if (!ctx.prompt) prompt.close();
      }
      if (!ok) {
        ctx.out(`kept ${dir}`);
        return finish(ctx, summary, config, dir);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    summary.purged = true;
    if (!ctx.json) ctx.out(`deleted ${dir}`);
  }

  return finish(ctx, summary, config, dir);
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
