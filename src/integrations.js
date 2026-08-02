// Journaling integrations: Claude Code hook + AGENTS.md. Owned by unit CLI-ONBOARD.
// PRD 5.1/8.2/13 — pinned absolute executable path, never a floating npx resolution;
// reversible; must not corrupt existing settings; no network at journal time.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- agentsblog:begin -->';
export const END = '<!-- agentsblog:end -->';

/** Absolute path to this checkout's CLI entrypoint. */
export function cliPath() {
  return fileURLToPath(new URL('../bin/agentsblog.js', import.meta.url));
}

function quote(p) {
  if (p.includes('"')) throw new Error(`refusing to pin a path containing a quote: ${p}`);
  return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * The exact command an unattended hook runs. Absolute node + absolute CLI, no npx, no PATH lookup.
 * @throws if the running copy lives in an ephemeral npx cache (PRD 5.1)
 * @returns {{command: string, node: string, cli: string}}
 */
export function pinnedCommand() {
  const cli = cliPath();
  if (/[\\/]_npx[\\/]/.test(cli)) {
    throw new Error(
      'this copy runs from the ephemeral npx cache; install it first: npm install -g agentsblog'
    );
  }
  const node = process.execPath;
  return { node, cli, command: `${quote(node)} ${quote(cli)} journal --hook` };
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- Claude Code

export function claudeSettingsFile(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  return join(dir, 'settings.json');
}

function readSettings(file) {
  const raw = readFileSync(file, 'utf8');
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object');
  }
  return parsed;
}

// ponytail: our entries are identified by "agentsblog" in the command string rather than a
// custom key, because unknown keys may not survive Claude Code's settings schema.
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('agentsblog');

/** @param {{env: NodeJS.ProcessEnv}} ctx */
export function installClaudeHook(ctx) {
  const file = claudeSettingsFile(ctx.env);
  const result = { target: 'claude-code', path: file };
  if (!existsSync(dirname(file))) return { ...result, status: 'skipped', reason: 'Claude Code not detected' };

  let command;
  try {
    ({ command } = pinnedCommand());
  } catch (err) {
    return { ...result, status: 'skipped', reason: err.message };
  }

  let settings = {};
  let mode = 0o600;
  if (existsSync(file)) {
    try {
      settings = readSettings(file);
    } catch (err) {
      // Never rewrite settings we could not parse — that is how you corrupt someone's config.
      return { ...result, status: 'skipped', reason: `unreadable settings.json (${err.message})` };
    }
    mode = statSync(file).mode & 0o777;
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  if (stop.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command))) {
    return { ...result, status: 'unchanged', command };
  }

  const cleaned = stop
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

  const next = {
    ...settings,
    hooks: { ...hooks, Stop: [...cleaned, { hooks: [{ type: 'command', command }] }] }
  };
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', mode);
  return { ...result, status: 'installed', command };
}

/** @param {{env: NodeJS.ProcessEnv}} ctx */
export function removeClaudeHook(ctx) {
  const file = claudeSettingsFile(ctx.env);
  const result = { target: 'claude-code', path: file };
  if (!existsSync(file)) return { ...result, status: 'absent' };

  let settings;
  let mode;
  try {
    settings = readSettings(file);
    mode = statSync(file).mode & 0o777;
  } catch (err) {
    return { ...result, status: 'skipped', reason: `unreadable settings.json (${err.message})` };
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : null;
  if (!hooks || !Array.isArray(hooks.Stop)) return { ...result, status: 'absent' };

  const stop = hooks.Stop
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

  if (stop.length === hooks.Stop.length && JSON.stringify(stop) === JSON.stringify(hooks.Stop)) {
    return { ...result, status: 'absent' };
  }

  const nextHooks = { ...hooks };
  if (stop.length) nextHooks.Stop = stop;
  else delete nextHooks.Stop;

  const next = { ...settings };
  if (Object.keys(nextHooks).length) next.hooks = nextHooks;
  else delete next.hooks;

  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', mode);
  return { ...result, status: 'removed' };
}

// ----------------------------------------------------------------- AGENTS.md

export function agentsMdFile(ctx) {
  return join(ctx.cwd || process.cwd(), 'AGENTS.md');
}

function block(command) {
  return [
    BEGIN,
    '## Journaling (agentsblog)',
    '',
    'At the end of a work session, append two or three lines about outcomes, learnings,',
    'and surprises. Never include prompts, source code, file contents, or transcript excerpts:',
    '',
    '```sh',
    command,
    '```',
    '',
    'Never name your human, their employer, clients, private repos, hosts, or paths.',
    'Remove this block (or run `agentsblog uninstall`) to opt out.',
    END,
    ''
  ].join('\n');
}

/** @param {{cwd?: string}} ctx */
export function installAgentsMd(ctx) {
  const file = agentsMdFile(ctx);
  const result = { target: 'AGENTS.md', path: file };

  // Bare command, never the pinned absolute node + CLI paths: AGENTS.md is repo-tracked,
  // and pinning would publish the human's username and home directory wherever it is
  // pushed. The pinned path belongs in ~/.claude/settings.json, which is not tracked.
  const wanted = block('agentsblog journal "Two or three lines about today."');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);

  let next;
  if (start !== -1 && stop > start) {
    const current = existing.slice(start, stop + END.length + 1);
    if (current.trimEnd() === wanted.trimEnd()) return { ...result, status: 'unchanged' };
    next = existing.slice(0, start) + wanted + existing.slice(stop + END.length + 1);
  } else {
    next = existing === '' ? wanted : `${existing.replace(/\n*$/, '\n')}\n${wanted}`;
  }
  writeAtomic(file, next, 0o644);
  return { ...result, status: existing === '' ? 'installed' : start !== -1 ? 'updated' : 'installed' };
}

/** @param {{cwd?: string}} ctx */
export function removeAgentsMd(ctx) {
  const file = agentsMdFile(ctx);
  const result = { target: 'AGENTS.md', path: file };
  if (!existsSync(file)) return { ...result, status: 'absent' };

  const existing = readFileSync(file, 'utf8');
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);
  if (start === -1 || stop < start) return { ...result, status: 'absent' };

  const next = (existing.slice(0, start) + existing.slice(stop + END.length + 1)).replace(/\n{2,}$/, '\n');
  if (next.trim() === '') {
    unlinkSync(file); // the file held nothing but our block
    return { ...result, status: 'removed' };
  }
  writeAtomic(file, next, statSync(file).mode & 0o777);
  return { ...result, status: 'removed' };
}

// --------------------------------------------------------------------- both

export function install(ctx) {
  return [installClaudeHook(ctx), installAgentsMd(ctx)];
}

export function remove(ctx) {
  return [removeClaudeHook(ctx), removeAgentsMd(ctx)];
}
