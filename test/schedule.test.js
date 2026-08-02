import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../src/paths.js';
import { readConfig, writeConfig } from '../src/config.js';
import * as schedule from '../src/schedule.js';
import { run as uninstall } from '../src/commands/uninstall.js';
import { run as autopublish } from '../src/commands/autopublish.js';

const PROFILE = 'tester';

function box({ profile = PROFILE, config = {}, env = {}, flags = {}, yes = false, json = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentsblog-sched-'));
  const full = { AGENTSBLOG_HOME: home, HOME: home, ...env };
  writeConfig({ ...readConfig(profile, full), agent: { id: 'agt_01' }, ...config }, profile, full);
  const out = [];
  const err = [];
  return {
    profile,
    paths,
    env: full,
    cwd: home,
    config: readConfig(profile, full),
    flags,
    json,
    yes,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date(2026, 7, 1, 12, 0, 0),
    _home: home,
    _out: out,
    _err: err,
    _config: () => readConfig(profile, full)
  };
}

/** A fake crontab whose contents survive between exec calls. */
function fakeCrontab(initial = '') {
  const state = { table: initial };
  state.exec = (file, args, opts) => {
    assert.equal(file, 'crontab');
    if (args[0] === '-l') return state.table;
    state.table = opts.input;
    return '';
  };
  return state;
}

test('the scheduled job carries the pinned adapter and only its credentials', () => {
  const bin = mkdtempSync(join(tmpdir(), 'agentsblog-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const ctx = box({
    config: { adapter: 'claude-code' },
    env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-other', AWS_SECRET_ACCESS_KEY: 'nope' }
  });

  const s = schedule.spec(ctx);
  assert.equal(s.adapter.id, 'claude-code');
  assert.equal(s.adapter.exe, join(bin, 'claude'));
  // Without these the job runs with PATH=/usr/bin:/bin, finds no distiller, and never posts.
  assert.ok(s.env.PATH.startsWith(`${bin}:`), `PATH must pin the adapter dir: ${s.env.PATH}`);
  assert.ok(s.env.PATH.endsWith('/usr/bin:/bin'), 'the system path must survive');
  assert.equal(s.env.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.equal(s.env.AGENTSBLOG_ADAPTER, 'claude-code');
  // Still an allowlist, not a copy of the environment.
  assert.equal(s.env.OPENAI_API_KEY, undefined);
  assert.equal(s.env.AWS_SECRET_ACCESS_KEY, undefined);

  // ...and the credential is never echoed back to the terminal.
  const text = schedule.describe(s, 'linux');
  assert.match(text, /distiller:\s+claude-code/);
  assert.doesNotMatch(text, /sk-ant-test/);
});

test('an environment with no distiller keeps the bare controlled env', () => {
  const s = schedule.spec(box({ env: { PATH: '' } }));
  assert.equal(s.adapter, null);
  assert.equal(s.env.PATH, '/usr/bin:/bin');
  assert.equal(s.env.AGENTSBLOG_ADAPTER, undefined);
});

test('one profile never deletes another profile whose name it prefixes', () => {
  const work = schedule.spec(box({ profile: 'work' }));
  const work2 = schedule.spec(box({ profile: 'work2' }));
  const cron = fakeCrontab();

  schedule.install(work2, { platform: 'linux', exec: cron.exec });
  schedule.install(work, { platform: 'linux', exec: cron.exec });
  assert.ok(cron.table.includes('# agentsblog:work2'), 'work2 survives installing work');

  schedule.uninstall(work, { platform: 'linux', exec: cron.exec });
  assert.ok(cron.table.includes('# agentsblog:work2'), 'work2 survives uninstalling work');
  assert.ok(!cron.table.includes('# agentsblog:work\n'), 'work is gone');
});

test('uninstall removes the scheduled job so nothing keeps publishing', async () => {
  const ctx = box({ config: { autopublish: true } });
  const s = schedule.spec(ctx);
  const cron = fakeCrontab('0 3 * * * /usr/bin/true\n');
  schedule.install(s, { platform: 'linux', exec: cron.exec });
  assert.ok(cron.table.includes('# agentsblog:tester'));

  ctx.scheduleOpts = { platform: 'linux', exec: cron.exec };
  assert.equal(await uninstall([], ctx), 0);

  assert.equal(cron.table.trim(), '0 3 * * * /usr/bin/true', 'the autopublish job must be gone');
  assert.match(ctx._out.join('\n'), /autopublish schedule: removed/);
  assert.equal(ctx._config().autopublish, false);
  assert.ok(existsSync(paths.profileDir(PROFILE, ctx.env)), 'the archive must survive');
});

test('purge deletes the legacy journal archive it claims to delete', async () => {
  const ctx = box({ profile: 'default', flags: { purge: true }, yes: true });
  const legacy = join(ctx._home, 'journal');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, '2026-08-01.md'), '- 10:00 something\n');
  assert.equal(paths.journalDir('default', ctx.env), legacy, 'sanity: the legacy path is in use');

  ctx.scheduleOpts = { platform: 'linux', exec: fakeCrontab().exec };
  assert.equal(await uninstall([], ctx), 0);

  const said = ctx._out.join('\n');
  assert.ok(!existsSync(legacy), `claimed deletion did not happen:\n${said}`);
  assert.match(said, new RegExp(`deleted ${legacy}`));
  assert.ok(!existsSync(paths.profileDir('default', ctx.env)));
});

