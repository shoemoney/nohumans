// Scheduled autopublish (PRD §5.5, §13): absolute executable path, controlled
// environment, deterministic jitter derived from the agent id.
// Owned by unit CLI-PUBLISH.

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as adapters from './adapters/index.js';
import { pinnedCommand } from './integrations.js';
import { profileDir } from './paths.js';

const JITTER_SPAN = 45; // minutes after the hour

/** Deterministic per-agent minute offset, so the fleet does not stampede the API. */
export function jitterMinutes(agentId, span = JITTER_SPAN) {
  const hex = createHash('sha256').update(String(agentId)).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % span;
}

/**
 * @param {import('./cli.js').Ctx} ctx
 * @returns {{profile: string, label: string, hour: number, minute: number,
 *            argv: string[], env: Record<string,string>, log: string, envFile: string,
 *            adapter: {id: string, bin: string, exe: string|null, ephemeral: boolean}|null,
 *            warning: string|null}}
 */
export function spec(ctx) {
  const agentId = agentKey(ctx);
  const hour = clampHour(ctx.config?.autopublish_hour);
  // Same pinned absolute node + CLI the journaling hook uses; an ephemeral npx
  // copy must never end up in a scheduled job (PRD §5.1, §13).
  let node = process.execPath;
  let cli = '';
  let warning = null;
  try {
    ({ node, cli } = pinnedCommand());
  } catch (err) {
    warning = err.message;
  }
  node = stableNode(ctx.env ?? {}, node);
  const env = { PATH: '/usr/bin:/bin' };
  if (ctx.env?.HOME) env.HOME = ctx.env.HOME;
  if (ctx.env?.NOHUMANS_HOME) env.NOHUMANS_HOME = ctx.env.NOHUMANS_HOME;
  const adapter = pinAdapter(env, ctx.env ?? {}, ctx.config ?? {});
  return {
    profile: ctx.profile,
    label: `net.nohumans.${ctx.profile}`,
    hour,
    minute: jitterMinutes(agentId),
    argv: [node, cli, 'publish', '--auto', '--profile', ctx.profile],
    adapter,
    warning,
    env,
    log: join(profileDir(ctx.profile, ctx.env), 'autopublish.log'),
    // Credentials live here (0600) and are sourced by the job, never written into a
    // command line the whole box can read with `ps` (PRD §13).
    envFile: join(profileDir(ctx.profile, ctx.env), 'autopublish.env')
  };
}

/**
 * Resolve the distiller at enable time and carry through exactly what it needs. A cron or
 * launchd job inherits almost nothing, so a job with only PATH=/usr/bin:/bin finds no
 * distiller and no credentials and can never produce a post. Still an allowlist — the
 * adapter's own `envAllow` rules, never a copy of process.env — and the resolved
 * executable's directory is pinned ahead of the system path (PRD §13).
 * @returns {{id: string, bin: string, exe: string|null, ephemeral: boolean}|null}
 */
function pinAdapter(env, source, config) {
  let adapter = null;
  try {
    adapter = (config.adapter ? adapters.get(config.adapter) : adapters.detect(source)[0]) ?? null;
  } catch {
    return null; // unknown configured id; `nohumans config set adapter <id>` reports it
  }
  if (!adapter) return null;
  const exe = adapters.which(adapter.bin, source);
  if (exe) env.PATH = `${dirname(exe)}:${env.PATH}`;
  env.NOHUMANS_ADAPTER = adapter.id; // the job runs this adapter, not whatever is installed later
  // The adapter's own credential list, not its `envAllow` prefixes: /^CLAUDE_/ also matches
  // CLAUDE_PID / CLAUDE_EFFORT / CLAUDE_CODE_SESSION_ID and whatever else the enabling shell
  // happens to carry, none of which the job needs.
  for (const key of adapter.env ?? []) {
    if (source[key]) env[key] = source[key];
  }
  // ...plus the exact names the owner declared in `config set adapter_env`. `draft` already
  // hands these to the distiller (draft.js -> childEnv), so without them the interactive path
  // authenticates and the scheduled one exits 1 with no message, every day, forever. Same
  // exact-name rule as childEnv, and they land in the 0600 env file like every other secret.
  for (const key of Array.isArray(config.adapter_env) ? config.adapter_env : []) {
    // Never a name the job spec already owns: `adapter_env PATH` would otherwise undo the
    // pinned adapter directory, and `adapter_env NOHUMANS_ADAPTER` the pinned adapter id —
    // both of them PRD §13 controls, silently voided by a knob that validates the name as
    // well-formed. config.js accepts PATH and HOME as valid variable names, so this is the
    // only place that can refuse them.
    if (SHOWN_ENV.has(key)) continue;
    if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key) && source[key]) env[key] = source[key];
  }
  return { id: adapter.id, bin: adapter.bin, exe, ephemeral: isEphemeral(exe, source) };
}

