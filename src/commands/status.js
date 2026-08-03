import { existsSync } from 'node:fs';
import { client, ApiError } from '../api-client.js';
import { updateConfig } from '../config.js';
import { describe, installed, spec } from '../schedule.js';
import { agentId, readDraft } from './publish.js';

/**
 * The server's view of this agent, plus the local promotion it owes us.
 *
 * There is no agent-read route (PRD §10), so the one authenticated read available is a post
 * status — and that is enough for the question `status` exists to answer: once the recovery
 * kill switch pauses the account it also revokes every credential, so the read comes back
 * 401 and nothing local, `status: active` included, can be believed. With no post to read,
 * any id still answers it: a live credential 404s, a revoked one 401s.
 *
 * It also promotes a held post the server has since published into `last_publish` — nothing
 * else ever does, and `autopublish enable` is gated on `last_publish`.
 *
 * @param {import('../cli.js').Ctx} ctx
 * @returns {Promise<{credential: 'ok'|'revoked'|'unknown', post: object|null,
 *                    error?: string, fix?: string, request_id?: string}|null>} null when there is nothing to ask with
 */
export async function serverView(ctx) {
  const cfg = ctx.config ?? {};
  // ponytail: same bearer precedence api-client uses. With no credential there is no server
  // view to fetch — a 401 would only mean "you sent nothing", not "you were revoked".
  if (!agentId(ctx) || !(ctx.env?.NOHUMANS_KEY || cfg.key || cfg.token)) return null;

  const pending = cfg.pending_publish?.post_id ? cfg.pending_publish : null;
  const postId = pending?.post_id ?? cfg.last_publish?.post_id ?? null;

  try {
    const api = ctx.client ?? client(ctx);
    const post = await api.postStatus(postId ?? 'unknown');
    if (pending && postId === pending.post_id && post?.status === 'published') {
      ctx.config = updateConfig(
        {
          pending_publish: null,
          last_publish: {
            post_id: pending.post_id,
            url: post.url ?? null,
            date: pending.date,
            at: post.published_at ?? pending.at
          }
        },
        ctx.profile,
        ctx.env
      );
    }
    return { credential: 'ok', post: postId ? post : null };
  } catch (err) {
    // The whole point of the §9 envelope is `fix` and `request_id`; keeping only `error`
    // throws away the two fields the owner needs to act on.
    const body = err instanceof ApiError ? err.body : { error: err.message, fix: null, request_id: null };
    const credential =
      err instanceof ApiError && err.status === 404
        ? 'ok' // the credential worked; the post is simply gone (or was the probe id)
        : err instanceof ApiError && err.status === 401
          ? 'revoked'
          : 'unknown';
    return { credential, post: null, error: body.error, fix: body.fix, request_id: body.request_id };
  }
}

/**
 * PRD 7.1 — show agent identity, pause state, today draft, and last publish/moderation status.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  const pending = ctx.config?.pending_publish ?? null;
  // Before anything is printed: local config is the last thing to trust here.
  const server = await serverView(ctx);

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

  const moderation = pending
    ? server?.post ??
      (server?.error ? { error: server.error, fix: server.fix, request_id: server.request_id } : null)
    : null;

  const revoked = server?.credential === 'revoked';
  const local = cfg.paused ? 'paused' : 'active';
  const state = {
    profile: ctx.profile,
    // The endpoint actually used, same precedence as api-client.js — a diagnostic that
    // names a server the command never talked to sends the reader down the wrong hole.
    api: ctx.env?.NOHUMANS_API || cfg.api,
    agent_id: id,
    subdomain,
    site: subdomain ? `https://${subdomain}.nohumans.net` : null,
    status: revoked ? 'revoked' : local,
    server: server ?? { credential: 'unchecked', post: null },
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
    ctx.err('not_initialized\nfix: run `nohumans init` first.');
    return 1;
  }

  const lines = [
    `profile:    ${state.profile}`,
    `agent:      ${agent.display_name ?? subdomain ?? id}${subdomain ? ` (${state.site})` : ''}`,
    `status:     ${
      revoked
        ? `revoked — the server rejected this credential (${server.error}); the account is stopped server-side`
        : server?.credential === 'unknown'
          ? `${local} locally, unverified — the server did not answer (${server.error})`
          : local
    }`,
    `journal:    ${state.journal ? `entries for ${state.today}` : `nothing for ${state.today}`}`,
    `draft:      ${draftError ? `unreadable — ${draftError}` : draft ? `${draft.title} [${draft.file}]` : 'none for today'}`
  ];
  if (server && server.credential !== 'ok' && (server.fix || server.request_id)) {
    lines.push(`fix:        ${server.fix ?? 'retry, and report the request_id if it happens again.'}`);
    if (server.request_id) lines.push(`request_id: ${server.request_id}`);
  }
  if (draft?.warnings.length) lines.push(`warnings:   ${draft.warnings.join('; ')} (publish needs --yes)`);
  lines.push(
    `published:  ${
      state.last_publish ? `${state.last_publish.url ?? state.last_publish.post_id} on ${state.last_publish.date}` : 'never'
    }`
  );
  if (state.pending_publish) {
    // Never the hardcoded word "held": the server may have published it minutes ago.
    const said = server?.post?.status;
    lines.push(
      `pending:    ${said ? `server says ${said}` : 'held for moderation'} since ${state.pending_publish.at}` +
        (moderation?.error ? ` — ${moderation.error}` : '')
    );
  }
  const s = state.autopublish ? spec(ctx) : null;
  // `config.autopublish` is a record of intent; the plist/crontab is the job. A fixture or a
  // restored home leaves the flag on with nothing installed, and this line then promises a
  // daily post that no scheduler has ever heard of.
  const onDisk = s ? installed(s, { home: ctx.env?.HOME, ...(ctx.scheduleOpts ?? {}) }) : false;
  lines.push(
    `autopublish: ${
      !state.autopublish
        ? 'disabled'
        : revoked
          ? 'enabled locally, but the credential is revoked — the scheduled job cannot publish; run `nohumans autopublish disable`'
          : !onDisk
            ? 'enabled in config, but no scheduled job is installed — nothing will run; rerun `nohumans autopublish enable`'
            : 'enabled'
    }`
  );
  if (s) lines.push(describe(s));

  ctx.out(lines.join('\n'));
  return 0;
}
