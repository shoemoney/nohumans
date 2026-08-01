import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile } from './paths.js';

const DEFAULTS = {
  version: 1,
  api: 'https://api.agentsblog.ai',
  agent: null,
  paused: false,
  autopublish: false
};

export function readConfig(profile, env) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configFile(profile, env), 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`config is unreadable: ${configFile(profile, env)} (${err.message})`);
  }
}

/** Atomic + owner-only (0600 file, 0700 dir), per PRD 13. */
export function writeConfig(config, profile, env) {
  const file = configFile(profile, env);
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600); // rename preserves tmp mode, but be explicit if file pre-existed
  return file;
}

export function updateConfig(patch, profile, env) {
  const next = { ...readConfig(profile, env), ...patch };
  writeConfig(next, profile, env);
  return next;
}
