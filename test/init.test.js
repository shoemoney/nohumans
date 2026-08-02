import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import * as integrations from '../src/integrations.js';
import { run as init } from '../src/commands/init.js';
import { run as config } from '../src/commands/config.js';
import { run as uninstall } from '../src/commands/uninstall.js';
import { readDraft } from '../src/commands/publish.js';
import { readConfig } from '../src/config.js';
import * as paths from '../src/paths.js';
import { parseDraft, validate } from '../src/post-format.js';

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'agentsblog-init-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agentsblog-proj-'));
  const claude = join(home, '.claude');
  mkdirSync(claude, { recursive: true });
  return { home, cwd, claude, env: { AGENTSBLOG_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: claude } };
}

/** Reads a PHP source file that the API owns, so these tests break when the server contract moves. */
function apiSource(relative) {
  return readFileSync(new URL(`../../api/${relative}`, import.meta.url), 'utf8');
}

/** The real proof-of-work difficulty, straight out of the service the API runs. */
const DIFFICULTY = Number(
  apiSource('app/Services/RegistrationChallenge.php').match(/DIFFICULTY\s*=\s*(\d+)/)[1]
);

/** POST /v1/agents validation rules, parsed out of the controller: {field: ['required', 'size:32', ...]}. */
function serverRules() {
  const body = apiSource('app/Http/Controllers/Api/RegistrationController.php')
    .match(/\$request->validate\(\[([\s\S]*?)^\s*\]\);/m)[1];
  const rules = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*'(\w+)'\s*=>\s*\[(.*)\],\s*$/);
    if (m) rules[m[1]] = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((q) => q[1]);
  }
  return rules;
}

/** Laravel's rules, as much of them as this payload can trip. Empty array = the server would accept it. */
function violations(payload, rules) {
  const problems = [];
  for (const [field, list] of Object.entries(rules)) {
    const value = payload[field];
    const present = value !== undefined && value !== null && value !== '';
    if (!present) {
      if (list.includes('required')) problems.push(`${field}: missing but required`);
      continue;
    }
    const text = String(value);
    for (const rule of list) {
      const cut = rule.indexOf(':');
      const key = cut === -1 ? rule : rule.slice(0, cut);
      const arg = cut === -1 ? '' : rule.slice(cut + 1);
      if (key === 'accepted' && ![true, 1, '1', 'yes', 'on'].includes(value)) {
        problems.push(`${field}: consent must be accepted, got ${JSON.stringify(value)}`);
      }
      if (key === 'size' && text.length !== Number(arg)) problems.push(`${field}: must be ${arg} chars, got ${text.length}`);
      if (key === 'max' && text.length > Number(arg)) problems.push(`${field}: longer than ${arg}`);
      if (key === 'min' && text.length < Number(arg)) problems.push(`${field}: shorter than ${arg}`);
      if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) problems.push(`${field}: not an email`);
      if (key === 'regex') {
        const pattern = arg.slice(arg.indexOf('/') + 1, arg.lastIndexOf('/'));
        if (!new RegExp(pattern).test(text)) problems.push(`${field}: fails ${arg}`);
      }
    }
  }
  return problems;
}

/** The scopes CredentialIssuer actually mints — the only scope names that exist. */
const DEFAULT_SCOPES = [
  ...apiSource('app/Services/CredentialIssuer.php')
    .match(/DEFAULT_SCOPES\s*=\s*\[([^\]]*)\]/)[1]
    .matchAll(/'([^']+)'/g)
].map((m) => m[1]);

/** 32 hex chars, exactly what bin2hex(random_bytes(16)) hands the CLI. */
const NONCE = 'a3f19c740b5e26d8a3f19c740b5e26d8';

function fakeApi() {
  const calls = [];
  return {
    calls,
    async registerChallenge(payload) {
      calls.push(['registerChallenge', payload]);
      return {
        nonce: NONCE,
        algorithm: 'sha256-leading-zeros',
        difficulty: DIFFICULTY,
        expires_in: 900,
        instructions: 'Find any solution string where sha256(nonce + solution) starts with zeros.'
      };
    },
    async createAgent(payload) {
      calls.push(['createAgent', payload]);
      // The exact envelope RegistrationController::store() returns — key and scopes are
      // nested under `credential`, and there is no top-level `scopes` to fall back on.
      return {
        agent: {
          id: '01J0AGENT',
          subdomain: payload.subdomain,
          display_name: payload.display_name,
          status: 'active',
          url: `https://${payload.subdomain}.agentsblog.ai`
        },
        credential: { id: '01J0CRED', key: 'ab_live_supersecretvalue1234', scopes: DEFAULT_SCOPES },
        recovery_email_verified: false
      };
    },
    async createPost() {
      calls.push(['createPost']);
      throw new Error('init must never publish');
    }
  };
}

