import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redact, seedDenylist, scanSummary, MAX_INPUT_BYTES } from '../src/redact.js';

const cats = (r) => Object.fromEntries(r.findings.map((f) => [f.category, f.count]));

test('secrets are replaced, not deleted, and never echoed back', () => {
  const r = redact('deploy key ghp_abcdefghijklmnopqrstuvwxyz012345 then AKIAIOSFODNN7EXAMPLE');
  assert.match(r.text, /deploy key \[redacted:secret\] then \[redacted:secret\]/);
  assert.equal(cats(r).secret, 2);
  assert.equal(JSON.stringify(r.findings).includes('ghp_'), false);
  assert.equal(r.warned, true);
});

test('key=value secrets keep the key so context survives', () => {
  const r = redact('export API_KEY=hunter2isnotgreat\npassword: correcthorse');
  assert.match(r.text, /API_KEY=\[redacted:secret\]/);
  assert.match(r.text, /password: \[redacted:secret\]/);
  assert.equal(r.text.includes('hunter2'), false);
});

test('emails, private hostnames and IPs', () => {
  const r = redact('mailed jer@example.com from db-03.internal at 192.168.1.10 (not 127.0.0.1)');
  assert.match(r.text, /mailed \[redacted:email\] from \[redacted:hostname\] at \[redacted:ip\]/);
  assert.match(r.text, /\(not 127\.0\.0\.1\)/); // loopback identifies nobody
});

test('absolute paths go, relative and URL paths stay', () => {
  const r = redact('ran /Users/jeremy/Projects/secretco/build.sh via https://example.com/a/b and src/index.js');
  assert.match(r.text, /ran \[redacted:path\] via/);
  assert.match(r.text, /https:\/\/example\.com\/a\/b/);
  assert.match(r.text, /src\/index\.js/);
});

test('home-relative and env-var paths are redacted, not suppressed by the ~', () => {
  for (const source of [
    'Fixed the build in ~/Projects/acme-client/api today.',
    'Notes live in $HOME/Projects/acme-client/notes.md now.',
    'Notes live in ${HOME}/Projects/acme-client/notes.md now.',
    'Pulled ~jeremy/src/acme-client/api again.',
    'Copied %USERPROFILE%\\Projects\\acme-client\\keys.txt over.',
    'Copied C:\\Users\\jeremy\\acme-client\\keys.txt over.',
  ]) {
    const r = redact(source);
    assert.equal(r.text.includes('acme-client'), false, source);
    assert.equal(cats(r).path, 1, source);
    assert.equal(r.warned, true, source);
  }
});

test('windows, mixed-separator, UNC and WSL absolute paths are redacted', () => {
  for (const source of [
    'Copied C:/Users/jeremy/Projects/acme-client/keys.txt over.',
    'Copied C:\\Users\\jeremy/Projects/acme-client\\keys.txt over.',
    'Copied \\\\fileserver\\shares\\acme-client\\keys.txt over.',
    'Copied \\\\fileserver\\shares/acme-client/keys.txt over.',
    'Read /mnt/c/Users/jeremy/Projects/acme-client/keys.txt today.',
  ]) {
    const r = redact(source);
    assert.equal(r.text.includes('acme-client'), false, source);
    assert.equal(r.text.includes('jeremy'), false, source);
    assert.equal(cats(r).path, 1, source);
    assert.equal(r.warned, true, source);
  }
});

test('drive-letter rule does not eat URLs, prose or ratios', () => {
  for (const source of [
    'I fixed a subtle Vue hydration-ordering problem.',
    'https://laravel.com/docs/13.x',
    'the ratio was 3:1',
  ]) {
    const r = redact(source);
    assert.equal(r.text, source, source);
    assert.equal(r.warned, false, source);
  }
});

test('repo locations in file://, scp-style remotes and code-host URLs are redacted', () => {
  const file = redact('Tailed file:///Users/jeremy/Projects/acme-client/api.log.');
  assert.equal(file.text.includes('acme-client'), false);

  const remote = redact('Cloned git@github.com:acmeco/private-repo.git this morning.');
  assert.equal(remote.text.includes('private-repo'), false);
  assert.equal(remote.text.includes('acmeco'), false);

  const url = redact('Opened https://github.com/acmeco/private-repo to check it.');
  assert.equal(url.text.includes('private-repo'), false);
  assert.match(url.text, /https:\/\/github\.com\/\[redacted:path\]/); // host kept for context
});

test('code-host references without a scheme are redacted too', () => {
  for (const [source, host] of [
    ['Pushed to github.com/acmeco/private-repo before lunch.', 'github.com/'],
    ['Mirror lives at gitlab.com/acmeco/private-repo now.', 'gitlab.com/'],
    ['Cloned www.bitbucket.org/acmeco/private-repo again.', 'bitbucket.org/'],
  ]) {
    const r = redact(source);
    assert.equal(r.text.includes('private-repo'), false, source);
    assert.equal(r.text.includes('acmeco'), false, source);
    assert.ok(r.text.includes(`${host}[redacted:path]`), source); // host kept, org/repo gone
  }
});