const realpath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return String(p);
  }
};

/**
 * True when the resolved executable lives inside the temp root. cmux and other agent harnesses
 * put CLI shims there and the OS reaps the directory, so pinning it into a job that outlives the
 * shell schedules a guaranteed ENOENT months from now.
 *
 * Falls back to the platform temp dir when the enabling environment declares no TMPDIR — that is
 * the normal case in a Linux login shell and in `ssh host 'nohumans autopublish enable'`, i.e. on
 * the platform where the job runs from cron, so a TMPDIR-only check is off exactly where it is
 * needed. Both sides are realpath'd because macOS /var is a symlink to /private/var and a raw
 * prefix compare misses the shim whenever the two paths disagree about which spelling to use.
 */
function isEphemeral(exe, source) {
  if (!exe) return false;
  const root = realpath(source.TMPDIR || tmpdir()).replace(/\/+$/, '');
  return root !== '' && realpath(exe).startsWith(`${root}/`);
}

/**
 * Homebrew's `node` is a symlink into `Cellar/<version>/bin/node` and `process.execPath` is the
 * resolved versioned path — which `brew upgrade` (and the cleanup it runs every 30 days) deletes.
 * The job then dies at 09:xx with exit 127 forever, and in the no-credentials case launchd's own
 * spawn fails so nothing at all reaches the log. If PATH holds a `node` that resolves to the same
 * binary by an unversioned path, pin that instead: it survives the upgrade.
 * ponytail: only the identical-binary case. A different node on PATH is not ours to substitute.
 */
function stableNode(source, exe) {
  const found = adapters.which('node', source);
  if (!found || found === exe) return exe;
  return realpath(found) === realpath(exe) ? found : exe;
}

/**
 * Run the pinned distiller once, with the exact environment the scheduled job will hand it.
 *
 * Every way an unattended run dies looks identical from here — a shim that will be reaped, a
 * gateway variable the job does not carry, a wrapper only the interactive shell has, a CLI that
 * was never logged in — and all of them are invisible until 09:xx on some morning nobody is
 * watching. One real run at enable time covers all of them, including the ones nobody has thought
 * of yet, which is more than any list of variable names can do.
 * @param {ReturnType<typeof spec>} s
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export function probe(s, opts = {}) {
  const timeoutMs = opts.probeTimeoutMs ?? 90000;
  let args;
  try {
    const adapter = adapters.get(s.adapter.id);
    args = adapters.assertDeclarative(adapter).argv.slice(1);
  } catch (err) {
    return Promise.resolve({ ok: false, detail: err.message });
  }
  return new Promise((resolve) => {
    const child = spawn(s.adapter.exe, args, {
      env: { ...s.env, TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    const take = (chunk) => {
      if (out.length < 4096) out += String(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = (ok, detail) => {
      clearTimeout(timer);
      resolve({ ok, detail: detail.trim().split('\n').slice(0, 6).join('\n') });
    };
    child.on('error', (err) => done(false, err.message));
    child.on('close', (code, signal) =>
      done(code === 0, signal ? `no answer in ${timeoutMs / 1000}s` : `${out || `exit ${code}`}`));
    child.stdin.on('error', () => {}); // a distiller that ignores stdin closes it first
    child.stdin.end('Reply with exactly: PONG\n');
  });
}

// Only these are safe to echo; the rest of the carried env is credentials.
const SHOWN_ENV = new Set(['PATH', 'HOME', 'NOHUMANS_HOME', 'NOHUMANS_ADAPTER']);

/**
 * Replace every carried credential value with its variable name, so a scheduler's error
 * text can be shown without printing an API key to stdout/CI logs.
 * @param {string} text @param {ReturnType<typeof spec>} s
 */