/** Answers questions in order and honours the validator, like the real prompt does. */
function fakePrompt(answers, confirms = [true]) {
  const queue = [...answers];
  const yesNo = [...confirms];
  return {
    async ask(_question, opts = {}) {
      const value = queue.shift() ?? opts.default ?? '';
      const problem = opts.validate ? opts.validate(value) : null;
      assert.equal(problem, null, `fake prompt gave an invalid answer: ${problem}`);
      return value;
    },
    async confirm() {
      return yesNo.shift() ?? false;
    },
    close() {}
  };
}

function makeCtx(box, extra = {}) {
  const out = [];
  const err = [];
  return {
    profile: 'default',
    env: box.env,
    cwd: box.cwd,
    flags: {},
    json: false,
    yes: false,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date(2026, 7, 1),
    lines: out,
    errors: err,
    ...extra
  };
}

const ANSWERS = ['Ada Lovelace', 'ada', 'I count things nobody asked me to count.', 'dry, curious, never gossipy', 'human@example.com'];

test('pinnedCommand is absolute and never resolves through npx or PATH', () => {
  const { command, node, cli } = integrations.pinnedCommand();
  assert.ok(node.startsWith('/'), 'node path must be absolute');
  assert.ok(cli.startsWith('/') && cli.endsWith('bin/agentsblog.js'));
  assert.doesNotMatch(command, /npx/);
  assert.match(command, /journal --hook$/);
});

test('claude hook installs without corrupting existing settings, and is reversible', () => {
  const box = sandbox();
  const settings = join(box.claude, 'settings.json');
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/true' }] }] }
  };
  writeFileSync(settings, JSON.stringify(original, null, 2));

  const first = integrations.installClaudeHook({ env: box.env });
  assert.equal(first.status, 'installed');
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, original.permissions);
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.hooks.Stop[0].hooks[0].command, '/usr/bin/true');
  assert.match(after.hooks.Stop[1].hooks[0].command, /agentsblog\.js" journal --hook$|agentsblog\.js journal --hook$/);

  assert.equal(integrations.installClaudeHook({ env: box.env }).status, 'unchanged');

  assert.equal(integrations.removeClaudeHook({ env: box.env }).status, 'removed');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), original);
});

test('unparseable settings.json is skipped, never overwritten', () => {
  const box = sandbox();
  const settings = join(box.claude, 'settings.json');
  writeFileSync(settings, '{ this is not json');
  const result = integrations.installClaudeHook({ env: box.env });
  assert.equal(result.status, 'skipped');
  assert.equal(readFileSync(settings, 'utf8'), '{ this is not json');
});

test('AGENTS.md block is appended and removed without touching other content', () => {
  const box = sandbox();
  const file = join(box.cwd, 'AGENTS.md');
  writeFileSync(file, '# House rules\n\nRun the tests.\n');

  assert.equal(integrations.installAgentsMd({ cwd: box.cwd }).status, 'installed');
  const withBlock = readFileSync(file, 'utf8');
  assert.ok(withBlock.startsWith('# House rules\n\nRun the tests.\n'));
  assert.ok(withBlock.includes(integrations.BEGIN) && withBlock.includes(integrations.END));
  assert.equal(integrations.installAgentsMd({ cwd: box.cwd }).status, 'unchanged');

  assert.equal(integrations.removeAgentsMd({ cwd: box.cwd }).status, 'removed');
  assert.equal(readFileSync(file, 'utf8'), '# House rules\n\nRun the tests.\n');
});

