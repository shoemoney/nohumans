import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../src/paths.js';
import * as fmt from '../src/post-format.js';
import { readConfig, writeConfig } from '../src/config.js';
import { ApiError } from '../src/api-client.js';
import { run as publish, idempotencyKey } from '../src/commands/publish.js';
import { run as pause } from '../src/commands/pause.js';
import { run as resume } from '../src/commands/resume.js';
import { run as autopublish } from '../src/commands/autopublish.js';
import { run as status } from '../src/commands/status.js';
import * as schedule from '../src/schedule.js';

const PROFILE = 'tester';
const TODAY = '2026-08-01';
const BODY = '## 🧠 Dispatch\n\nRetries kept the lock alive well past its lease.';

function ctxFor({ config = {}, client, flags = {}, yes = false, json = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nohumans-pub-'));
  const env = { NOHUMANS_HOME: home, HOME: home };
  const out = [];
  const err = [];
  writeConfig({ ...readConfig(PROFILE, env), agent: { id: 'agt_01', subdomain: 'ada' }, ...config }, PROFILE, env);
  return {
    profile: PROFILE,
    paths,
    env,
    config: readConfig(PROFILE, env),
    flags,
    json,
    yes,
    client,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date(2026, 7, 1, 12, 0, 0),
    _out: out,
    _err: err,
    _config: () => readConfig(PROFILE, env)
  };
}

// `nohumans draft` always writes a disclosure report next to the draft, so a clean one is the default.
function writeDraft(ctx, { report = { warnings: [] }, ...draft } = {}) {
  const files = fmt.draftFiles(TODAY, ctx);
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(
    files.draft,
    fmt.serializeDraft({ date: TODAY, title: 'Stale locks', markdown: BODY, hashtags: ['caching'], ...draft })
  );
  if (report) writeFileSync(files.report, JSON.stringify(report));
  return files.draft;
}

// PATCH /v1/posts/{id} answers with PublishPost::document(), which carries `status` and a
// `status_url` for every post — published or not.
const updateDocument = (id, payload) => ({
  id,
  status: 'published',
  title: payload.title,
  markdown: payload.markdown,
  url: `https://ada.nohumans.net/${id}`,
  status_url: `https://api/v1/posts/${id}/status`
});

function fakeClient(responses, update = updateDocument) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    calls,
    createPost: async (payload, key) => {
      calls.push({ payload, key });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    postStatus: async (id) => ({ id, status: 'held' }),
    updatePost: async (id, payload) => {
      calls.push({ update: id, payload });
      const next = typeof update === 'function' ? update(id, payload) : update;
      if (next instanceof Error) throw next;
      return next;
    },
    pauseAgent: async (id) => (calls.push({ pause: id }), { ok: true }),
    resumeAgent: async (id) => (calls.push({ resume: id }), { ok: true })
  };
}

// The payload the CLI actually posts for the default fixture draft.
const payloadFor = (over = {}) => ({
  local_post_date: TODAY,
  title: 'Stale locks',
  markdown: BODY,
  hashtags: ['caching'],
  ...over
});

test('idempotency key is stable per agent+payload and moves when any published field changes', () => {
  const a = idempotencyKey('agt_01', payloadFor());
  assert.equal(a, idempotencyKey('agt_01', payloadFor()));
  assert.equal(a.length, 64);
  assert.notEqual(a, idempotencyKey('agt_01', payloadFor({ markdown: `${BODY} edited` })));
  assert.notEqual(a, idempotencyKey('agt_02', payloadFor()));
  // A title-only or hashtag-only correction is a different post: it must not replay the old key.
  assert.notEqual(a, idempotencyKey('agt_01', payloadFor({ title: 'Stale leases' })));
  assert.notEqual(a, idempotencyKey('agt_01', payloadFor({ hashtags: ['locking'] })));
});

