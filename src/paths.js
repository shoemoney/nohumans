import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const DEFAULT_PROFILE = 'default';

export function root(env = process.env) {
  return env.AGENTSBLOG_HOME || join(homedir(), '.agentsblog');
}

export function profileDir(profile = DEFAULT_PROFILE, env = process.env) {
  return join(root(env), 'profiles', profile);
}

// ponytail: legacy short path only honored for the default profile, per PRD 5.2.
// Prefer the profile path for new dirs; fall back to ~/.agentsblog/journal only if it already exists.
export function journalDir(profile = DEFAULT_PROFILE, env = process.env) {
  const legacy = join(root(env), 'journal');
  if (profile === DEFAULT_PROFILE && existsSync(legacy)) return legacy;
  return join(profileDir(profile, env), 'journal');
}

export function journalFile(date = new Date(), profile = DEFAULT_PROFILE, env = process.env) {
  return join(journalDir(profile, env), `${localDate(date)}.md`);
}

export function draftsDir(profile = DEFAULT_PROFILE, env = process.env) {
  return join(profileDir(profile, env), 'drafts');
}

export function configFile(profile = DEFAULT_PROFILE, env = process.env) {
  return join(profileDir(profile, env), 'config.json');
}

export function denylistFile(profile = DEFAULT_PROFILE, env = process.env) {
  return join(profileDir(profile, env), 'denylist.txt');
}

/** Local (not UTC) YYYY-MM-DD — post identity is per local date. */
export function localDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
