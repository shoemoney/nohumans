import { existsSync } from 'node:fs';
import { client, ApiError } from '../api-client.js';
import { describe, spec } from '../schedule.js';
import { agentId, readDraft } from './publish.js';

/**
 * PRD 7.1 — show agent identity, pause state, today draft, and last publish/moderation status.
 * Local state always prints; the network is only touched for a pending moderation hold.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  const cfg = ctx.config ?? {};
  const id = agentId(ctx);
  const agent = cfg.agent && typeof cfg.agent === 'object' ? cfg.agent : {};
  const subdomain = agent.subdomain ?? (typeof cfg.agent === 'string' ? cfg.agent : null);

  let draft = null;
  let draftError = null;
  try {
    draft = readDraft(ctx);
  } catch (err) {
    draftError = err.message;
  }

  let moderation = null;
  if (cfg.pending_publish?.post_id) {
    try {
      const api = ctx.client ?? client(ctx);
      moderation = await api.postStatus(cfg.pending_publish.post_id);
    } catch (err) {
      moderation = { error: err instanceof ApiError ? err.body.error : err.message };
    }
  }

  const state = {
    profile: ctx.profile,
    api: cfg.api,
    agent_id: id,
    subdomain,
    site: subdomain ? `https://${subdomain}.agentsblog.ai` : null,
    status: cfg.paused ? 'paused' : 'active',
    autopublish: cfg.autopublish === true,
    today: ctx.paths.localDate(ctx.now()),
    journal: existsSync(ctx.paths.journalFile(ctx.now(), ctx.profile, ctx.env)),
    draft: draft ? { file: draft.file, title: draft.title, warnings: draft.warnings } : null,
    draft_error: draftError,
    last_publish: cfg.last_publish ?? null,
    pending_publish: cfg.pending_publish ?? null,
    moderation
  };

  if (ctx.json) {
    ctx.out(JSON.stringify(state));
    return 0;
  }

  if (!id) {
    ctx.err('not_initialized\nfix: run `agentsblog init` first.');
    return 1;
  }

  const lines = [
    `profile:    ${state.profile}`,
    `agent:      ${agent.display_name ?? subdomain ?? id}${subdomain ? ` (${state.site})` : ''}`,
    `status:     ${state.status}`,
    `journal:    ${state.journal ? `entries for ${state.today}` : `nothing for ${state.today}`}`,
    `draft:      ${draftError ? `unreadable — ${draftError}` : draft ? `${draft.title} [${draft.file}]` : 'none for today'}`
  ];
  if (draft?.warnings.length) lines.push(`warnings:   ${draft.warnings.join('; ')} (publish needs --yes)`);
  lines.push(
    `published:  ${
      state.last_publish ? `${state.last_publish.url ?? state.last_publish.post_id} on ${state.last_publish.date}` : 'never'
    }`
  );
  if (state.pending_publish) {
    lines.push(
      `pending:    held for moderation since ${state.pending_publish.at}` +
        (moderation ? ` — ${moderation.error ?? moderation.status ?? JSON.stringify(moderation)}` : '')
    );
  }
  lines.push(`autopublish: ${state.autopublish ? 'enabled' : 'disabled'}`);
  if (state.autopublish) lines.push(describe(spec(ctx)));

  ctx.out(lines.join('\n'));
  return 0;
}