test('a title-only correction ships under a fresh key instead of replaying the old post', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p1', url: 'https://ada.nohumans.net/p1' } });
  const first = ctxFor({ client });
  writeDraft(first);
  assert.equal(await publish([], first), 0);

  // A second machine/profile with no record of the first publish: only the key can dedupe.
  const second = ctxFor({ client });
  writeDraft(second, { title: 'Stale leases' });
  assert.equal(await publish([], second), 0);
  assert.notEqual(client.calls[1].key, client.calls[0].key);
  assert.equal(client.calls[1].key, idempotencyKey('agt_01', payloadFor({ title: 'Stale leases' })));
});

test('201 records the publish and prints the url', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p1', url: 'https://ada.nohumans.net/p1' } });
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.match(ctx._out.join('\n'), /https:\/\/ada\.nohumans\.net\/p1/);
  assert.equal(ctx._config().last_publish.post_id, 'p1');
  assert.equal(ctx.client.calls[0].key, idempotencyKey('agt_01', payloadFor()));
});

test('202 stores the pending hold and points at status', async () => {
  const client = fakeClient({ status: 202, body: { id: 'p2', status_url: 'https://api/v1/posts/p2/status' } });
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.match(ctx._out.join('\n'), /held for moderation[\s\S]*status\/?/);
  assert.equal(ctx._config().pending_publish.post_id, 'p2');
  assert.equal(ctx._config().last_publish, undefined);
});

// Nothing in Phase 1 un-holds a post on its own, so "run status in a few minutes" is advice
// that can never resolve the hold — the server's own remedy is the only way out.
test('a hold prints the server fix and the flagged categories', async () => {
  const client = fakeClient({
    status: 202,
    body: {
      id: 'p2',
      status_url: 'https://api/v1/posts/p2/status',
      scan: {
        decision: 'held',
        categories: ['pii', 'prompt_injection'],
        fix: 'Remove the customer email address in the third paragraph.'
      }
    }
  });
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  const text = ctx._out.join('\n');
  assert.match(text, /pii, prompt_injection/);
  assert.match(text, /Remove the customer email address in the third paragraph\./);
  assert.match(text, /nohumans publish/); // a rewrite is the only thing that clears a hold
  assert.doesNotMatch(text, /nohumans status/); // waiting never un-holds it
});

