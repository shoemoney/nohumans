import { readFileSync } from 'node:fs';
import { parseDraft, draftFiles } from '../post-format.js';

/** Load a local draft + its disclosure report. Throws ENOENT when there is no draft. */
export function loadDraft(date, ctx) {
  const files = draftFiles(date, ctx);
  const draft = parseDraft(readFileSync(files.draft, 'utf8'));
  let report = null;
  try {
    report = JSON.parse(readFileSync(files.report, 'utf8'));
  } catch {
    report = null; // a draft without a report still previews, just with no disclosure
  }
  return { files, draft, report };
}

/**
 * Terminal preview. Prints categories and counts from the scan passes — never the
 * matched values, so a preview can never reproduce a secret (PRD §8.3).
 */
export function render({ files, draft, report }, ctx) {
  ctx.out(`draft   ${files.draft}`);
  ctx.out(`date    ${draft.date ?? '(unknown)'}`);
  ctx.out(`title   ${draft.title}`);
  if (draft.hashtags.length) ctx.out(`tags    ${draft.hashtags.map((t) => '#' + t).join(' ')}`);
  ctx.out('');
  ctx.out(draft.markdown);
  ctx.out('');
  ctx.out('— disclosure —');
  if (!report) {
    ctx.out('no disclosure report on disk; re-run: agentsblog draft');
  } else {
    ctx.out(`adapter ${report.adapter ?? '(unknown)'}`);
    for (const pass of report.scans ?? []) {
      const cats = Object.entries(pass.categories ?? {});
      ctx.out(
        `scan ${pass.pass}  ` +
          (cats.length ? cats.map(([c, n]) => `${c}=${n}`).join(' ') : 'nothing detected')
      );
    }
    if (report.stats_dropped) ctx.out('stats   dropped — no harness field backed those numbers');
    ctx.out(report.warned
      ? 'status  warnings present — autonomous publishing is blocked for this draft'
      : 'status  clean');
  }
  ctx.out('');
  ctx.out(`This draft is local. Publish with: agentsblog publish ${draft.date ?? ''}`.trim());
}

/**
 * PRD 5.3 — render a local draft and its disclosure report without reproducing secrets.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>|number} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  const date = args[0] || ctx.flags?.date || ctx.paths.localDate(ctx.now ? ctx.now() : new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const msg = { error: 'bad_date', fix: 'Pass a local date as YYYY-MM-DD, e.g. agentsblog preview 2026-08-01.' };
    ctx.json ? ctx.out(JSON.stringify({ ok: false, ...msg })) : ctx.err(`${msg.error}\nfix: ${msg.fix}`);
    return 1;
  }

  let loaded;
  try {
    loaded = loadDraft(date, ctx);
  } catch (err) {
    const msg = {
      error: err.code === 'ENOENT' ? 'no_draft' : 'draft_unreadable',
      fix: err.code === 'ENOENT' ? `Run: agentsblog draft --date ${date}` : `Fix ${draftFiles(date, ctx).draft} and retry.`
    };
    ctx.json ? ctx.out(JSON.stringify({ ok: false, ...msg })) : ctx.err(`${msg.error}\nfix: ${msg.fix}`);
    return 1;
  }

  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, ...loaded.draft, report: loaded.report, file: loaded.files.draft }));
    return 0;
  }
  render(loaded, ctx);
  return 0;
}
