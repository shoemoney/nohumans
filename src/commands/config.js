/**
 * PRD 5.1 / 13 — read or set local config values. Writes go through writeConfig, so the file
 * stays owner-only (0600). Secrets are never printed back.
 *
 *   nohumans config                list every value (credential masked)
 *   nohumans config get <key>
 *   nohumans config set <key> <value>
 */

import { REGISTRY } from '../adapters/index.js';
import { readConfig, writeConfig } from '../config.js';
import { normalizeProject } from '../redact.js';
import { configFile } from '../paths.js';

/** Keys a human may set here. `paused` and `autopublish` have their own consent-carrying commands. */
const SETTABLE = {
  api(v) {
    let url;
    try {
      url = new URL(v);
    } catch {
      return { error: 'api must be an absolute URL, e.g. https://api.nohumans.net' };
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !local) return { error: 'api must use https' };
    return { value: url.origin };
  },
  // Shape is not existence: an id `draft` cannot resolve is an unbreakable loop, so the
  // registry is checked here, at the write boundary, and the valid ids are named.
  adapter: (v) => {
    const id = v.trim();
    return REGISTRY.some((a) => a.id === id)
      ? { value: id }
      : { error: `unknown adapter ${id}; valid ids: ${REGISTRY.map((a) => a.id).join(', ')}` };
  },
  // PRD 4.2 — public open-source projects may be named only when the owner enables them.
  // Each entry stops redaction for exactly one reference, so a typo here is not a typo: it is
  // a setting the owner believes is protecting a repo while it silently protects nothing.
  // Rejected loudly at the write boundary, and stored normalized so `redact` and the prompt
  // both compare the same `org/repo`.
  projects: (v) => {
    const entries = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length > 50) {
      return { error: `${entries.length} entries; list at most 50 — the ones the agent actually works on` };
    }
    const refs = [];
    for (const entry of entries) {
      const ref = normalizeProject(entry);
      if (!ref) {
        return {
          error: `${JSON.stringify(entry)} is not a project reference; use owner/name (a https://github.com/owner/name URL, a git@ remote or an @scope/package are accepted and stored as owner/name). An owner on its own enables nothing`
        };
      }
      if (!refs.includes(ref)) refs.push(ref);
    }
    return { value: refs };
  },
  // Extra environment variables the distiller needs, by exact name. Some harnesses authenticate
  // through a gateway or wrapper whose variables the adapter's built-in allowlist does not cover —
  // a Claude Code install fronted by a shim that logs in with AIGATE_* is the case that forced
  // this: `draft` failed with a bare "adapter exited 1" and no way to widen the environment.
  // Exact names only. A prefix or a wildcard would let one careless entry hand the distiller the
  // whole environment, and this list is the one place an owner deliberately widens that boundary.
  adapter_env: (v) => {
    const names = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length > 20) {
      return { error: `${names.length} names; list at most 20 — only what the distiller needs to authenticate` };
    }
    const bad = names.find((n) => !/^[A-Z][A-Z0-9_]*$/.test(n));
    if (bad !== undefined) {
      return {
        error: `${JSON.stringify(bad)} is not an environment variable name; use exact names like AIGATE_TOKEN. Prefixes and wildcards are refused on purpose`
      };
    }
    return { value: [...new Set(names)] };
  },
  // The hour schedule.js builds the autopublish job around; without this the knob is unreachable.
  autopublish_hour: (v) =>
    /^\d{1,2}$/.test(v.trim()) && Number(v) <= 23
      ? { value: Number(v) }
      : { error: 'autopublish_hour must be an hour from 0 to 23 (local time)' }
};

// api-client.js sends `key` OR `token` as the bearer credential, so both must be masked.
// The pattern, not a fixed list, so a credential added later is masked by default.
const isSecret = (key) => /(^|_)(key|token|secret|password|credential)s?($|_)/i.test(key);

function mask(value) {
  const s = String(value);
  return s.length <= 8 ? '********' : `${'*'.repeat(8)}${s.slice(-4)}`;
}

function display(key, value) {
  if (value === undefined) return undefined;
  if (isSecret(key) && value) return mask(value);
  return value;
}

export async function run(args, ctx) {
  const env = ctx.env ?? process.env;
  const [action = 'list', key, ...rest] = args;
  const file = configFile(ctx.profile, env);
  const config = readConfig(ctx.profile, env);

  if (action === 'list' || action === 'get') {
    if (action === 'get' && !key) {
      ctx.err('config get needs a key\nfix: run `nohumans config get api`');
      return 1;
    }
    if (action === 'get') {
      if (!(key in config)) {
        ctx.err(`unknown config key: ${key}\nfix: run \`nohumans config\` to see the keys that exist`);
        return 1;
      }
      const value = display(key, config[key]);
      ctx.out(ctx.json ? JSON.stringify({ [key]: value }) : format(value));
      return 0;
    }
    const shown = Object.fromEntries(Object.keys(config).sort().map((k) => [k, display(k, config[k])]));
    if (ctx.json) {
      ctx.out(JSON.stringify({ file, config: shown }, null, 2));
      return 0;
    }
    ctx.out(file);
    for (const [k, v] of Object.entries(shown)) ctx.out(`  ${k} = ${format(v)}`);
    ctx.out('');
    ctx.out(`settable: ${Object.keys(SETTABLE).join(', ')}`);
    return 0;
  }

  if (action === 'set') {
    const raw = rest.join(' ');
    if (!key || rest.length === 0) {
      ctx.err('config set needs a key and a value\nfix: run `nohumans config set api https://api.nohumans.net`');
      return 1;
    }
    const validate = Object.hasOwn(SETTABLE, key) ? SETTABLE[key] : null;
    if (!validate) {
      ctx.err(
        `${key} is not settable here\nfix: set one of ${Object.keys(SETTABLE).join(', ')} (use pause/resume/autopublish for the rest)`
      );
      return 1;
    }
    const { value, error } = validate(raw);
    if (error) {
      ctx.err(`invalid value for ${key}: ${error}\nfix: rerun with a valid value`);
      return 1;
    }
    writeConfig({ ...config, [key]: value }, ctx.profile, env);
    ctx.out(ctx.json ? JSON.stringify({ [key]: value }) : `${key} = ${format(value)}`);
    return 0;
  }

  ctx.err(`unknown config action: ${action}\nfix: use \`config\`, \`config get <key>\`, or \`config set <key> <value>\``);
  return 1;
}

function format(v) {
  return v === null || typeof v === 'object' ? JSON.stringify(v) : String(v);
}
