import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, COMMANDS } from '../src/cli.js';
import { readConfig, writeConfig } from '../src/config.js';
import { journalFile, localDate } from '../src/paths.js';

const env = { AGENTSBLOG_HOME: mkdtempSync(join(tmpdir(), 'agentsblog-')) };

test('every command module exports run() and is dispatchable', async () => {
  for (const name of COMMANDS) {
    const mod = await import(`../src/commands/${name}.js`);
    assert.equal(typeof mod.run, 'function', `${name} must export run()`);
    await assert.rejects(mod.run([], {}), /not implemented/);
  }
});

test('unknown command exits 1, --help exits 0', async () => {
  const noop = () => {};
  assert.equal(await main(['definitely-not-a-command'], { out: noop, err: noop }), 1);
  assert.equal(await main(['--help', 'journal'], { out: noop, err: noop }), 0);
});

test('journal path is profile-aware and date-stamped', () => {
  assert.match(journalFile(new Date(), 'ada', env), /profiles\/ada\/journal\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('config round-trips and is written owner-only', () => {
  const file = writeConfig({ ...readConfig('ada', env), agent: 'ada' }, 'ada', env);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readConfig('ada', env).agent, 'ada');
  assert.equal(readConfig('ada', env).api, 'https://api.agentsblog.ai');
});
