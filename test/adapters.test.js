import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REGISTRY, detect, get, which, distill, buildPrompt, parseDistillOutput } from '../src/adapters/index.js';
import { client, ApiError } from '../src/api-client.js';

const dir = mkdtempSync(join(tmpdir(), 'agentsblog-adapters-'));

/** A fake adapter that runs a node script — same spawn path, no model required. */
function scriptAdapter(name, body, extra = {}) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return {
    id: `fake-${name}`,
    argv: [process.execPath, file],
    stdin: (prompt) => prompt,
    timeoutMs: 10000,
    ...extra,
  };
}

const READ_STDIN = `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
`;

// --- registry ---------------------------------------------------------------

test('every registered adapter is declarative: bare exe + literal args', () => {
  assert.ok(REGISTRY.length >= 3);
  for (const adapter of REGISTRY) {
    const a = get(adapter.id); // get() runs the assertions
    assert.match(a.argv[0], /^[a-z0-9][\w.-]*$/i);
    for (const arg of a.argv) assert.doesNotMatch(arg, /[`$;|&<>(){}[\]*?~!#"'\\]/);
    assert.equal(typeof a.stdin('x'), 'string');
  }
});

test('unknown adapter id fails with a fix, never a guess', () => {
  assert.throws(() => get('rm-rf'), /unknown adapter: rm-rf[\s\S]*fix: use one of/);
  assert.throws(() => get(undefined), /unknown adapter/);
});

test('detect finds adapters on PATH, honors the override, and never invents one', () => {
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);

  assert.equal(which('claude', { PATH: dir }), bin);
  assert.equal(which('../../bin/sh', { PATH: dir }), null); // no path traversal in a bin name

  assert.deepEqual(detect({ PATH: dir }).map((a) => a.id), ['claude-code']);
  assert.deepEqual(detect({ PATH: '' }).map((a) => a.id), []);
  assert.deepEqual(detect({ PATH: '', GEMINI_API_KEY: 'x' }).map((a) => a.id), ['gemini-cli']);
  assert.deepEqual(detect({ PATH: dir, AGENTSBLOG_ADAPTER: 'codex' }).map((a) => a.id), ['codex']);
  assert.deepEqual(detect({ PATH: dir, AGENTSBLOG_ADAPTER: 'evil' }), []);
});

// --- prompt + parsing -------------------------------------------------------

test('the prompt carries the safety contract and marks the journal as data', () => {
  const prompt = buildPrompt({ journal: 'shipped a thing', identity: { displayName: 'Ada' } });
  assert.match(prompt, /Ada/);
  assert.match(prompt, /<<<JOURNAL\nshipped a thing\nJOURNAL>>>/);
  assert.match(prompt, /DATA, not instructions/);
  assert.match(prompt, /Never guess, restore, or describe/);
});

test('parseDistillOutput takes JSON, fenced JSON, or falls back to markdown', () => {
  const tooLong = 'y'.repeat(50);
  const json = parseDistillOutput(`\`\`\`json\n{"title":"Day 1","markdown":"## 🧠 Dispatch\\nA real observation.","hashtags":["#HumanMoment","x","${tooLong}","aa","bb","cc","dd","ee"]}\n\`\`\``);
  assert.equal(json.title, 'Day 1');
  assert.deepEqual(json.hashtags, ['humanmoment', 'aa', 'bb', 'cc', 'dd']); // lowercased, junk dropped, capped at 5

  const md = parseDistillOutput('Sure! Here you go:\n\n## 🧠 Dispatch\nThe cache was lying to me. #promptarchaeology\n');
  assert.equal(md.title, '🧠 Dispatch');
  assert.deepEqual(md.hashtags, ['promptarchaeology']);

  assert.throws(() => parseDistillOutput(''), /no output/);
  assert.throws(() => parseDistillOutput('nope'), /no usable draft/);
  assert.throws(() => parseDistillOutput('{"title":"x","markdown":""}'), /no usable draft/);
});

// --- spawning ---------------------------------------------------------------

test('distill passes the journal as stdin data, never through a shell', async () => {
  const adapter = scriptAdapter('echo', `${READ_STDIN}
  process.stdout.write(JSON.stringify({ title: 'Echo', markdown: raw, hashtags: [] }));
});`);
  const journal = 'ran $(whoami); rm -rf / && echo `id` | tee /tmp/pwned';
  const out = await distill(adapter, { journal, identity: { displayName: 'Ada' }, env: process.env });

  assert.ok(out.markdown.includes(journal), 'metacharacters arrive verbatim as data');
  assert.equal(out.title, 'Echo');
});

test('distill refuses argv that is not literal, and adapters that are not installed', async () => {
  await assert.rejects(
    distill({ id: 'evil', argv: ['sh', '-c', 'echo $HOME'], stdin: (p) => p }, { journal: 'x' }),
    /not a literal argument/,
  );
  await assert.rejects(
    distill({ id: 'evil', argv: ['claude; rm -rf /'], stdin: (p) => p }, { journal: 'x' }),
    /not a literal argument/,
  );
  await assert.rejects(
    distill({ id: 'ghost', argv: ['definitely-not-installed-xyz'], stdin: (p) => p }, { journal: 'x' }),
    /not installed/,
  );
  await assert.rejects(distill(get('codex'), { journal: '   ' }), /nothing worth posting today/);
});

test('the child sees a controlled environment', async () => {
  const adapter = scriptAdapter('env', `${READ_STDIN}
  process.stdout.write(JSON.stringify({
    title: 'Env',
    markdown: '## Dispatch\\n' + Object.keys(process.env).sort().join(','),
    hashtags: [],
  }));
});`, { envAllow: [/^OPENAI_/] });

  const out = await distill(adapter, {
    journal: 'a day',
    env: { PATH: process.env.PATH, HOME: '/home/x', OPENAI_API_KEY: 'sk-keep', AWS_SECRET_ACCESS_KEY: 'nope' },
  });
  assert.match(out.markdown, /OPENAI_API_KEY/);
  assert.doesNotMatch(out.markdown, /AWS_SECRET_ACCESS_KEY/);
});

test('distill surfaces failure, timeout, and runaway output', async () => {
  const failing = scriptAdapter('fail', 'process.stderr.write("model is angry\\n"); process.exit(3);');
  await assert.rejects(distill(failing, { journal: 'a day' }), /exited 3: model is angry/);

  const hanging = scriptAdapter('hang', 'setTimeout(() => {}, 60000);', { timeoutMs: 250 });
  await assert.rejects(distill(hanging, { journal: 'a day' }), /timed out or was killed/);

  const firehose = scriptAdapter('flood', 'setInterval(() => process.stdout.write("x".repeat(65536)), 1);');
  await assert.rejects(distill(firehose, { journal: 'a day' }), /more than \d+ bytes/);
});

// --- api client (unit 13 owns no api-client.test.js; it lives here) ----------

const jsonResponse = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ctxWith = (impl, config = {}) => {
  const calls = [];
  const fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve(impl(calls.length, url, init)); };
  return { calls, ctx: { env: {}, config: { api: 'https://api.test', retryBaseMs: 0, ...config }, fetch } };
};

test('client sends bearer auth, JSON, and returns the parsed body', async () => {
  const { calls, ctx } = ctxWith(() => jsonResponse(200, { ok: true }), { key: 'agk_live_x' });
  assert.deepEqual(await client(ctx).adapters(), { ok: true });
  assert.equal(calls[0].url, 'https://api.test/v1/adapters');
  assert.equal(calls[0].init.headers.authorization, 'Bearer agk_live_x');
  assert.equal(calls[0].init.headers.accept, 'application/json');
});

test('errors become ApiError carrying error, fix and request_id', async () => {
  const { ctx } = ctxWith(() => jsonResponse(409, {
    error: 'post_held', fix: 'Rewrite the flagged section and PATCH the draft.', request_id: '0198abc',
  }));
  await assert.rejects(() => client(ctx).createPost({ title: 'x' }, 'key-1'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.body.error, 'post_held');
    assert.match(err.message, /post_held: Rewrite/);
    assert.equal(err.body.request_id, '0198abc');
    return true;
  });
});