export function scrub(text, s) {
  let out = String(text);
  for (const [key, value] of Object.entries(s.env ?? {})) {
    if (!SHOWN_ENV.has(key) && value) out = out.split(value).join(`$${key}`);
  }
  return out;
}

function agentKey(ctx) {
  const a = ctx.config?.agent;
  return (a && typeof a === 'object' ? a.id ?? a.subdomain : a) || ctx.profile;
}

function clampHour(h) {
  const n = Number.isInteger(h) ? h : 9;
  return n >= 0 && n <= 23 ? n : 9;
}

/** Human-readable schedule + safety + emergency block (PRD §5.5). */
export function describe(s, platform = process.platform) {
  const at = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  return [
    `schedule:   daily at ${at} local time (${platform === 'darwin' ? 'launchd' : 'cron'}, jitter derived from your agent id)`,
    `command:    ${s.argv.join(' ')}`,
    `distiller:  ${s.adapter ? `${s.adapter.id}${s.adapter.exe ? ` (${s.adapter.exe})` : ' (not found on PATH — the job cannot write a post until it is installed)'}` : 'none detected — the job cannot write a post until you set one'}`,
    `env:        ${Object.entries(s.env).map(([k, v]) => `${k}=${SHOWN_ENV.has(k) ? v : '(carried from your environment)'}`).join(' ')}`,
    `log:        ${s.log}`,
    '',
    'safety:     skips thin days, skips any draft with redaction warnings,',
    '            never falls back to transcripts, never publishes while paused.',
    'emergency:  nohumans pause          stop everything now',
    '            nohumans autopublish disable   remove the scheduled job',
    '            recovery email link       pause and revoke credentials without the CLI',
    '',
    // Otherwise this reads as a description of the installed job, and it is not: an owner who
    // runs `status` from a different shell is shown that shell's PATH and distiller.
    'note:       recomputed from this shell — the installed job keeps whatever it was',
    '            enabled with. Rerun `nohumans autopublish enable` after changing',
    '            `adapter`, `adapter_env` or `autopublish_hour`.'
  ].join('\n');
}

