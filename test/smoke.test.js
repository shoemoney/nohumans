import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, COMMANDS } from '../src/cli.js';
import { readConfig, writeConfig } from '../src/config.js';
import { journalFile, localDate } from '../src/paths.js';
import { cronLine } from '../src/schedule.js';
import { cliPath, installAgentsMd } from '../src/integrations.js';

// mkdtemp: unique per process, so parallel test runs never share a sandbox.
const env = { NOHUMANS_HOME: mkdtempSync(join(tmpdir(), 'nohumans-')) };

test('every command module exports run() and is dispatchable', async () => {
  for (const name of COMMANDS) {
    const mod = await import(`../src/commands/${name}.js`);
    assert.equal(typeof mod.run, 'function', `${name} must export run()`);
    assert.equal(mod.run.length <= 2, true, `${name} must take (args, ctx)`);
  }
});

test('unknown command exits 1, --help exits 0', async () => {
  const noop = () => {};
  assert.equal(await main(['definitely-not-a-command'], { out: noop, err: noop }), 1);
  assert.equal(await main(['--help', 'journal'], { out: noop, err: noop }), 0);
  assert.equal(await main(['--help'], { out: noop, err: noop }), 0);
  assert.equal(await main([], { out: noop, err: noop }), 1);
});

test('journal path is profile-aware and date-stamped', () => {
  assert.match(journalFile(new Date(), 'ada', env), /profiles\/ada\/journal\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('a journal entry that starts with - or -- reaches the command intact', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nohumans-argv-'));
  const previous = process.env.NOHUMANS_HOME;
  process.env.NOHUMANS_HOME = home;
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s) };
  try {
    assert.equal(await main(['journal', '-- shipped the arg parser', '- and tested it'], io), 0);
    const written = readFileSync(journalFile(new Date(), 'default', { NOHUMANS_HOME: home }), 'utf8');
    assert.match(written, /-- shipped the arg parser - and tested it/);

    // ...while real flags after the command name still land in ctx.flags.
    lines.length = 0;
    assert.equal(await main(['journal', '--json'], io), 1);
    assert.equal(JSON.parse(lines[0]).error, 'empty_entry');
  } finally {
    if (previous === undefined) delete process.env.NOHUMANS_HOME;
    else process.env.NOHUMANS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('cronLine escapes % so cron cannot truncate the job into stdin', () => {
  const line = cronLine({
    minute: 5,
    hour: 9,
    profile: 'p',
    argv: ['/usr/bin/node', '/opt/cli.js', 'publish', '--auto'],
    env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-100%pure' },
    log: '/tmp/auto%publish.log',
    envFile: '/tmp/auto%publish.env'
  });
  assert.equal(/(^|[^\\])%/.test(line), false, `unescaped % truncates the cron job: ${line}`);
  // Every % on the line is escaped — including the ones in the paths cron actually reads.
  assert.match(line, /auto\\%publish\.log/);
  assert.match(line, /auto\\%publish\.env/);
  // ...and the credential is not on the line at all: a crontab command line is readable by
  // every local user via `ps`. It is sourced at run time from the 0600 env file instead.
  assert.doesNotMatch(line, /sk-100/, `credentials belong in the 0600 env file, not the command line: ${line}`);
  assert.match(line, /^\d+ \d+ \* \* \* \. '\/tmp\/auto\\%publish\.env'; /);
});

test('AGENTS.md documents the bare command, never local absolute paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nohumans-proj-'));
  try {
    assert.equal(installAgentsMd({ cwd }).status, 'installed');
    const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.match(text, /^nohumans journal "/m);
    // AGENTS.md is repo-tracked: pinning these publishes the human's home and username.
    assert.equal(text.includes(process.execPath), false, 'must not pin the node path');
    assert.equal(text.includes(cliPath()), false, 'must not pin the CLI path');
    assert.equal(text.includes(homedir()), false, 'must not leak the home directory');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('config round-trips and is written owner-only', () => {
  const file = writeConfig({ ...readConfig('ada', env), agent: 'ada' }, 'ada', env);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readConfig('ada', env).agent, 'ada');
  assert.equal(readConfig('ada', env).api, 'https://api.nohumans.net');
});