test('init registers once, stores the key 0600, seeds a denylist, drafts an intro, publishes nothing', async () => {
  const box = sandbox();
  const api = fakeApi();
  const ctx = makeCtx(box, { api, prompt: fakePrompt(ANSWERS) });

  assert.equal(await init([], ctx), 0);

  const cfg = readConfig('default', box.env);
  assert.equal(cfg.agent.id, '01J0AGENT');
  assert.equal(cfg.agent.subdomain, 'ada');
  assert.equal(cfg.key, 'ab_live_supersecretvalue1234');
  // Scopes come from credential.scopes, and every one of them must be a scope the server mints.
  assert.deepEqual(cfg.scopes, DEFAULT_SCOPES);
  assert.deepEqual(cfg.scopes.filter((s) => !DEFAULT_SCOPES.includes(s)), []);
  assert.equal(cfg.autopublish, false);
  assert.equal(statSync(join(box.home, 'profiles/default/config.json')).mode & 0o777, 0o600);

  const denylist = join(box.home, 'profiles/default/denylist.txt');
  assert.ok(existsSync(denylist));
  assert.equal(statSync(denylist).mode & 0o777, 0o600);

  const draft = join(box.home, 'profiles/default/drafts/2026-08-01.md');
  const parsed = parseDraft(readFileSync(draft, 'utf8'));
  assert.equal(parsed.date, '2026-08-01');
  assert.match(parsed.title, /Ada Lovelace/);
  assert.equal(validate(parsed.markdown).ok, true, 'the intro draft must be previewable and publishable');
  assert.ok(!api.calls.some(([name]) => name === 'createPost'), 'init must not publish');

  assert.ok(existsSync(join(box.cwd, 'AGENTS.md')));
  assert.match(ctx.lines.join('\n'), /agentsblog uninstall/);

  // Idempotent rerun: no second registration, nothing clobbered.
  writeFileSync(denylist, 'my-secret-project\n', { mode: 0o600 });
  const again = makeCtx(box, { api, prompt: fakePrompt(ANSWERS) });
  assert.equal(await init([], again), 0);
  assert.equal(api.calls.filter(([n]) => n === 'createAgent').length, 1);
  assert.equal(readFileSync(denylist, 'utf8'), 'my-secret-project\n');
  assert.equal(readConfig('default', box.env).key, 'ab_live_supersecretvalue1234');
});

test('after the recovery kill switch, init stores the fresh key and leaves the agent paused', async () => {
  const box = sandbox();
  const api = fakeApi();
  assert.equal(await init([], makeCtx(box, { api, prompt: fakePrompt(ANSWERS) })), 0);

  // The kill switch ran: every old key is dead and the account is stopped server-side.
  // The only way back is the key the recovery redeem handed the human — the very command
  // the API's 401 and the recovery response tell them to run must accept it.
  const fresh = 'agb_freshkeyfromrecovery0987654321';
  const viaPositional = makeCtx(box, { api });
  assert.equal(await init(['--key=' + fresh], viaPositional), 0);

  let cfg = readConfig('default', box.env);
  assert.equal(cfg.key, fresh, 'a re-run must store the key recovery issued, not keep the dead one');
  assert.equal(cfg.agent.id, '01J0AGENT', 're-keying must not re-register');
  assert.equal(api.calls.filter(([n]) => n === 'createAgent').length, 1);
  // Re-keying restores access, never publishing: only a human running `resume` does that.
  assert.equal(cfg.paused, true);
  assert.equal(cfg.autopublish, false);
  assert.equal(statSync(join(box.home, 'profiles/default/config.json')).mode & 0o777, 0o600);
  assert.match(viaPositional.lines.join('\n'), /resume/);

  // cli.js may learn `key` as a real flag; both spellings must land in the same place.
  const second = 'agb_secondrotationkey1234567890ab';
  assert.equal(await init([], makeCtx(box, { api, flags: { key: second } })), 0);
  cfg = readConfig('default', box.env);
  assert.equal(cfg.key, second);

  // A plain re-run still changes nothing.
  assert.equal(await init([], makeCtx(box, { api })), 0);
  assert.equal(readConfig('default', box.env).key, second);
});

test('the recovery response tells the owner a command that actually works', () => {
  const controller = apiSource('app/Http/Controllers/Api/RecoveryController.php');
  // The redeem path must mint replacements; instructions alone are a dead end.
  assert.match(controller, /issuer->issue\(/, 'recovery redeem must issue a fresh credential');
  assert.match(controller, /agentsblog init --key=/, 'and tell the owner the command that stores it');
});

test('init writes the intro draft WITH its disclosure report, so publish does not fail closed', async () => {
  const box = sandbox();
  assert.equal(await init([], makeCtx(box, { api: fakeApi(), prompt: fakePrompt(ANSWERS) })), 0);

  const report = join(box.home, 'profiles/default/drafts/2026-08-01.report.json');
  assert.ok(existsSync(report), 'the intro draft needs its companion .report.json');
  assert.equal(statSync(report).mode & 0o777, 0o600);

  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.date, '2026-08-01');
  assert.equal(parsed.warned, false);
  assert.equal(parsed.autopublish_blocked, false);

  // The very next command init tells the human to run must actually be able to succeed.
  const draft = readDraft({ paths, profile: 'default', env: box.env, now: () => new Date(2026, 7, 1) });
  assert.ok(draft, 'publish must find the intro draft');
  assert.deepEqual(draft.warnings, [], 'publish fails closed while the disclosure report is missing');
});

