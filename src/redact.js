// Local two-pass redaction (PRD §4.3). Owned by unit CLI-REDACT.
//
// Offline and synchronous except denylist seeding. Matches are REPLACED in place with
// `[redacted:<category>]` so surrounding context survives — a distiller that reads
// "deployed to [redacted:hostname]" still has a sentence to work with, and cannot
// reconstruct what was taken out.

import { hostname, userInfo, homedir } from 'node:os';
import { lstat, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

/**
 * @typedef {Object} Finding
 * @property {string} category  secret|email|ip|path|entropy|denylist|hostname|oversize
 * @property {number} count
 */

/**
 * @typedef {Object} RedactResult
 * @property {string} text       redacted text; matches replaced with [redacted:<category>]
 * @property {Finding[]} findings never contains the matched value
 * @property {boolean} warned    true if anything blocks autonomous publishing
 * @property {number} passes     scan iterations actually run
 */

/** Hard ceiling on scanned text. Journals are notes, not corpora. */
export const MAX_INPUT_BYTES = 256 * 1024;

/** Rerun the rule set until it stops finding things — a replacement can expose a new match. */
const MAX_PASSES = 3;

/** Zero-width + bidi controls: invisible payload, homoglyph and prompt-injection tricks. */
const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const marker = (category) => `[redacted:${category}]`;

/**
 * Ordered rules; `re` must be global. `keep` means capture group 1 is a prefix to
 * preserve, so `password=hunter2` becomes `password=[redacted:secret]`.
 * ponytail: regex heuristics, not a parser. The server scan (PRD §4.3 step 6) is the
 * backstop; tighten a rule when the founding corpus shows a real miss.
 */
const RULES = [
  // --- secrets -------------------------------------------------------------
  { category: 'secret', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { category: 'secret', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { category: 'secret', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { category: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'secret', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { category: 'secret', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { category: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: 'secret', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { category: 'secret', re: /\b(?:hf|xai|dop_v1|glpat|shpat)[-_][A-Za-z0-9_-]{16,}\b/g },
  { category: 'secret', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g }, // JWT
  { category: 'secret', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi }, // credentials in a URL
  { category: 'secret', keep: true, re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g },
  {
    // key = value, in prose or config. The value stops at whitespace or a delimiter.
    category: 'secret',
    keep: true,
    re: /\b((?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|auth[_-]?token|token|password|passwd|pwd|authorization)\b\s*[:=]\s*(?:Bearer\s+)?)['"]?([^\s'",;]{6,})['"]?/gi,
  },

  // --- direct identifiers --------------------------------------------------
  // scp-style git remote (git@host:org/repo.git). Must precede the email rule, which
  // would otherwise eat `git@host` and leave the private `org/repo` behind.
  { category: 'path', re: /\b[\w.-]+@[\w.-]+\.[a-z]{2,}:[\w./+-]+/gi },
  { category: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    category: 'hostname',
    re: /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:local|internal|intranet|lan|corp|home|localdomain)\b/gi,
  },
  { category: 'ip', re: /(?<![\w.v])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w.])/g },
  { category: 'ip', re: /(?<![\w:])(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}(?![\w:])/gi },

  // --- absolute paths ------------------------------------------------------
  // Home-relative paths: `~` STARTS a path, it never suppresses one. Covers ~/x, ~user/x,
  // $HOME/x, ${HOME}/x and %USERPROFILE%\x. `~` before a digit is prose ("~2/3"), not a path.
  { category: 'path', re: /(?<![\w/\\])(?:~(?!\d)[\w.-]*|\$\{?HOME\}?|%USERPROFILE%)(?:[/\\][\w.@+-]+)+[/\\]?/g },
  { category: 'path', re: /\bfile:\/\/[^\s<>"')\]]+/gi },
  // ponytail: only known code/image hosts — a generic org/repo URL rule eats ordinary links.
  // Scheme optional: agents type `github.com/org/private-repo` far more often than the full URL.
  { category: 'path', keep: true, re: /\b((?:https?:\/\/)?(?:www\.|registry\.)?(?:(?:github|gitlab|bitbucket)\.(?:com|org)|ghcr\.io)\/)[\w.-]+\/[\w.-]+/gi },
  // Registries whose HOST is the identifier (org name, AWS account id): keep nothing.
  { category: 'path', re: /\b(?:[a-z0-9][a-z0-9-]*\.azurecr\.io|\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com)(?:\/[\w./-]+)?/gi },
  // npm scoped package: the scope names the org. ponytail: a hand-listed set of public scopes is
  // exempt so ordinary prose survives; add to the list when a common public scope shows up redacted.
  { category: 'path', re: /(?<![\w@./-])@(?!(?:types|babel|vue|angular|aws-sdk|nestjs|eslint|storybook|tailwindcss|vitejs|testing-library|playwright|sentry|octokit|anthropic-ai|openai|modelcontextprotocol)\/)[a-z0-9][\w.-]*\/[\w.-]+/gi },
  // Not preceded by a word char, `:` `/` `~` or `.` — keeps URL paths and a/b/c out.
  { category: 'path', re: /(?<![\w:/~.])(?:\/[\w.@+-]+){2,}\/?/g },
  // Windows drive-letter path, either separator and mixed: C:\Users\x, C:/Users/x, C:\Users/x.
  // The `\b` plus `(?![/\\])` keeps URLs out: a scheme is never a lone letter followed by `://`.
  { category: 'path', re: /\b[A-Za-z]:[/\\](?![/\\])[\w.@+-]*(?:[/\\][\w.@+-]+)*[/\\]?/g },
  // UNC share: \\server\share\... (needs a host AND a share, so a stray `\\` in prose survives).
  { category: 'path', re: /\\\\[\w.-]+(?:[/\\][\w.@+-]+)+[/\\]?/g },
];

/** IPs that identify nobody — redacting them only destroys context. */
const IP_ALLOWLIST = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', '::1']);

/** Seeded terms too generic to redact without shredding every post. */
const SEED_STOPWORDS = new Set([
  'admin', 'agent', 'api', 'app', 'apps', 'bin', 'build', 'cli', 'code', 'core', 'data',
  'dev', 'dist', 'doc', 'docs', 'git', 'home', 'lib', 'local', 'main', 'node', 'null',
  'project', 'projects', 'public', 'repo', 'root', 'src', 'srv', 'temp', 'test', 'tests',
  'tmp', 'user', 'users', 'usr', 'var', 'web', 'www',
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shannon entropy in bits per character. */
function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Random-looking blobs: long, high-entropy, carrying a digit. Real words are not. */
function redactEntropy(text, bump) {
  return text.replace(/[A-Za-z0-9+/=_-]{20,}/g, (m) => {
    if (m.includes('redacted')) return m;
    if (!/\d/.test(m)) return m;
    if (!/[A-Z]/.test(m) && !/[+/=_-]/.test(m)) return m;
    if (entropy(m) < 3.5) return m;
    bump('entropy');
    return marker('entropy');
  });
}

function normalizeInput(text) {
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  s = s.normalize('NFC').replace(INVISIBLE, '').replace(CONTROL, '');
  const oversize = Buffer.byteLength(s, 'utf8') > MAX_INPUT_BYTES;
  if (oversize) {
    s = Buffer.from(s, 'utf8').subarray(0, MAX_INPUT_BYTES).toString('utf8') + `\n${marker('oversize')}\n`;
  }
  return { text: s, oversize };
}

/** Denylist terms → one case-insensitive alternation, longest first. */
function denylistRule(denylist) {
  const terms = [...new Set(
    (Array.isArray(denylist) ? denylist : [])
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !SEED_STOPWORDS.has(t.toLowerCase())),
  )].sort((a, b) => b.length - a.length);

  if (terms.length === 0) return null;
  // No \b: terms may start or end with punctuation (paths, @handles).
  return { category: 'denylist', re: new RegExp(`(?<![\\w-])(?:${terms.map(escapeRe).join('|')})(?![\\w-])`, 'gi') };
}

/**
 * @param {string} text
 * @param {string[]} [denylist] terms from denylist.txt
 * @returns {RedactResult}
 */
export function redact(text, denylist = []) {
  const { text: normalized, oversize } = normalizeInput(text);
  const counts = new Map();
  const bump = (category) => counts.set(category, (counts.get(category) ?? 0) + 1);
  if (oversize) bump('oversize');

  const deny = denylistRule(denylist);
  const rules = [...RULES];
  if (deny) rules.splice(rules.findIndex((r) => r.category !== 'secret'), 0, deny);

  const sum = () => [...counts.values()].reduce((a, b) => a + b, 0);

  let s = normalized;
  let passes = 0;
  let total = sum();

  while (passes < MAX_PASSES) {
    const before = total;
    for (const { category, re, keep } of rules) {
      s = s.replace(re, (m, g1) => {
        if (category === 'ip' && IP_ALLOWLIST.has(m)) return m;
        bump(category);
        return (keep ? g1 : '') + marker(category);
      });
    }
    s = redactEntropy(s, bump);
    passes += 1;
    total = sum();
    if (total === before) break;
  }

  const findings = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  // Anything at all disqualifies a draft from autonomous publishing (PRD §8.3).
  return { text: s, findings, warned: findings.length > 0, passes };
}

/** Read a file only if it is a regular file (never follow a symlink) and small. */
async function readSmallRegularFile(path, max = 64 * 1024) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > max) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function addTerm(set, value) {
  if (typeof value !== 'string') return;
  const term = value.trim();
  if (term.length < 3 || term.length > 200) return;
  if (SEED_STOPWORDS.has(term.toLowerCase())) return;
  set.add(term);
}

/**
 * Seed terms for a new profile: human names, emails, hostname, cwd, repo/package names.
 * Never throws — a missing git config or malformed package.json just yields fewer terms.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, now?: () => Date}} ctx
 * @returns {Promise<string[]>}
 */
export async function seedDenylist(ctx = {}) {
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  const terms = new Set();

  for (const key of ['USER', 'LOGNAME', 'USERNAME', 'EMAIL', 'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    addTerm(terms, env[key]);
  }

  try {
    addTerm(terms, userInfo().username);
  } catch { /* no passwd entry (containers) */ }

  try {
    const host = hostname();
    addTerm(terms, host);
    addTerm(terms, host.split('.')[0]);
  } catch { /* hostname unavailable */ }

  let home = env.HOME || '';
  if (!home) { try { home = homedir(); } catch { home = ''; } }
  addTerm(terms, home);
  addTerm(terms, basename(home));
  addTerm(terms, cwd);
  addTerm(terms, basename(cwd));

  // git identity and remotes, read as files: no spawning, no shell.
  for (const file of [join(home || '.', '.gitconfig'), join(cwd, '.git', 'config')]) {
    const text = await readSmallRegularFile(file);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*(?:name|email|url)\s*=\s*(.+)$/gim)) addTerm(terms, m[1]);
  }

  const pkg = await readSmallRegularFile(join(cwd, 'package.json'), 512 * 1024);
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      addTerm(terms, json.name);
      addTerm(terms, typeof json.author === 'string' ? json.author : json.author?.name);
      addTerm(terms, json.author?.email);
      addTerm(terms, typeof json.repository === 'string' ? json.repository : json.repository?.url);
    } catch { /* malformed package.json is not our problem */ }
  }

  return [...terms].sort();
}

/**
 * Non-sensitive summary sent to the API alongside the draft: counts only, never values.
 * @param {RedactResult} result
 * @returns {{categories: Record<string, number>, passes: number}}
 */
export function scanSummary(result) {
  const categories = {};
  for (const { category, count } of result?.findings ?? []) {
    categories[category] = (categories[category] ?? 0) + count;
  }
  return { categories, passes: result?.passes ?? 1 };
}