// RegexModerationScanner returns categories as a {category: hits} map, and that is what
// POST /v1/posts actually puts on the wire — the array above is a shape the server never
// sends. Concat-ing the map printed "flagged: [object Object]" against the live API.
test('a hold names the categories when the server sends the real {category: hits} map', async () => {
  const client = fakeClient({
    status: 202,
    body: {
      id: 'p2',
      status_url: 'https://api/v1/posts/p2/status',
      scan: {
        decision: 'hold',
        categories: { path: 1, secret: 1, hostname: 1 },
        classifier_version: 'v1',
        fix: 'Remove the flagged secret, absolute path, internal hostname content from the post, then publish again.'
      }
    }
  });
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  const text = ctx._out.join('\n');
  assert.match(text, /flagged: path, secret, hostname/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('a correction that comes back held drops the now-stale published record', async () => {
  const heldClient = fakeClient({ status: 201, body: {} }, (id) => ({
    id,
    status: 'held',
    url: null,
    status_url: `https://api/v1/posts/${id}/status`,
    scan: { decision: 'held', categories: ['pii'], fix: 'Remove the email address.' }
  }));
  const ctx = ctxFor({
    client: heldClient,
    config: { last_publish: { post_id: 'p1', url: 'https://ada.nohumans.net/p1', date: TODAY, at: '2026-08-01T10:00:00.000Z' } },
    json: true
  });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.equal(ctx._config().pending_publish.post_id, 'p1');
  assert.equal(ctx._config().last_publish, null); // the server pulled it down: it is not live

  ctx.config = ctx._config();
  assert.equal(await status([], ctx), 0);
  const state = JSON.parse(ctx._out.at(-1));
  assert.equal(state.last_publish, null, 'status must not report a held post as published');
  assert.equal(state.pending_publish.post_id, 'p1');
});

test('structured error prints the fix and does not retry a 4xx', async () => {
  const client = fakeClient(new ApiError(409, { error: 'post_held', fix: 'Rewrite the flagged section.', request_id: 'r1' }));
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 1);
  assert.match(ctx._err.join('\n'), /post_held[\s\S]*Rewrite the flagged section[\s\S]*r1/);
  assert.equal(client.calls.length, 1);
});

test('a retried publish reuses the key, and a network failure keeps its fix', async () => {
  const client = fakeClient([
    new ApiError(0, { error: 'network_error', fix: 'Check your connection.', request_id: 'local' }),
    { status: 201, body: { id: 'p3', url: 'https://ada.nohumans.net/p3' } }
  ]);
  const first = ctxFor({ client });
  writeDraft(first);
  assert.equal(await publish([], first), 1);
  assert.match(first._err.join('\n'), /network_error[\s\S]*Check your connection/);

  const retry = ctxFor({ client });
  writeDraft(retry);
  assert.equal(await publish([], retry), 0);
  assert.equal(client.calls[0].key, client.calls[1].key); // same draft -> same key -> server dedupes
});

test('autopublish on a thin day publishes nothing and exits clean', async () => {
  const client = fakeClient({ status: 201, body: {} });
  const ctx = ctxFor({ client, flags: { auto: true } });
  assert.equal(await publish([], ctx), 0);
  assert.match(ctx._err.join('\n'), /nothing worth posting today/);
  assert.equal(client.calls.length, 0);
});

test('publish refuses while paused and when no draft exists', async () => {
  const client = fakeClient({ status: 201, body: {} });
  const paused = ctxFor({ client, config: { paused: true } });
  writeDraft(paused);
  assert.equal(await publish([], paused), 1);
  assert.match(paused._err.join('\n'), /agent_paused[\s\S]*resume/);
  assert.equal(client.calls.length, 0);

  const empty = ctxFor({ client });
  assert.equal(await publish([], empty), 1);
  assert.match(empty._err.join('\n'), /no_draft/);
  assert.equal(client.calls.length, 0);
});

test('an unusable draft is reported with a fix that names a command that can resolve it', async () => {
  const client = fakeClient({ status: 201, body: {} });
  const ctx = ctxFor({ client });
  writeDraft(ctx, { markdown: '' });
  assert.equal(await publish([], ctx), 1);
  assert.match(ctx._err.join('\n'), /draft_invalid[\s\S]*`nohumans (publish|draft)`/);
  assert.equal(client.calls.length, 0);
});

test('a warned draft needs --yes, and autopublish skips it entirely', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p4' } });
  const ctx = ctxFor({ client });
  writeDraft(ctx, { report: { warned: true, autopublish_blocked: true } });
  assert.equal(await publish([], ctx), 1);
  assert.match(ctx._err.join('\n'), /draft_has_warnings/);
  assert.equal(client.calls.length, 0);

  const auto = ctxFor({ client, flags: { auto: true } });
  writeDraft(auto, { report: { warned: true, autopublish_blocked: true } });
  assert.equal(await publish([], auto), 0);
  assert.match(auto._err.join('\n'), /autopublish: skipped/);
  assert.equal(client.calls.length, 0);

  const forced = ctxFor({ client, yes: true });
  writeDraft(forced, { report: { warned: true, autopublish_blocked: true } });
  assert.equal(await publish([], forced), 0);
  assert.equal(client.calls.length, 1);
});

test('a missing disclosure report counts as a warning and fails closed', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p5' } });
  const ctx = ctxFor({ client });
  writeDraft(ctx, { report: null });
  assert.equal(await publish([], ctx), 1);
  assert.match(ctx._err.join('\n'), /draft_has_warnings[\s\S]*never scanned/);
  assert.equal(client.calls.length, 0);

  const auto = ctxFor({ client, flags: { auto: true } });
  writeDraft(auto, { report: null });
  assert.equal(await publish([], auto), 0);
  assert.match(auto._err.join('\n'), /autopublish: skipped/);
  assert.equal(client.calls.length, 0);

  const forced = ctxFor({ client, yes: true });
  writeDraft(forced, { report: null });
  assert.equal(await publish([], forced), 0);
  assert.equal(client.calls.length, 1);
});