test('private package, registry and internal-host references leak the same way', () => {
  const pkg = redact('Bumped @acmeco/internal-sdk to 2.1.0 today.');
  assert.equal(pkg.text.includes('acmeco'), false);
  assert.equal(pkg.text.includes('internal-sdk'), false);
  assert.match(pkg.text, /Bumped \[redacted:path\] to 2\.1\.0 today\./);

  const ghcr = redact('Pulled ghcr.io/acmeco/private-img:sha-1 to test.');
  assert.equal(ghcr.text.includes('acmeco'), false);
  assert.ok(ghcr.text.includes('ghcr.io/[redacted:path]'));

  const azure = redact('Pushed acmecorp.azurecr.io/team/img to prod.');
  assert.equal(azure.text.includes('acmecorp'), false);
  assert.equal(azure.text.includes('team/img'), false);

  const ecr = redact('Tagged 123456789012.dkr.ecr.us-east-1.amazonaws.com/team/img today.');
  assert.equal(ecr.text.includes('123456789012'), false);
  assert.equal(ecr.text.includes('team/img'), false);

  const internal = redact('Pulled registry.acme.internal/team/img on the box.');
  assert.equal(internal.text.includes('acme'), false);
  assert.equal(internal.text.includes('team/img'), false);
});

test('public scoped packages and bare code-host mentions are not redacted', () => {
  for (const source of [
    'Upgraded @types/node and @vitejs/plugin-vue this week.',
    'We shipped it on github.com',
  ]) {
    const r = redact(source);
    assert.equal(r.text, source);
    assert.equal(r.warned, false);
  }
});

test('ordinary prose survives redaction untouched', () => {
  for (const source of [
    'I fixed a subtle Vue hydration-ordering problem.',
    'It took ~2/3 of the time the first attempt did.',
  ]) {
    const r = redact(source);
    assert.equal(r.text, source);
    assert.equal(r.warned, false);
  }
});

test('high-entropy blobs are caught, long words are not', () => {
  const r = redact('blob dQw4w9WgXcQ1a2B3c4D5e6F7g8H9i0J and internationalization');
  assert.equal(cats(r).entropy, 1);
  assert.match(r.text, /internationalization/);
});

test('denylist matches whole terms, case-insensitively, and skips generic ones', () => {
  const r = redact('Acme shipped it. acmeco too. But the app stayed up.', ['Acme', 'acmeco', 'app']);
  assert.match(r.text, /\[redacted:denylist\] shipped it\. \[redacted:denylist\] too\./);
  assert.match(r.text, /the app stayed up/); // "app" is a stopword: too generic to redact
});

test('malformed and hostile input does not throw', () => {
  assert.equal(redact(null).text, '');
  assert.equal(redact(undefined).findings.length, 0);
  assert.equal(redact(12345).text, '12345');
  assert.equal(redact('a\u200bb\u202ec\u0000d').text, 'abcd'); // zero-width, bidi, NUL stripped
  assert.equal(redact('x', 'not-an-array').warned, false);
  assert.equal(redact('x', [null, 1, 'ab']).warned, false); // junk terms ignored
});

test('oversize input is truncated and flagged', () => {
  const r = redact('a'.repeat(MAX_INPUT_BYTES + 10));
  assert.equal(cats(r).oversize, 1);
  assert.equal(r.warned, true);
  assert.ok(r.text.length <= MAX_INPUT_BYTES + 40);
});

test('redaction is stable: a second run finds nothing new', () => {
  const source = 'jer@example.com pushed /srv/acme/app to 10.0.0.4 with ghp_abcdefghijklmnopqrstuvwxyz012345';
  const once = redact(source, ['acme']);
  const twice = redact(once.text, ['acme']);
  assert.equal(twice.findings.length, 0);
  assert.equal(twice.text, once.text);
  assert.ok(once.passes >= 1 && once.passes <= 3);
});

test('scanSummary is counts only', () => {
  const summary = scanSummary(redact('jer@example.com and ops@example.com'));
  assert.deepEqual(summary.categories, { email: 2 });
  assert.equal(typeof summary.passes, 'number');
  assert.equal(JSON.stringify(summary).includes('example.com'), false);
  assert.deepEqual(scanSummary(undefined), { categories: {}, passes: 1 });
});

test('seedDenylist reads identity without following symlinks or throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsblog-seed-'));
  const home = join(dir, 'home');
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@acmeco/private-tool',
    author: { name: 'Jeremy Example', email: 'jer@example.com' },
  }));
  writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@example.com:acmeco/private-tool.git\n');
  writeFileSync(join(dir, 'secrets.txt'), 'name = Should Not Be Read\n');
  symlinkSync(join(dir, 'secrets.txt'), join(home, '.gitconfig'));

  const terms = await seedDenylist({ env: { HOME: home, USER: 'jeremy' }, cwd: dir });
  assert.ok(terms.includes('jeremy'));
  assert.ok(terms.includes('@acmeco/private-tool'));
  assert.ok(terms.includes('Jeremy Example'));
  assert.ok(terms.some((t) => t.includes('acmeco/private-tool.git')));
  assert.equal(terms.includes('Should Not Be Read'), false); // symlinked gitconfig skipped
  assert.equal(terms.some((t) => t.length < 3), false);

  // Seeds actually redact once fed back in.
  const r = redact('Jeremy Example shipped @acmeco/private-tool today.', terms);
  assert.equal(r.text.includes('Jeremy Example'), false);
  assert.equal(r.text.includes('acmeco'), false);
});

test('seedDenylist survives a missing cwd and empty env', async () => {
  const terms = await seedDenylist({ env: {}, cwd: join(tmpdir(), 'agentsblog-does-not-exist') });
  assert.ok(Array.isArray(terms));
});
