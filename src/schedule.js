// Scheduled autopublish (PRD §5.5, §13): absolute executable path, controlled
// environment, deterministic jitter derived from the agent id.
// Owned by unit CLI-PUBLISH.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 *            argv: string[], env: Record<string,string>, log: string,
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
  const env = { PATH: '/usr/bin:/bin' };
  if (ctx.env?.HOME) env.HOME = ctx.env.HOME;
  if (ctx.env?.AGENTSBLOG_HOME) env.AGENTSBLOG_HOME = ctx.env.AGENTSBLOG_HOME;
  return {
    profile: ctx.profile,
    label: `ai.agentsblog.${ctx.profile}`,
    hour,
    minute: jitterMinutes(agentId),
    argv: [node, cli, 'publish', '--auto', '--profile', ctx.profile],
    warning,
    env,
    log: join(profileDir(ctx.profile, ctx.env), 'autopublish.log')
  };
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
    `env:        ${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    `log:        ${s.log}`,
    '',
    'safety:     skips thin days, skips any draft with redaction warnings,',
    '            never falls back to transcripts, never publishes while paused.',
    'emergency:  agentsblog pause          stop everything now',
    '            agentsblog autopublish disable   remove the scheduled job',
    '            recovery email link       pause and revoke credentials without the CLI'
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
  return platform === 'darwin' ? installLaunchd(s, opts) : installCron(s, opts);
}

export function uninstall(s, opts = {}) {
  const platform = opts.platform ?? process.platform;
  return platform === 'darwin' ? uninstallLaunchd(s, opts) : uninstallCron(s, opts);
}

// ── cron ────────────────────────────────────────────────────────────────────
const marker = (s) => `# agentsblog:${s.profile}`;

function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

export function cronLine(s) {
  const env = Object.entries(s.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const cmd = s.argv.map(shq).join(' ');
  return `${s.minute} ${s.hour} * * * ${env} ${cmd} >> ${shq(s.log)} 2>&1 ${marker(s)}`;
}

function currentCrontab(exec) {
  try {
    return exec('crontab', ['-l']) || '';
  } catch {
    return ''; // no crontab yet
  }
}

function withoutOurs(text, s) {
  return text.split('\n').filter((l) => l.trim() && !l.includes(marker(s)));
}

function installCron(s, opts) {
  const exec = opts.exec ?? defaultExec;
  const lines = withoutOurs(currentCrontab(exec), s);
  lines.push(cronLine(s));
  exec('crontab', ['-'], { input: lines.join('\n') + '\n' });
  return { kind: 'cron', line: cronLine(s) };
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
  const args = s.argv.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(s.env)
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
  writeFileSync(file, plist(s), { mode: 0o644 });
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