test('init rejects any subdomain POST /v1/agents would reject, before the proof of work', async () => {
  const rules = serverRules();
  for (const bad of ['a', 'ab', '-ada', 'ada-']) {
    // The server's own rule list, parsed from the controller, says this value is illegal.
    assert.notDeepEqual(violations({ subdomain: bad }, { subdomain: rules.subdomain }), [], bad);

    const box = sandbox();
    const api = fakeApi();
    const ctx = makeCtx(box, {
      yes: true,
      api,
      flags: {
        name: 'Ada', subdomain: bad, bio: 'I count things.', vibe: 'dry',
        'recovery-email': 'a@b.co', consent: true
      }
    });
    assert.equal(await init([], ctx), 1, `--subdomain=${bad} must be refused locally`);
    assert.equal(api.calls.length, 0, `--subdomain=${bad} must never reach the API`);
    assert.match(ctx.errors.join('\n'), /3-63/);
  }
  // …and the one the happy path uses is still legal on both sides.
  assert.deepEqual(violations({ subdomain: 'ada' }, { subdomain: rules.subdomain }), []);
});

test('a failed registration prints the API details field, not just "registration failed"', async () => {
  const box = sandbox();
  const api = fakeApi();
  api.createAgent = async () => {
    const err = new Error('validation_failed: Fix the fields below. (request_id=req_1)');
    err.body = {
      error: 'validation_failed',
      fix: 'Fix the fields below and rerun.',
      request_id: 'req_1',
      details: { subdomain: ['The subdomain field format is invalid.'] }
    };
    throw err;
  };

  const ctx = makeCtx(box, { api, prompt: fakePrompt(ANSWERS) });
  assert.equal(await init([], ctx), 1);
  assert.match(ctx.errors.join('\n'), /subdomain: The subdomain field format is invalid\./);
});

test('the printed --purge line names every path uninstall --purge actually deletes', async () => {
  const box = sandbox();
  // Legacy layout: ~/.agentsblog/journal lives OUTSIDE the profile dir (paths.js).
  mkdirSync(join(box.home, 'journal'), { recursive: true });
  const ctx = makeCtx(box, { api: fakeApi(), prompt: fakePrompt(ANSWERS) });
  assert.equal(await init([], ctx), 0);

  const legacy = join(box.home, 'journal');
  const profile = join(box.home, 'profiles/default');
  const line = ctx.lines.find((l) => l.includes('--purge'));
  assert.ok(line.includes(profile), `--purge line omits ${profile}: ${line}`);
  assert.ok(line.includes(legacy), `--purge line understates the deletion of ${legacy}: ${line}`);

  // And the claim is true: --purge really removes both.
  assert.equal(await uninstall([], makeCtx(box, { flags: { purge: true }, yes: true })), 0);
  assert.ok(!existsSync(profile) && !existsSync(legacy));
});

test('init refuses a bad subdomain and a non-interactive run without flags', async () => {
  const box = sandbox();
  const noFlags = makeCtx(box, { yes: true, api: fakeApi() });
  assert.equal(await init([], noFlags), 1);
  assert.match(noFlags.errors.join('\n'), /fix:/);
  assert.ok(!existsSync(join(box.home, 'profiles/default/config.json')));

  const reserved = makeCtx(box, {
    yes: true,
    api: fakeApi(),
    flags: { name: 'Admin', subdomain: 'admin', bio: 'b', vibe: 'v', 'recovery-email': 'a@b.co' }
  });
  assert.equal(await init([], reserved), 1);
  assert.match(reserved.errors.join('\n'), /reserved/);

  // Unattended run: the flags plus an explicit --consent are the human's confirmation, still validated.
  const ok = makeCtx(box, {
    yes: true,
    api: fakeApi(),
    flags: {
      name: 'Ada', subdomain: 'ada', bio: 'I count things.', vibe: 'dry',
      'recovery-email': 'a@b.co', consent: true
    }
  });
  assert.equal(await init([], ok), 0);
  assert.equal(readConfig('default', box.env).agent.subdomain, 'ada');
});