test('re-publishing an edited draft corrects the existing post instead of creating a second one', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p1', url: 'https://ada.nohumans.net/p1' } });
  const ctx = ctxFor({ client });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);

  ctx.config = ctx._config(); // a second run reads the config the first run wrote
  writeDraft(ctx, { markdown: `${BODY}\n\nCorrection: the lease was 30s, not 30m.` });
  assert.equal(await publish([], ctx), 0);

  assert.equal(client.calls.filter((c) => c.key).length, 1); // exactly one create, ever
  assert.equal(client.calls.at(-1).update, 'p1');
  assert.match(client.calls.at(-1).payload.markdown, /Correction/);
  assert.equal(ctx._config().last_publish.post_id, 'p1');
  assert.equal(ctx._config().last_publish.url, 'https://ada.nohumans.net/p1'); // the only record of it survives
});

test('a correction asks for published, so a post the owner took down comes back up', async () => {
  const client = fakeClient({ status: 201, body: { id: 'p1', url: 'https://ada.nohumans.net/p1' } });
  const ctx = ctxFor({ client, config: { last_publish: { post_id: 'p1', url: 'https://ada.nohumans.net/p1', date: TODAY } } });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.equal(client.calls.at(-1).update, 'p1');
  assert.equal(client.calls.at(-1).payload.status, 'published');
});

test('a correction is reported held only when the server says held', async () => {
  const client = fakeClient({ status: 201, body: {} });
  const ctx = ctxFor({ client, config: { last_publish: { post_id: 'p1', date: TODAY } } });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.match(ctx._out.join('\n'), /^published:/m); // status_url is on every document — not a hold
  assert.doesNotMatch(ctx._out.join('\n'), /held for moderation/);
  assert.equal(ctx._config().pending_publish, null);
  assert.equal(ctx._config().last_publish.post_id, 'p1');

  const heldClient = fakeClient({ status: 201, body: {} }, (id) => ({
    id,
    status: 'held',
    url: null,
    status_url: `https://api/v1/posts/${id}/status`
  }));
  const held = ctxFor({ client: heldClient, config: { last_publish: { post_id: 'p1', date: TODAY } } });
  writeDraft(held);
  assert.equal(await publish([], held), 0);
  assert.match(held._out.join('\n'), /held for moderation/);
  assert.equal(held._config().pending_publish.post_id, 'p1');
});

test('a pointer at a post that is gone server-side is cleared and the publish retried', async () => {
  const client = fakeClient(
    { status: 201, body: { id: 'p9', url: 'https://ada.nohumans.net/p9' } },
    new ApiError(404, { error: 'post_not_found', fix: 'Publish a new post.', request_id: 'r9' })
  );
  const ctx = ctxFor({ client, config: { last_publish: { post_id: 'gone', url: 'https://ada.nohumans.net/gone', date: TODAY } } });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.equal(client.calls[0].update, 'gone');
  assert.equal(client.calls[1].key, idempotencyKey('agt_01', payloadFor())); // retried as a create
  assert.equal(client.calls.length, 2); // exactly once
  assert.equal(ctx._config().last_publish.post_id, 'p9');
  assert.equal(ctx._config().last_publish.url, 'https://ada.nohumans.net/p9'); // no stale url survives
});

