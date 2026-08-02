// The tarball guard. Runs on `npm test` and again on `npm pack` / `npm publish`
// (package.json "prepack"), so a future change cannot silently start shipping test
// files, fixtures, absolute paths, or a version that drifted out of sync.
//
// ponytail: asks npm itself what it would ship rather than re-implementing the
// ignore rules. `--ignore-scripts` on the inner call is what stops prepack recursing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Directories the tarball may ship, plus the files npm always adds itself. */
const ALLOWED_DIRS = ['bin/', 'src/'];
const ALLOWED_FILES = new Set(['package.json', 'README.md', 'LICENSE']);

function packedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  // npm <=11 prints an array of results; npm 12 prints an object keyed by package name.
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

test('the tarball ships bin/ and src/ and nothing else', () => {
  const { files, entryCount, unpackedSize } = packedFiles();
  assert.ok(entryCount > 0, 'npm pack reported an empty package');

  const stray = files
    .map((f) => f.path)
    .filter((p) => !ALLOWED_FILES.has(p) && !ALLOWED_DIRS.some((d) => p.startsWith(d)));
  assert.deepEqual(stray, [], `these files would ship and should not: ${stray.join(', ')}`);

  const shipped = files.map((f) => f.path);
  assert.ok(shipped.includes('bin/agentsblog.js'), 'the bin is missing from the tarball');
  assert.ok(shipped.includes('README.md'), 'the npm landing page is missing from the tarball');
  assert.ok(unpackedSize < 512 * 1024, `unpacked size ${unpackedSize} looks like something crept in`);
});

test('nothing local, private, or machine-specific ships', () => {
  const home = homedir();
  // Values that must never appear in a published file. Kept literal on purpose:
  // a pattern that matches this file's own source would be a false alarm.
  const forbidden = [
    [home, 'the packaging machine home directory'],
    ['192.168.', 'a private LAN address'],
    ['BEGIN OPENSSH PRIVATE KEY', 'a private key'],
    ['AGENTSBLOG_KEY=', 'a credential assignment']
  ];

  for (const { path } of packedFiles().files) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const [needle, what] of forbidden) {
      assert.ok(!text.includes(needle), `${path} contains ${what}`);
    }
  }
});

test('the bin is executable and the version is not forked across files', () => {
  assert.ok(statSync(join(ROOT, 'bin/agentsblog.js')).mode & 0o111, 'bin/agentsblog.js is not executable');

  // Both strings are hardcoded (no runtime package.json read), so pin them here.
  const cli = readFileSync(join(ROOT, 'src/cli.js'), 'utf8');
  const api = readFileSync(join(ROOT, 'src/api-client.js'), 'utf8');
  assert.ok(cli.includes(`agentsblog ${pkg.version}`), `--version does not print ${pkg.version}`);
  assert.ok(api.includes(`agentsblog-cli/${pkg.version}`), `the user-agent does not say ${pkg.version}`);
});

test('the npm landing page promises nothing that does not work today', () => {
  // npm renders `repository` as a link for every anonymous visitor. The only git host this
  // project has is self-hosted and 404s without a login, so the honest value is no field at all.
  assert.equal(pkg.repository, undefined, 'repository must resolve for an anonymous visitor or be absent');
  assert.ok(
    !JSON.stringify(pkg).includes('git.shoemoney.ai'),
    'package.json points at a host that anonymous visitors cannot open'
  );

  // The package is not on the registry, so the README must not hand anyone an install command
  // that silently fetches something else under this name.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const install = readme.slice(readme.indexOf('## 📦 Install'), readme.indexOf('## ⚡ Quickstart'));
  assert.ok(install.length > 0, 'the README has no Install section');
  assert.ok(/not published/i.test(install), 'the Install section must say the package is not published');
  assert.ok(install.includes('node bin/agentsblog.js'), 'the Install section must give the run-from-source path');

  for (const block of install.match(/```[\s\S]*?```/g) ?? []) {
    assert.ok(!/^\s*(npm i(nstall)?|npx)\b/m.test(block), `Install shows a command that cannot work:\n${block}`);
  }
});

test('the CLI has no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});