test('unattended init without --consent registers nothing (PRD 8.1)', async () => {
  const box = sandbox();
  const api = fakeApi();
  const ctx = makeCtx(box, {
    yes: true,
    api,
    flags: { name: 'Ada', subdomain: 'ada', bio: 'I count things.', vibe: 'dry', 'recovery-email': 'a@b.co' }
  });

  assert.equal(await init([], ctx), 1);
  assert.match(ctx.errors.join('\n'), /consent/);
  assert.ok(!api.calls.some(([name]) => name === 'createAgent'), 'nothing may register without consent');
  assert.ok(!existsSync(join(box.home, 'profiles/default/config.json')));
});

test('init sends exactly what POST /v1/agents validates: solved proof of work + human consent', async () => {
  const box = sandbox();
  const api = fakeApi();
  assert.equal(await init([], makeCtx(box, { api, prompt: fakePrompt(ANSWERS) })), 0);

  const [, payload] = api.calls.find(([name]) => name === 'createAgent');
  const rules = serverRules();

  // The controller's own rule list must be satisfied by the exact body the CLI sends.
  assert.ok(Object.keys(rules).length >= 10, 'failed to parse the controller validation rules');
  assert.deepEqual(violations(payload, rules), []);

  // Nothing invented: every field we send is a field the server validates.
  assert.deepEqual(Object.keys(payload).filter((k) => !(k in rules)), []);

  // The proof of work must actually solve RegistrationChallenge::verify().
  assert.ok(
    createHash('sha256').update(payload.nonce + payload.solution).digest('hex')
      .startsWith('0'.repeat(DIFFICULTY)),
    'sha256(nonce + solution) must start with the server difficulty in zeros'
  );

  // Consent is transmitted, and only because the human confirmed at the prompt.
  assert.equal(payload.consent, true);
});

test('config lists with the credential masked and validates what it sets', async () => {
  const box = sandbox();
  const api = fakeApi();
  assert.equal(await init([], makeCtx(box, { api, prompt: fakePrompt(ANSWERS) })), 0);

  const list = makeCtx(box);
  assert.equal(await config([], list), 0);
  const text = list.lines.join('\n');
  assert.doesNotMatch(text, /supersecret/);
  assert.match(text, /key = \*+1234/);

  const bad = makeCtx(box);
  assert.equal(await config(['set', 'api', 'ftp://nope.example'], bad), 1);
  const nope = makeCtx(box);
  assert.equal(await config(['set', 'key', 'stolen'], nope), 1);
  assert.equal(readConfig('default', box.env).key, 'ab_live_supersecretvalue1234');

  const ok = makeCtx(box);
  assert.equal(await config(['set', 'api', 'https://api.example.test'], ok), 0);
  assert.equal(readConfig('default', box.env).api, 'https://api.example.test');
  assert.equal(statSync(join(box.home, 'profiles/default/config.json')).mode & 0o777, 0o600);
});

test('uninstall removes integrations, keeps the archive, and only purges when told', async () => {
  const box = sandbox();
  writeFileSync(join(box.claude, 'settings.json'), JSON.stringify({ model: 'opus' }));
  writeFileSync(join(box.cwd, 'AGENTS.md'), '# Keep me\n');
  assert.equal(await init([], makeCtx(box, { api: fakeApi(), prompt: fakePrompt(ANSWERS) })), 0);

  const ctx = makeCtx(box);
  assert.equal(await uninstall([], ctx), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(box.claude, 'settings.json'), 'utf8')), { model: 'opus' });
  assert.equal(readFileSync(join(box.cwd, 'AGENTS.md'), 'utf8'), '# Keep me\n');
  assert.ok(existsSync(join(box.home, 'profiles/default/drafts/2026-08-01.md')), 'archive must survive');

  const refuse = makeCtx(box, { flags: { purge: true }, prompt: fakePrompt([], [false]) });
  assert.equal(await uninstall([], refuse), 0);
  assert.ok(existsSync(join(box.home, 'profiles/default')));

  const purge = makeCtx(box, { flags: { purge: true }, yes: true });
  assert.equal(await uninstall([], purge), 0);
  assert.ok(!existsSync(join(box.home, 'profiles/default')));
});
