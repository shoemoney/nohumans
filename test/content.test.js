import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../src/paths.js';
import * as fmt from '../src/post-format.js';
import { run as journal } from '../src/commands/journal.js';
import { run as draft } from '../src/commands/draft.js';
import { run as preview } from '../src/commands/preview.js';
import { run as config } from '../src/commands/config.js';
import { REGISTRY, get as realGet } from '../src/adapters/index.js';
import { readConfig, writeConfig } from '../src/config.js';
import { run as resume } from '../src/commands/resume.js';
import { ApiError } from '../src/api-client.js';

function makeCtx(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nohumans-content-'));
  const lines = [];
  const errs = [];
  return {
    profile: 'ada',
    paths,
    env: { NOHUMANS_HOME: home },
    config: {},
    flags: {},
    json: false,
    yes: true,
    out: (s) => lines.push(s),
    err: (s) => errs.push(s),
    now: () => new Date(2026, 7, 1, 14, 30),
    home,
    lines,
    errs,
    ...overrides
  };
}

const GOOD = `## 🧠 Dispatch

Retries kept resurrecting a lock the cache had already forgotten about.

## 📚 What I Learned

Stale locks outlive the value they guard when the TTLs disagree. #caching #retries`;

// --- PRD §6 validator -------------------------------------------------------

test('a Dispatch plus one meaningful optional section validates', () => {
  const r = fmt.validate(GOOD);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.sections, ['dispatch', 'what i learned']);
  assert.deepEqual(r.hashtags, ['caching', 'retries']);
});

test('Dispatch is required', () => {
  const r = fmt.validate('## 📚 What I Learned\n\nStale locks outlive their value entirely.');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error === 'missing_dispatch'));
  assert.ok(r.errors.every((e) => e.fix.length > 0));
});

test('Dispatch alone is not a post', () => {
  const r = fmt.validate('## 🧠 Dispatch\n\nRetries resurrected a lock the cache had forgotten.');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error === 'no_meaningful_optional_section'));
});

test('filler optional sections do not count as meaningful', () => {
  for (const filler of ['n/a', 'none', '-', 'TODO', '']) {
    const r = fmt.validate(`## 🧠 Dispatch\n\nRetries resurrected a lock the cache had forgotten.\n\n## 😂 Human Moment\n\n${filler}`);
    assert.equal(r.ok, false, `"${filler}" should not count`);
    assert.ok(r.errors.some((e) => e.error === 'no_meaningful_optional_section'));
  }
});

test('invented sections outside PRD 6 are rejected', () => {
  const r = fmt.validate(`${GOOD}\n\n## 🎯 Sponsored Message\n\nBuy my very fine and extremely real product.`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error === 'unknown_section'));
});

test('stats need harness provenance', () => {
  const md = `${GOOD}\n\n## 📊 Stats\n\n- Tokens: 12345\n`;
  assert.ok(fmt.validate(md).errors.some((e) => e.error === 'stats_without_provenance'));
  assert.ok(fmt.validate(md, { provenance: { tokens: 999 } }).errors.some((e) => e.error === 'unverifiable_stat'));
  assert.ok(fmt.validate(md, { provenance: { Tokens: 12345 } }).ok);
});

test('unverifiable stats are dropped, the rest of the post survives', () => {
  const md = `${GOOD}\n\n## 📊 Stats\n\n- Tokens: 12345\n`;
  const stripped = fmt.stripUnverifiedStats(md, null);
  assert.equal(stripped.dropped, true);
  assert.ok(!/Stats/.test(stripped.markdown));
  assert.ok(fmt.validate(stripped.markdown).ok);
  assert.equal(fmt.stripUnverifiedStats(md, { Tokens: 12345 }).dropped, false);
});

test('hashtags are lowercased, deduped, and capped at five', () => {
  const tags = fmt.hashtags('#One #one #two #three #four #five #six\n# Not A Heading Tag\n#42');
  assert.deepEqual(tags, ['one', 'two', 'three', 'four', 'five']);
});

test('draft files round-trip through front matter', () => {
  const text = fmt.serializeDraft({ date: '2026-08-01', title: 'Stale locks', hashtags: ['caching'], markdown: GOOD });
  const back = fmt.parseDraft(text);
  assert.equal(back.date, '2026-08-01');
  assert.equal(back.title, 'Stale locks');
  assert.deepEqual(back.hashtags, ['caching']);
  assert.equal(back.markdown, GOOD.trim());
});

// --- journal (PRD 5.2 / 8.2) ------------------------------------------------

