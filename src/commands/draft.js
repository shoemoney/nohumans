import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as fmt from '../post-format.js';
import * as redaction from '../redact.js';
import * as adapters from '../adapters/index.js';
import { loadDraft, render } from './preview.js';

/** Below this much prose the day is "too thin" (PRD 5.3). */
const MIN_JOURNAL_CHARS = 80;

function say(ctx, error, fix) {
  if (ctx.json) ctx.out(JSON.stringify({ ok: false, error, fix }));
  else ctx.err(`${error}\nfix: ${fix}`);
  return 1;
}

/** Journal prose only: drops the "- HH:MM " bullets and blank lines. */
function journalProse(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*(\d{2}:\d{2}\s+)?/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function readDenylist(ctx) {
  try {
    return readFileSync(ctx.paths.denylistFile(ctx.profile, ctx.env), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch (err) {
    // No denylist is a choice; an unreadable one is a silently disabled redaction layer.
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * PRD 5.3 — read today journal, bail if thin, redact, generate via adapter, rescan, write draft + disclosure report.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>|number} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  // ponytail: single seam so the pipeline is testable before CLI-CORE-LIBS lands.
  const { redact, scanSummary, detect, get, distill } = { ...redaction, ...adapters, ...(ctx.deps ?? {}) };

  const date = args[0] || ctx.flags?.date || ctx.paths.localDate(ctx.now ? ctx.now() : new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return say(ctx, 'bad_date', 'Pass a local date as YYYY-MM-DD, e.g. agentsblog draft --date 2026-08-01.');
  }
  if (ctx.config?.paused) {
    return say(ctx, 'agent_paused', 'Run: agentsblog resume');
  }

  const journalPath = join(ctx.paths.journalDir(ctx.profile, ctx.env), `${date}.md`);
  let prose = '';
  try {
    prose = journalProse(readFileSync(journalPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return say(ctx, 'journal_unreadable', `Fix ${journalPath} and retry (${err.code || err.message}).`);
    }
  }

  if (prose.length < MIN_JOURNAL_CHARS) {
    if (ctx.json) ctx.out(JSON.stringify({ ok: true, drafted: false, reason: 'thin_source', date }));
    else ctx.out('nothing worth posting today');
    return 0;
  }

  // Pass 1 — local redaction before anything sees the text (PRD §4.3.3).
  let denylist;
  try {
    denylist = readDenylist(ctx);
  } catch (err) {
    const file = ctx.paths.denylistFile(ctx.profile, ctx.env);
    return say(ctx, 'denylist_unreadable', `Fix ${file} and retry (${err.code || err.message}); drafting without it would silently skip denylist redaction.`);
  }
  const first = redact(prose, denylist);

  let adapter;
  if (ctx.config?.adapter) {
    // A configured id that the registry cannot resolve is its own error: reporting it as
    // `no_adapter` sends the owner to set an adapter they already set.
    try {
      adapter = get(ctx.config.adapter);
    } catch (err) {
      return say(ctx, 'unknown_adapter', `${err.message.replace(/\n(?:fix: )?/g, ' — ')}. Set one with: agentsblog config set adapter <id>`);
    }
  } else {
    adapter = detect(ctx.env)[0];
  }
  if (!adapter) {
    return say(ctx, 'no_adapter', 'Set one with: agentsblog config set adapter <id>');
  }

  const cfg = ctx.config ?? {};
  // `init` stores identity under config.agent = {id, subdomain, display_name, bio, vibe}.
  const stored = typeof cfg.agent === 'object' && cfg.agent ? cfg.agent : {};
  const identity = cfg.identity ?? {
    displayName:
      stored.display_name ?? cfg.display_name ?? (typeof cfg.agent === 'string' ? cfg.agent : null) ?? 'this agent',
    bio: stored.bio ?? cfg.bio ?? '',
    vibe: stored.vibe ?? cfg.vibe ?? ''
  };

  let generated;
  try {
    generated = await distill(adapter, { journal: first.text, identity });
  } catch (err) {
    return say(ctx, 'distiller_failed', `Check that ${adapter.id} runs locally, then re-run agentsblog draft (${err.message}).`);
  }

  // Pass 2 — the generated draft is scanned again; anything the distiller
  // reconstructed is replaced, not published (PRD §4.3.5).
  const second = redact(String(generated?.markdown ?? ''), denylist);

  // Stats survive only when a harness field backs them; otherwise the section is dropped.
  const provenance = cfg.stats_provenance ?? null;
  const stripped = fmt.stripUnverifiedStats(second.text, provenance);

  const check = fmt.validate(stripped.markdown, { provenance });
  if (!check.ok) {
    if (ctx.json) ctx.out(JSON.stringify({ ok: false, error: 'draft_rejected', errors: check.errors, date }));
    else {
      ctx.err('draft_rejected');
      for (const e of check.errors) ctx.err(`  ${e.error}\n  fix: ${e.fix}`);
    }
    return 1;
  }

  const files = fmt.draftFiles(date, ctx);
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });

  // The title is model-authored too — pass 2 covers the whole draft, not just the body.
  const titleScan = redact(String(generated.title ?? check.title ?? ''), denylist);
  const title = titleScan.text.trim() || `Dispatch ${date}`;

  // ponytail: substring match as well as the word-boundary scan — hashtags concatenate
  // words, so #acmemigration has to die alongside #acme.
  const denyTerms = denylist
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter((t) => t.length >= 3);
  const tags = [];
  let hashtagsDropped = 0;
  for (const raw of generated.hashtags?.length ? generated.hashtags : check.hashtags) {
    const tag = String(raw).toLowerCase().replace(/^#/, '');
    if (!tag) continue;
    if (redact(String(raw), denylist).findings?.length || denyTerms.some((t) => tag.includes(t))) {
      hashtagsDropped += 1;
      continue;
    }
    tags.push(tag);
    if (tags.length === fmt.MAX_HASHTAGS) break;
  }

  const secondScan = scanSummary(second);
  const titleSummary = scanSummary(titleScan);
  for (const [category, count] of Object.entries(titleSummary.categories)) {
    secondScan.categories[category] = (secondScan.categories[category] ?? 0) + count;
  }
  secondScan.passes = Math.max(secondScan.passes ?? 1, titleSummary.passes ?? 1);

  const warned = Boolean(
    first.warned || second.warned || second.findings?.length ||
    titleScan.warned || titleScan.findings?.length || hashtagsDropped
  );
  const report = {
    date,
    draft: files.draft,
    adapter: adapter.id,
    scans: [
      { pass: 1, source: 'journal', ...scanSummary(first) },
      { pass: 2, source: 'generated', ...secondScan }
    ],
    hashtags_dropped: hashtagsDropped,
    stats_dropped: stripped.dropped,
    warned,
    autopublish_blocked: warned,
    sections: check.sections,
    generated_at: new Date().toISOString()
  };

  writeAtomic(files.draft, fmt.serializeDraft({ date, title, hashtags: tags, markdown: stripped.markdown }));
  writeAtomic(files.report, JSON.stringify(report, null, 2) + '\n');

  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, drafted: true, file: files.draft, title, hashtags: tags, report }));
    return 0;
  }
  render(loadDraft(date, ctx), ctx);
  return 0;
}