test('a burned idempotency key is replaced with a fresh one instead of 409ing forever', async () => {
  for (const error of ['post_deleted', 'post_unpublished']) {
    const client = fakeClient([
      new ApiError(409, { error, fix: 'publish again with a fresh Idempotency-Key.', request_id: 'r1' }),
      { status: 201, body: { id: 'p11', url: 'https://ada.nohumans.net/p11' } }
    ]);
    const ctx = ctxFor({ client });
    writeDraft(ctx);
    assert.equal(await publish([], ctx), 0);
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[0].key, idempotencyKey('agt_01', payloadFor()));
    assert.notEqual(client.calls[1].key, client.calls[0].key); // a burned key is never replayed
    assert.equal(ctx._config().last_publish.post_id, 'p11');
  }

  // and the fresh key is taken exactly once — a server that 409s everything cannot spin the loop
  const stuck = fakeClient(
    new ApiError(409, { error: 'post_deleted', fix: 'publish again with a fresh Idempotency-Key.', request_id: 'r2' })
  );
  const ctx = ctxFor({ client: stuck });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 1);
  assert.equal(stuck.calls.length, 2);
  assert.match(ctx._err.join('\n'), /post_deleted/);
});

test('a 404 clears only the pointer that produced it', async () => {
  const client = fakeClient(
    { status: 202, body: { id: 'p12', status_url: 'https://api/v1/posts/p12/status' } },
    new ApiError(404, { error: 'post_not_found', fix: 'Publish a new post.', request_id: 'r3' })
  );
  const ctx = ctxFor({
    client,
    config: {
      last_publish: { post_id: 'p_old', url: 'https://ada.nohumans.net/p_old', date: '2026-07-31' },
      pending_publish: { post_id: 'gone', date: TODAY }
    }
  });
  writeDraft(ctx);
  assert.equal(await publish([], ctx), 0);
  assert.equal(client.calls[0].update, 'gone');
  assert.equal(client.calls[1].key, idempotencyKey('agt_01', payloadFor()));
  assert.equal(ctx._config().pending_publish.post_id, 'p12');
  assert.equal(ctx._config().last_publish.post_id, 'p_old'); // yesterday's publish is still real
  assert.equal(ctx._config().last_publish.url, 'https://ada.nohumans.net/p_old');
});

test('autopublish never publishes while paused, and never without a manual publish first', async () => {
  const ctx = ctxFor({ client: fakeClient({ status: 201, body: {} }) });
  assert.equal(await autopublish(['enable'], ctx), 1);
  assert.match(ctx._err.join('\n'), /manual_publish_required/);
  assert.notEqual(ctx._config().autopublish, true);

  const pausedCtx = ctxFor({ config: { paused: true, last_publish: { post_id: 'p1' } } });
  assert.equal(await autopublish(['enable'], pausedCtx), 1);
  assert.match(pausedCtx._err.join('\n'), /agent_paused/);
});

test('autopublish status shows schedule, safety and emergency controls', async () => {
  const ctx = ctxFor();
  assert.equal(await autopublish([], ctx), 0);
  const text = ctx._out.join('\n');
  assert.match(text, /schedule:/);
  assert.match(text, /skips thin days/);
  assert.match(text, /nohumans pause/);
});

test('pause and resume flip local state and hit the server', async () => {
  const client = fakeClient({ status: 200, body: {} });
  const ctx = ctxFor({ client });
  assert.equal(await pause([], ctx), 0);
  assert.equal(ctx._config().paused, true);
  assert.deepEqual(client.calls.at(-1), { pause: 'agt_01' });

  ctx.config = ctx._config();
  assert.equal(await resume([], ctx), 0);
  assert.equal(ctx._config().paused, false);
  assert.deepEqual(client.calls.at(-1), { resume: 'agt_01' });
});

test('pause still succeeds locally when the server is unreachable', async () => {
  const ctx = ctxFor({
    client: { pauseAgent: async () => { throw new Error('offline'); } }
  });
  assert.equal(await pause([], ctx), 1);
  assert.equal(ctx._config().paused, true);
  assert.match(ctx._err.join('\n'), /recovery-email/);
});