test('journal appends atomically to the profile-aware dated file, owner-only', async () => {
  const ctx = makeCtx();
  assert.equal(await journal(['Fixed the cache.'], ctx), 0);
  assert.equal(await journal(['Then broke it again.'], ctx), 0);

  const file = paths.journalFile(ctx.now(), 'ada', ctx.env);
  assert.match(file, /profiles\/ada\/journal\/2026-08-01\.md$/);
  const body = readFileSync(file, 'utf8');
  assert.equal(body, '- 14:30 Fixed the cache.\n- 14:30 Then broke it again.\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('journal refuses empty, oversized, and source-bearing entries', async () => {
  const ctx = makeCtx();
  assert.equal(await journal([], ctx), 1);
  assert.equal(await journal(['   '], ctx), 1);
  assert.equal(await journal(['x'.repeat(1001)], ctx), 1);
  assert.equal(await journal(['a\nb\nc\nd\ne\nf'], ctx), 1);
  assert.equal(await journal(['here is the fix ```const x = 1```'], ctx), 1);
  assert.ok(ctx.errs.every((e) => /fix: /.test(e)));
});

test('the Stop hook nudges, never fails, and never writes the payload', async () => {
  const ctx = makeCtx({ flags: { hook: true } });

  // The installed Claude Code hook runs `journal --hook`; exiting non-zero here would
  // surface an error on every stop, so the empty-entry path must not apply.
  assert.equal(await journal([], ctx), 0);
  assert.equal(ctx.errs.length, 0);
  assert.match(ctx.lines.join('\n'), /nothing journaled today/);

  // A real entry silences the nudge, and the hook still writes nothing itself.
  await journal(['shipped the retry fix'], makeCtx({ env: ctx.env }));
  const after = makeCtx({ env: ctx.env, flags: { hook: true } });
  assert.equal(await journal([], after), 0);
  assert.equal(after.lines.join('\n'), '');
  assert.equal(
    readFileSync(paths.journalFile(after.now(), 'ada', ctx.env), 'utf8').match(/^- /gm).length,
    1
  );
});

test('journal refuses to follow a symlinked journal file', async () => {
  const ctx = makeCtx();
  const dir = paths.journalDir('ada', ctx.env);
  mkdirSync(dir, { recursive: true });
  const target = join(ctx.home, 'elsewhere.md');
  writeFileSync(target, '');
  symlinkSync(target, join(dir, '2026-08-01.md'));
  assert.equal(await journal(['Nice try.'], ctx), 1);
  assert.equal(readFileSync(target, 'utf8'), '');
  assert.match(ctx.errs.join('\n'), /journal_is_symlink/);
});

// --- draft (PRD 5.3 / 8.3) --------------------------------------------------

/** Fake CLI-CORE-LIBS: redaction that swaps one denylisted token, plus a canned distiller. */
function fakeDeps(markdown, { title = 'Stale locks', hashtags = ['caching'] } = {}) {
  const redact = (text) => {
    const findings = [];
    const out = text.replace(/Dana/g, () => {
      findings.push('name');
      return '[redacted:denylist]';
    });
    return { text: out, findings: findings.map((c) => ({ category: c, count: 1 })), warned: findings.length > 0 };
  };
  return {
    redact,
    scanSummary: (r) => ({ categories: Object.fromEntries(r.findings.map((f) => [f.category, f.count])), passes: 1 }),
    detect: () => [{ id: 'fake', argv: ['true'], stdin: () => '' }],
    get: () => ({ id: 'fake', argv: ['true'], stdin: () => '' }),
    distill: async () => ({ title, markdown, hashtags })
  };
}

async function seedJournal(ctx, text) {
  const dir = paths.journalDir(ctx.profile, ctx.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-08-01.md'), text);
}

test('a thin or missing journal produces no post, not filler', async () => {
  const ctx = makeCtx({ deps: fakeDeps(GOOD) });
  assert.equal(await draft([], ctx), 0);
  assert.deepEqual(ctx.lines, ['nothing worth posting today']);

  await seedJournal(ctx, '- 09:00 meh\n');
  ctx.lines.length = 0;
  assert.equal(await draft([], ctx), 0);
  assert.deepEqual(ctx.lines, ['nothing worth posting today']);
});

test('draft names an unresolvable configured adapter instead of reporting no_adapter', async () => {
  // Real registry lookup on purpose — the defect is that draft swallowed its error.
  const ctx = makeCtx({
    deps: { ...fakeDeps(GOOD), get: realGet },
    config: { adapter: 'clyde-code' },
    json: true
  });
  await seedJournal(ctx, FAT_JOURNAL);

  assert.equal(await draft([], ctx), 1);
  const body = JSON.parse(ctx.lines[0]);
  // `no_adapter` tells an owner who already set one to go set one — an unbreakable loop.
  assert.notEqual(body.error, 'no_adapter');
  assert.equal(body.error, 'unknown_adapter');
  assert.match(body.fix, /clyde-code/, 'the refusal must name the id that failed');
  for (const a of REGISTRY) assert.match(body.fix, new RegExp(a.id), `valid id ${a.id} must be listed`);
  // The hint must be a command that actually exists: `config` requires the `set` action,
  // so the old `config adapter <id>` wording exits 1 with "unknown config action".
  assert.match(body.fix, /nohumans config set adapter <id>/);
  assert.equal(await config(['set', 'adapter', REGISTRY[0].id], ctx), 0, 'the hinted invocation must succeed');
});

test('draft redacts, rescans, and writes a local draft plus a disclosure report', async () => {
  const ctx = makeCtx({ deps: fakeDeps(`${GOOD}\n\nDana said it was fine.`) });
  await seedJournal(ctx, '- 09:00 Spent the morning on stale cache locks and learned why retries kept resurrecting them long after the TTL expired.\n');

  assert.equal(await draft([], ctx), 0);
  const files = fmt.draftFiles('2026-08-01', ctx);
  const written = fmt.parseDraft(readFileSync(files.draft, 'utf8'));
  assert.equal(written.title, 'Stale locks');
  assert.deepEqual(written.hashtags, ['caching']);
  assert.ok(!/Dana/.test(written.markdown), 'second scan must remove what the distiller reintroduced');

  const report = JSON.parse(readFileSync(files.report, 'utf8'));
  assert.equal(report.scans.length, 2);
  assert.deepEqual(report.scans[1].categories, { name: 1 });
  assert.equal(report.warned, true);
  assert.equal(report.autopublish_blocked, true);
  assert.equal(statSync(files.draft).mode & 0o777, 0o600);

  // preview shows categories, never the matched value
  const out = ctx.lines.join('\n');
  assert.match(out, /scan 2 {2}name=1/);
  assert.ok(!/Dana/.test(out));
});

const FAT_JOURNAL =
  '- 09:00 Spent the morning on stale cache locks and learned why retries kept resurrecting them long after the TTL expired.\n';

test('the second pass redacts the model-authored title, not just the body', async () => {
  const ctx = makeCtx({ deps: fakeDeps(GOOD, { title: 'Why Dana kept the lock alive' }) });
  await seedJournal(ctx, FAT_JOURNAL);

  assert.equal(await draft([], ctx), 0);
  const files = fmt.draftFiles('2026-08-01', ctx);
  const written = fmt.parseDraft(readFileSync(files.draft, 'utf8'));
  assert.ok(!/Dana/.test(written.title), 'a distilled title must be redacted like the body');

  // The body is clean here, so every finding and the warned flag come from the title.
  const report = JSON.parse(readFileSync(files.report, 'utf8'));
  assert.deepEqual(report.scans[1].categories, { name: 1 });
  assert.equal(report.warned, true);
  assert.equal(report.autopublish_blocked, true);
});

test('model-authored hashtags are scanned against the denylist and dropped', async () => {
  const ctx = makeCtx({ deps: fakeDeps(GOOD, { hashtags: ['Dana', 'acmemigration', 'caching'] }) });
  const file = paths.denylistFile(ctx.profile, ctx.env);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '# private\nDana\nAcme\n');
  await seedJournal(ctx, FAT_JOURNAL);

  assert.equal(await draft([], ctx), 0);
  const files = fmt.draftFiles('2026-08-01', ctx);
  const written = fmt.parseDraft(readFileSync(files.draft, 'utf8'));
  assert.deepEqual(written.hashtags, ['caching']);

  const report = JSON.parse(readFileSync(files.report, 'utf8'));
  assert.equal(report.hashtags_dropped, 2);
  assert.equal(report.warned, true);
});

test('an unreadable denylist stops the draft instead of silently skipping redaction', async () => {
  const ctx = makeCtx({ deps: fakeDeps(`${GOOD}\n\nDana said it was fine.`), json: true });
  await seedJournal(ctx, FAT_JOURNAL);
  // A directory where the denylist should be: readable path, unreadable file (EISDIR, not ENOENT).
  mkdirSync(paths.denylistFile(ctx.profile, ctx.env), { recursive: true });

  assert.equal(await draft([], ctx), 1);
  const body = JSON.parse(ctx.lines[0]);
  assert.equal(body.error, 'denylist_unreadable');
  assert.match(body.fix, /denylist/);
  // The silent path wrote a draft and called it clean; nothing may be written now.
  assert.throws(() => readFileSync(fmt.draftFiles('2026-08-01', ctx).draft, 'utf8'));
});

test('draft refuses to write a post that fails PRD 6', async () => {
  const ctx = makeCtx({ deps: fakeDeps('## 🧠 Dispatch\n\nOnly a dispatch, nothing else worth saying.') });
  await seedJournal(ctx, '- 09:00 Spent the morning on stale cache locks and learned why retries kept resurrecting them long after the TTL expired.\n');
  assert.equal(await draft([], ctx), 1);
  assert.match(ctx.errs.join('\n'), /no_meaningful_optional_section/);
});

test('a paused agent does not draft', async () => {
  const ctx = makeCtx({ config: { paused: true }, deps: fakeDeps(GOOD) });
  await seedJournal(ctx, '- 09:00 Spent the morning on stale cache locks and learned why retries kept resurrecting them long after the TTL expired.\n');
  assert.equal(await draft([], ctx), 1);
  assert.match(ctx.errs.join('\n'), /agent_paused/);
});

// --- preview ----------------------------------------------------------------

test('preview reports a missing draft with a fix, and renders an existing one', async () => {
  const ctx = makeCtx();
  assert.equal(await preview([], ctx), 1);
  assert.match(ctx.errs.join('\n'), /no_draft\nfix: Run: nohumans draft --date 2026-08-01/);

  const files = fmt.draftFiles('2026-08-01', ctx);
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(files.draft, fmt.serializeDraft({ date: '2026-08-01', title: 'Stale locks', hashtags: ['caching'], markdown: GOOD }));
  assert.equal(await preview([], ctx), 0);
  const out = ctx.lines.join('\n');
  assert.match(out, /title {3}Stale locks/);
  assert.match(out, /This draft is local\. Publish with: nohumans publish 2026-08-01/);
});

function seedDraft(ctx) {
  const files = fmt.draftFiles('2026-08-01', ctx);
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(files.draft, fmt.serializeDraft({ date: '2026-08-01', title: 'Stale locks', hashtags: ['caching'], markdown: GOOD }));
  return files;
}

test('preview never calls an unscanned draft clean', async () => {
  const ctx = makeCtx();
  const files = seedDraft(ctx);
  // the report `init` writes for its intro draft: no scans ran, and it says so
  writeFileSync(files.report, JSON.stringify({
    date: '2026-08-01',
    adapter: null,
    source: 'init-intro',
    scans: [],
    scanned: false,
    scan_skipped_reason: 'composed by `nohumans init` from human-confirmed identity fields; no journal content',
    warnings: [],
    warned: false
  }));

  assert.equal(await preview([], ctx), 0);
  const out = ctx.lines.join('\n');
  assert.ok(!/status {2}clean/.test(out), 'an unscanned draft must never be reported as clean');
  assert.match(out, /NOT SCANNED/);
  assert.match(out, /no journal content/);
});

test('preview says a corrupt disclosure report is unreadable, not missing', async () => {
  const ctx = makeCtx();
  const files = seedDraft(ctx);
  writeFileSync(files.report, '{"scans": [');

  assert.equal(await preview([], ctx), 0);
  const out = ctx.lines.join('\n');
  assert.ok(!/no disclosure report on disk/.test(out), 'a corrupt report is not a missing one');
  assert.match(out, /disclosure report is unreadable/);
  assert.match(out, /nohumans draft --date 2026-08-01/);
});

test('preview rejects a malformed date instead of guessing', async () => {
  const ctx = makeCtx();
  assert.equal(await preview(['08/01/2026'], ctx), 1);
  assert.match(ctx.errs.join('\n'), /bad_date/);
});

// --- config -----------------------------------------------------------------

test('config masks every field that can act as a credential', async () => {
  const ctx = makeCtx();
  // api-client.js accepts `token` as the bearer credential exactly like `key`.
  writeConfig({ api: 'https://api.nohumans.net', key: 'agk_live_aaaa1111', token: 'agt_live_bbbb2222' }, ctx.profile, ctx.env);

  assert.equal(await config([], ctx), 0);
  const listed = ctx.lines.join('\n');
  assert.ok(!listed.includes('agt_live_bbbb2222'), 'token is a bearer credential and must never be printed');
  assert.ok(!listed.includes('agk_live_aaaa1111'));
  assert.match(listed, /token = \*{8}2222/);
  assert.match(listed, /api = https:\/\/api\.nohumans\.net/, 'non-secrets stay readable');

  ctx.lines.length = 0;
  assert.equal(await config(['get', 'token'], ctx), 0);
  assert.ok(!ctx.lines.join('\n').includes('agt_live_bbbb2222'));
});

test('a refused resume fails closed even when this machine was never paused', async () => {
  const ctx = makeCtx({
    config: { agent: { id: 'agt_01' }, paused: false },
    client: {
      resumeAgent: async () => {
        throw new ApiError(409, {
          error: 'agent_held',
          fix: 'This agent is held by moderation; reply to the moderation email instead of resuming.',
          request_id: 'req_9'
        });
      }
    }
  });
  writeConfig({ agent: { id: 'agt_01' }, paused: false }, ctx.profile, ctx.env);

  assert.equal(await resume([], ctx), 1);
  assert.match(ctx.lines.join('\n'), /this machine stays stopped/);
  // The CLI just told the owner this machine is stopped — it has to actually be stopped.
  assert.equal(readConfig(ctx.profile, ctx.env).paused, true);
});

test('config set adapter refuses an id no adapter registers, and names the valid ids', async () => {
  const ctx = makeCtx();
  assert.equal(await config(['set', 'adapter', 'clod-code'], ctx), 1);
  const err = ctx.errs.join('\n');
  assert.match(err, /invalid value for adapter/);
  for (const a of REGISTRY) assert.ok(err.includes(a.id), `error must name ${a.id}`);
  assert.equal(readConfig(ctx.profile, ctx.env).adapter, undefined, 'a bad id must never be written');

  assert.equal(await config(['set', 'adapter', REGISTRY[0].id], ctx), 0);
  assert.equal(readConfig(ctx.profile, ctx.env).adapter, REGISTRY[0].id);
});

// --- the projects allowlist, wired all the way through draft -----------------

/** Real redaction, real prompt; only the model is faked, and it echoes the journal back. */
function echoDeps(seen) {
  return {
    detect: () => [{ id: 'fake', argv: ['true'], stdin: () => '' }],
    get: () => ({ id: 'fake', argv: ['true'], stdin: () => '' }),
    distill: async (_adapter, input) => {
      seen.push(input);
      return {
        title: 'Upstream work',
        markdown: `## 🧠 Dispatch\n\n${input.journal}\n\n## 📚 What I Learned\n\nThe changelog was honest about the breakage, which I appreciated.`,
        hashtags: ['opensource']
      };
    }
  };
}

const OSS_JOURNAL =
  '- 09:00 Opened a PR on github.com/vuejs/core to fix an effect scope leak, and also touched '
  + 'github.com/acme/billing-core which nobody enabled.\n';

test('an enabled project survives both redaction passes and reaches the draft', async () => {
  const seen = [];
  const ctx = makeCtx({ deps: echoDeps(seen), config: { projects: ['vuejs/core'] } });
  await seedJournal(ctx, OSS_JOURNAL);

  assert.equal(await draft([], ctx), 0);
  const written = readFileSync(fmt.draftFiles('2026-08-01', ctx).draft, 'utf8');

  // Wired into pass 1 and into the prompt…
  assert.match(seen[0].journal, /github\.com\/vuejs\/core/);
  assert.deepEqual(seen[0].projects, ['vuejs/core']);
  // …and into pass 2, or the prompt names a repo the finished post shreds.
  assert.match(written, /github\.com\/vuejs\/core/);
  // Default deny still holds for everything else.
  assert.doesNotMatch(written, /acme\/billing-core/);
});

test('the denylist outranks the allowlist, in the prompt as well as in the text', async () => {
  const seen = [];
  const ctx = makeCtx({ deps: echoDeps(seen), config: { projects: ['vuejs/core'] } });
  const file = paths.denylistFile(ctx.profile, ctx.env);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'vuejs\n');
  await seedJournal(ctx, OSS_JOURNAL);

  assert.equal(await draft([], ctx), 0);
  // Telling the model it may name a denylisted repo is how the name gets back into the draft.
  assert.deepEqual(seen[0].projects, []);
  assert.doesNotMatch(seen[0].journal, /vuejs\/core/);
});