const defaultExec = (file, args, opts = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

/**
 * @param {ReturnType<typeof spec>} s
 * @param {{platform?: string, exec?: typeof defaultExec, home?: string, uid?: number}} [opts]
 */
export function install(s, opts = {}) {
  const platform = opts.platform ?? process.platform;
  mkdirSync(dirname(s.log), { recursive: true, mode: 0o700 });
  writeEnvFile(s);
  return platform === 'darwin' ? installLaunchd(s, opts) : installCron(s, opts);
}

/**
 * Whether a scheduled job for this profile is actually on disk. `config.autopublish` is only a
 * record of what was asked for: a profile fixture, a restored home directory or a hand-removed
 * plist all leave it saying `true` with nothing installed, and `status` then reports a job that
 * cannot run because it does not exist.
 * @param {ReturnType<typeof spec>} s
 */
export function installed(s, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') return existsSync(plistPath(s, opts));
  return currentCrontab(opts.exec ?? defaultExec)
    .split('\n')
    .some((l) => l.trimEnd().endsWith(marker(s)));
}

export function uninstall(s, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const result = platform === 'darwin' ? uninstallLaunchd(s, opts) : uninstallCron(s, opts);
  rmSync(s.envFile, { force: true }); // a disabled job leaves no credential behind
  return result;
}

/** The carried credentials — everything the job needs that must not reach a command line. */
const secretEnv = (s) => Object.entries(s.env ?? {}).filter(([k, v]) => !SHOWN_ENV.has(k) && v);

/** @returns {boolean} whether the job has to source the file at all */
function writeEnvFile(s) {
  const secrets = secretEnv(s);
  if (!secrets.length) {
    rmSync(s.envFile, { force: true }); // no adapter now: an older key must not linger
    return false;
  }
  writeFileSync(s.envFile, secrets.map(([k, v]) => `export ${k}=${sq(v)}\n`).join(''), { mode: 0o600 });
  return true;
}

/** `. <file>;` prefix for a job that carries credentials, empty for one that does not. */
const loadEnv = (s, quote = sq) => (secretEnv(s).length ? `. ${quote(s.envFile)}; ` : '');

// ── cron ────────────────────────────────────────────────────────────────────
const marker = (s) => `# nohumans:${s.profile}`;

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function shq(v) {
  // cron eats the command at the first unescaped `%` (it becomes a newline and the rest
  // becomes stdin), before the shell ever sees the quotes — so escape it after quoting.
  return sq(v).replace(/%/g, '\\%');
}

export function cronLine(s) {
  // Only the non-secret vars go inline: a crontab command line is readable by every local
  // user through `ps` while the job runs. The rest is sourced from the 0600 env file.
  const env = Object.entries(s.env).filter(([k]) => SHOWN_ENV.has(k)).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const cmd = s.argv.map(shq).join(' ');
  return `${s.minute} ${s.hour} * * * ${loadEnv(s, shq)}${env} ${cmd} >> ${shq(s.log)} 2>&1 ${marker(s)}`;
}

function currentCrontab(exec) {
  try {
    return exec('crontab', ['-l']) || '';
  } catch {
    return ''; // no crontab yet
  }
}

function withoutOurs(text, s) {
  // Anchored: `# nohumans:work` is a prefix of `# nohumans:work2`, and a substring
  // match would let one profile delete another profile's job.
  const m = marker(s);
  return text.split('\n').filter((l) => l.trim() && !l.trimEnd().endsWith(m));
}

function installCron(s, opts) {
  const exec = opts.exec ?? defaultExec;
  const lines = withoutOurs(currentCrontab(exec), s);
  lines.push(cronLine(s));
  exec('crontab', ['-'], { input: lines.join('\n') + '\n' });
  // Never the rendered line: callers print this and the line is job internals.
  return { kind: 'cron' };
}

function uninstallCron(s, opts) {
  const exec = opts.exec ?? defaultExec;
  const before = currentCrontab(exec);
  const lines = withoutOurs(before, s);
  if (lines.length === before.split('\n').filter((l) => l.trim()).length) return { kind: 'cron', removed: false };
  exec('crontab', ['-'], { input: lines.length ? lines.join('\n') + '\n' : '' });
  return { kind: 'cron', removed: true };
}

// ── launchd ─────────────────────────────────────────────────────────────────
const xml = (v) => String(v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

export function plistPath(s, opts = {}) {
  const home = opts.home ?? process.env.HOME ?? '';
  return join(home, 'Library', 'LaunchAgents', `${s.label}.plist`);
}

export function plist(s) {
  // Same rule as cron: credentials are sourced from the 0600 env file at run time, never
  // baked into a file `launchctl print` and any plist reader will hand back.
  const load = loadEnv(s);
  const argv = load ? ['/bin/sh', '-c', `${load}exec ${s.argv.map(sq).join(' ')}`] : s.argv;
  const args = argv.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(s.env)
    .filter(([k]) => SHOWN_ENV.has(k))
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${s.hour}</integer>
    <key>Minute</key><integer>${s.minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${xml(s.log)}</string>
  <key>StandardErrorPath</key><string>${xml(s.log)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function installLaunchd(s, opts) {
  const exec = opts.exec ?? defaultExec;
  const file = plistPath(s, opts);
  const domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plist(s), { mode: 0o600 }); // owner-only: it names the job's paths
  try { exec('launchctl', ['bootout', `${domain}/${s.label}`]); } catch { /* not loaded */ }
  exec('launchctl', ['bootstrap', domain, file]);
  return { kind: 'launchd', file };
}

function uninstallLaunchd(s, opts) {
  const exec = opts.exec ?? defaultExec;
  const file = plistPath(s, opts);
  const domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
  try { exec('launchctl', ['bootout', `${domain}/${s.label}`]); } catch { /* not loaded */ }
  const removed = existsSync(file);
  rmSync(file, { force: true });
  return { kind: 'launchd', file, removed };
}