test('enabling never prints the carried credentials', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'agentsblog-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cron = fakeCrontab();
  const ctx = box({
    config: { adapter: 'claude-code', last_publish: { post_id: 'p1', date: '2026-07-31' } },
    env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-ant-test' },
    json: true
  });
  ctx.scheduleOpts = { platform: 'linux', exec: cron.exec };

  assert.equal(await autopublish(['enable'], ctx), 0);

  const said = ctx._out.join('\n');
  // The job itself still needs the key...
  assert.ok(cron.table.includes('sk-ant-test'), 'the installed job must still carry the credential');
  // ...but stdout is terminal scrollback, CI logs, and agent-harness capture.
  assert.doesNotMatch(said, /sk-ant-test/, `the API key was printed to stdout:\n${said}`);
  assert.equal(JSON.parse(said).line, undefined, 'the rendered cron line must not be returned');
  assert.equal(JSON.parse(said).kind, 'cron');
});

test('a scheduler failure is reported without the credentials it choked on', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'agentsblog-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const ctx = box({
    config: { adapter: 'claude-code', last_publish: { post_id: 'p1', date: '2026-07-31' } },
    env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-ant-test' }
  });
  // crontab(1) rejecting the job and quoting it back is exactly how a key reaches stderr.
  ctx.scheduleOpts = {
    platform: 'linux',
    exec: (file, args) => {
      if (args[0] === '-l') return '';
      throw new Error('Command failed: crontab -\nbad minute: 30 9 * * * ANTHROPIC_API_KEY=\'sk-ant-test\' node');
    }
  };

  assert.equal(await autopublish(['enable'], ctx), 1);
  const said = ctx._err.join('\n');
  assert.doesNotMatch(said, /sk-ant-test/, `the API key was printed to stderr:\n${said}`);
  assert.match(said, /\$ANTHROPIC_API_KEY/);
});

test('only the adapter\'s own credential vars ride along, not every CLAUDE_*', () => {
  const bin = mkdtempSync(join(tmpdir(), 'agentsblog-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const s = schedule.spec(box({
    config: { adapter: 'claude-code' },
    env: {
      PATH: bin,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
      CLAUDE_PID: '4242',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_SESSION_ID: 'sess-1',
      ANTHROPIC_LOG: 'debug'
    }
  }));

  assert.equal(s.env.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.equal(s.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test');
  for (const k of ['CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_LOG']) {
    assert.equal(s.env[k], undefined, `${k} is not a credential the job needs`);
  }
});

test('autopublish enable refuses when no distiller can be resolved', async () => {
  const cron = fakeCrontab();
  // Everything else is in order — only the distiller is missing.
  const ctx = box({ config: { last_publish: { post_id: 'p1', date: '2026-07-31' } }, env: { PATH: '' } });
  ctx.scheduleOpts = { platform: 'linux', exec: cron.exec };

  assert.equal(schedule.spec(ctx).adapter, null, 'sanity: no adapter is resolvable');
  assert.equal(await autopublish(['enable'], ctx), 1);

  // The refusal must name the missing distiller, not be smuggled in under the pinning warning.
  assert.match(ctx._err.join('\n'), /no_adapter/);
  assert.match(ctx._err.join('\n'), /config adapter/);
  // Nothing installed, nothing promised: a job here would write nothing, every day, forever.
  assert.ok(!cron.table.includes('agentsblog:'), `a useless job was installed:\n${cron.table}`);
  assert.notEqual(ctx._config().autopublish, true);
});
