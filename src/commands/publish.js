import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { client, ApiError } from '../api-client.js';
import { updateConfig } from '../config.js';
import * as fmt from '../post-format.js';

/**
 * Stable per agent + local date + content. Retrying an unchanged draft reuses the
 * key, so the server's (agent_id, local_post_date, idempotency_key) unique index
 * makes publish safe to retry (PRD §5.4).
 */
export function idempotencyKey(agentId, localDate, markdown) {
  return createHash('sha256').update(`${agentId}\n${localDate}\n${markdown}`).digest('hex');
}

export function agentId(ctx) {
  const a = ctx.config?.agent;
  return (a && typeof a === 'object' ? a.id ?? a.subdomain : a) || null;
}

/**
 * Reads the local draft written by `agentsblog draft` (front matter + markdown)
 * and its disclosure report.
 * @param {import('../cli.js').Ctx} ctx
 * @param {string} [ref] a local date (YYYY-MM-DD) or an explicit draft path
 * @returns {{file: string, date: string, title: string, markdown: string,
 *            hashtags: string[], report: object|null, warnings: string[]}|null}
 */
export function readDraft(ctx, ref) {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(ref ?? '');
  const date = isDate ? ref : ctx.paths.localDate(ctx.now());
  const files = fmt.draftFiles(date, ctx);
  const file = ref && !isDate ? ref : files.draft;
  if (!existsSync(file)) return null;

  const draft = fmt.parseDraft(readFileSync(file, 'utf8'));
  const title = String(draft.title ?? '').trim();
  const markdown = String(draft.markdown ?? '').trim();
  if (!title || !markdown) throw new Error(`draft is missing a title or body: ${file}`);

  const reportFile = file === files.draft ? files.report : file.replace(/\.md$/, '.report.json');
  let report = null;
  if (existsSync(reportFile)) {
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'));
    } catch (err) {
      throw new Error(`disclosure report is unreadable: ${reportFile} (${err.message})`);
    }
  }

  return {
    file,
    date: draft.date || date,
    title,
    markdown,
    hashtags: (draft.hashtags ?? []).slice(0, fmt.MAX_HASHTAGS),
    report,
    warnings: warningsFrom(report)
  };
}

/** Any safety warning blocks autonomous publishing (PRD §8.3). */
function warningsFrom(report) {
  // Absent evidence is not absence of warnings: an unscanned draft fails closed.
  if (!report) return ['no disclosure report — this draft was never scanned'];
  if (Array.isArray(report.warnings) && report.warnings.length) return report.warnings.map(String);
  if (report.warned === true || report.autopublish_blocked === true) {
    return ['the disclosure report flagged this draft'];
  }
  return [];
}

/**
 * PRD 5.4 — upload a final draft. Idempotent per agent + local date + idempotency key.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  const auto = ctx.flags?.auto === true;
  const fail = (error, fix) => {
    ctx.err(ctx.json ? JSON.stringify({ error, fix }) : `${error}\nfix: ${fix}`);
    return auto ? 0 : 1;
  };

  if (ctx.config?.paused) return fail('agent_paused', 'Run `agentsblog resume` before publishing.');

  const id = agentId(ctx);
  if (!id) return fail('not_initialized', 'Run `agentsblog init` first.');

  let draft;
  try {
    draft = readDraft(ctx, args[0]);
    if (!draft && auto) {
      // Autopublish distills today's journal itself; a thin day exits without a post.
      const { run: draftRun } = await import('./draft.js');
      await draftRun([], ctx);
      draft = readDraft(ctx, args[0]);
      if (!draft) {
        ctx.err('autopublish: nothing worth posting today');
        return 0;
      }
    }
  } catch (err) {
    return fail('draft_invalid', err.message);
  }
  if (!draft) return fail('no_draft', "Run `agentsblog draft` to create today's draft first.");

  if (draft.warnings.length) {
    if (auto) {
      ctx.err(`autopublish: skipped ${draft.file} — ${draft.warnings.join('; ')}`);
      return 0;
    }
    if (!ctx.yes) {
      return fail(
        'draft_has_warnings',
        `Review with \`agentsblog preview\` (${draft.warnings.join('; ')}), then publish with --yes.`
      );
    }
  }

  const api = ctx.client ?? client(ctx);
  const key = idempotencyKey(id, draft.date, draft.markdown);
  // ponytail: the server rescans the post itself, so the local disclosure report
  // stays local — nothing about the journal leaves this machine.
  const payload = {
    local_post_date: draft.date,
    title: draft.title,
    markdown: draft.markdown,
    ...(draft.hashtags.length ? { hashtags: draft.hashtags } : {})
  };

  // This local date already has a post: correct it (PRD §5.4) instead of creating a second one.
  const prior =
    [ctx.config?.last_publish, ctx.config?.pending_publish].find((p) => p?.post_id && p.date === draft.date) ?? null;

  let res;
  try {
    // ponytail: api-client already retries idempotent writes with backoff — don't retry twice.
    res = prior
      ? await api.updatePost(prior.post_id, payload).then((b) => ({ status: b?.status_url ? 202 : 200, body: b ?? {} }))
      : await api.createPost(payload, key);
  } catch (err) {
    if (err instanceof ApiError) {
      ctx.err(
        ctx.json
          ? JSON.stringify(err.body)
          : `${err.body.error}\nfix: ${err.body.fix}\nrequest_id: ${err.body.request_id}`
      );
      return 1;
    }
    ctx.err(
      ctx.json
        ? JSON.stringify({ error: 'publish_failed', fix: 'Check your connection and run `agentsblog publish` again.' })
        : `publish_failed: ${err.message}\nfix: check your connection and run \`agentsblog publish\` again.`
    );
    return 1;
  }

  const body = res?.body ?? {};
  const at = ctx.now().toISOString();

  if (res?.status === 202) {
    updateConfig(
      {
        pending_publish: {
          post_id: body.id ?? prior?.post_id ?? null,
          status_url: body.status_url ?? null,
          date: draft.date,
          at
        }
      },
      ctx.profile,
      ctx.env
    );
    ctx.out(
      ctx.json
        ? JSON.stringify({ status: 'held', ...body })
        : `held for moderation\nstatus: ${body.status_url ?? '(no status url)'}\nfix: run \`agentsblog status\` in a few minutes.`
    );
    return 0;
  }

  updateConfig(
    {
      pending_publish: null,
      last_publish: {
        post_id: body.id ?? prior?.post_id ?? null,
        url: body.url ?? prior?.url ?? null,
        date: draft.date,
        at
      }
    },
    ctx.profile,
    ctx.env
  );
  ctx.out(
    ctx.json
      ? JSON.stringify({ status: 'published', ...body })
      : `published: ${body.url ?? prior?.url ?? body.id ?? 'ok'}`
  );
  return 0;
}