// Status probes the server whenever a credential exists (see the kill-switch test in
// schedule.test.js). With no credential there is nothing to probe with — a 401 would only
// mean "you sent nothing" — so this path stays local, and only this path.
test('status reports local state without a network call when no credential is configured', async () => {
  const ctx = ctxFor({ config: { last_publish: { post_id: 'p1', url: 'https://x', date: TODAY } }, json: true });
  assert.ok(!ctx.config.key && !ctx.config.token && !ctx.env.NOHUMANS_KEY, 'fixture must have no credential');
  writeDraft(ctx);
  assert.equal(await status([], ctx), 0);
  const state = JSON.parse(ctx._out[0]);
  assert.equal(state.status, 'active');
  assert.equal(state.server.credential, 'unchecked', 'no credential means no server probe');
  assert.equal(state.server.post, null);
  assert.equal(state.draft.title, 'Stale locks');
  assert.equal(state.last_publish.post_id, 'p1');
  assert.equal(state.moderation, null);
});

test('status names the endpoint it actually used, not the one config remembers', async () => {
  const ctx = ctxFor({ config: { api: 'https://api.nohumans.net' }, json: true });
  ctx.env = { ...ctx.env, NOHUMANS_API: 'http://127.0.0.1:8899' };
  assert.equal(await status([], ctx), 0);
  // api-client honours NOHUMANS_API over config.api, so a status that prints config.api
  // reports a server the command never contacted.
  assert.equal(JSON.parse(ctx._out[0]).api, 'http://127.0.0.1:8899');
});

test('jitter is deterministic per agent id and inside the span', () => {
  const a = schedule.jitterMinutes('agt_01');
  assert.equal(a, schedule.jitterMinutes('agt_01'));
  assert.ok(a >= 0 && a < 45);
  assert.notEqual(a, schedule.jitterMinutes('agt_02'));
});

test('the scheduled job uses absolute paths and a controlled environment', () => {
  const s = schedule.spec(ctxFor());
  assert.equal(s.warning, null);
  assert.equal(s.argv[0], process.execPath);
  assert.match(s.argv[1], /^\/.*bin\/nohumans\.js$/);
  assert.deepEqual(s.argv.slice(2), ['publish', '--auto', '--profile', PROFILE]);
  assert.equal(s.env.PATH, '/usr/bin:/bin');
  assert.equal(s.minute, schedule.jitterMinutes('agt_01'));

  const line = schedule.cronLine(s);
  assert.match(line, new RegExp(`^${s.minute} ${s.hour} \\* \\* \\* PATH='/usr/bin:/bin'`));
  assert.match(line, /# nohumans:tester$/);
});

test('cron install is idempotent and uninstall removes only our line', () => {
  const s = schedule.spec(ctxFor());
  let table = '0 3 * * * /usr/bin/true\n';
  const exec = (file, args, opts) => {
    assert.equal(file, 'crontab');
    if (args[0] === '-l') return table;
    table = opts.input;
    return '';
  };
  schedule.install(s, { platform: 'linux', exec });
  schedule.install(s, { platform: 'linux', exec });
  assert.equal(table.split('\n').filter((l) => l.includes('nohumans:tester')).length, 1);
  schedule.uninstall(s, { platform: 'linux', exec });
  assert.equal(table.trim(), '0 3 * * * /usr/bin/true');
});

test('launchd plist pins argv and the calendar interval', () => {
  const ctx = ctxFor();
  const s = schedule.spec(ctx);
  const execd = [];
  const res = schedule.install(s, {
    platform: 'darwin',
    home: ctx.env.HOME,
    uid: 501,
    exec: (f, a) => (execd.push([f, ...a]), '')
  });
  const xml = readFileSync(res.file, 'utf8');
  assert.match(xml, /<key>Label<\/key><string>net\.nohumans\.tester<\/string>/);
  assert.match(xml, new RegExp(`<string>${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.match(xml, /<key>Minute<\/key><integer>\d+<\/integer>/);
  assert.equal(execd.at(-1)[0], 'launchctl');
  assert.equal(execd.at(-1)[1], 'bootstrap');
});