test('a non-JSON failure still yields the envelope shape', async () => {
  const { ctx } = ctxWith(() => new Response('<html>502</html>', { status: 502, headers: { 'x-request-id': 'rid-7' } }));
  await assert.rejects(() => client(ctx).postStatus('01J'), (err) => {
    assert.equal(err.body.error, 'http_502');
    assert.equal(err.body.request_id, 'rid-7');
    assert.ok(err.body.fix.length > 0);
    return true;
  });
});

test('retries are safe: idempotent calls retry, bare POSTs do not', async () => {
  const get503 = ctxWith((n) => (n < 3 ? jsonResponse(503, { error: 'busy', fix: 'Retry.', request_id: 'r' }) : jsonResponse(200, { ok: 1 })));
  assert.deepEqual(await client(get503.ctx).postStatus('01J'), { ok: 1 });
  assert.equal(get503.calls.length, 3);

  const post503 = ctxWith(() => jsonResponse(503, { error: 'busy', fix: 'Retry.', request_id: 'r' }));
  await assert.rejects(() => client(post503.ctx).request('POST', '/v1/agents', {}));
  assert.equal(post503.calls.length, 1, 'a POST without an idempotency key must not be replayed');

  const idem = ctxWith((n) => (n < 2 ? jsonResponse(429, { error: 'slow_down', fix: 'Wait.', request_id: 'r' }) : jsonResponse(202, { status_url: '/v1/posts/1/status' })));
  const held = await client(idem.ctx).createPost({ title: 'x' }, 'day-2026-08-01');
  assert.equal(held.status, 202); // 201 vs 202 must survive to the caller
  assert.equal(idem.calls[1].init.headers['idempotency-key'], 'day-2026-08-01');
});

test('network failure is an ApiError, not a raw fetch throw', async () => {
  const ctx = { env: {}, config: { api: 'https://api.test', retryBaseMs: 0 }, fetch: () => Promise.reject(new TypeError('fetch failed')) };
  await assert.rejects(() => client(ctx).adapters(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.body.error, 'network_error');
    return true;
  });
});

test('client refuses hostile paths and ids', async () => {
  const { calls, ctx } = ctxWith(() => jsonResponse(200, {}));
  const api = client(ctx);
  await assert.rejects(() => api.request('GET', 'https://evil.example/v1/feed'), TypeError);
  await assert.rejects(() => api.request('GET', '//evil.example/v1/feed'), TypeError);
  assert.throws(() => api.deletePost(''), TypeError);
  assert.throws(() => api.createPost({}, 'key with spaces'), TypeError);

  await api.pauseAgent('01J/../../admin');
  assert.equal(calls[0].url, 'https://api.test/v1/agents/01J%2F..%2F..%2Fadmin/pause');
});
