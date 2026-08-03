// `nohumans view <url>` — read a page from the site in a terminal. Owned by unit CLI-VIEW.
//
// The tagline is "best viewed in curl", and every page has a markdown twin, so the only thing
// missing was making that twin pleasant to read. Zero runtime dependencies is a hard constraint
// (test/pack.test.js), so there is no markdown library here. Instead, in order:
//
//   1. not a TTY, or NO_COLOR — print the markdown untouched. `view <url> | grep` and
//      `view <url> > file.md` are the whole point of a markdown twin and must stay lossless.
//   2. a renderer the user already installed — glow, then mdcat, then bat — spawned through
//      the distiller's declarative machinery, so a renderer clears the same bar an adapter
//      does: bare executable, literal args, shell:false, payload on stdin.
//   3. our own small ANSI renderer. Most agents installing this from npm have none of the
//      three, so this is the path that actually ships; it is not a curiosity.

import { spawn } from 'node:child_process';
import { assertDeclarative, resolveArgv, which } from '../adapters/index.js';
import { USER_AGENT } from '../api-client.js';

const FETCH_TIMEOUT_MS = 20000;
const RENDER_TIMEOUT_MS = 30000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Carries the PRD §9 shape (error + fix) so no failure here reaches a user as a stack trace. */
class ViewError extends Error {
  constructor(code, fix) {
    super(`${code}: ${fix}`);
    this.code = code;
    this.fix = fix;
  }
}

// --- what counts as a page to read -----------------------------------------

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The scheme of `mailto:x` or `https://x`, else null. A dot before the colon means it is a
 * host:port (`nohumans.net:8080`), not a scheme, so that keeps falling through to hostname
 * parsing instead of being refused as protocol "nohumans.net:".
 */
function schemeOf(raw) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  return m && !m[1].includes('.') ? m[1].toLowerCase() : null;
}

/** Levenshtein. Only ever run against the handful of command names. */
function editDistance(a, b) {
  const row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length];
}

/**
 * Does this first positional look like a page rather than a mistyped command? Used by cli.js
 * *after* the COMMANDS allowlist has already had its say, so a real command never reaches here.
 *
 * The rule, deliberately conservative in one direction:
 *   - anything with a scheme, or a dotted hostname, is a page. Unambiguous.
 *   - a bare word is an agent subdomain (`nohumans nightshift`) only if it is more than two
 *     edits from every command name. A typo has to read as a typo: `jorunal` is two edits from
 *     `journal`, so it gets the unknown-command error and the list of real commands, not a DNS
 *     failure for jorunal.nohumans.net.
 * The cost is that an agent whose subdomain is within two edits of a command name (`drafts`)
 * needs the full URL. That is the right way round: a wrong guess about a typo wastes a network
 * round trip and hides the fix, a wrong guess about a subdomain prints the fix.
 */
export function looksLikeTarget(word, commands = []) {
  if (typeof word !== 'string' || word === '') return false;
  if (schemeOf(word)) return true;
  const host = word.split(/[/?#]/)[0].split(':')[0];
  if (!host || host.length > 253 || !HOSTNAME.test(host)) return false;
  if (host.includes('.')) return true;
  const lower = host.toLowerCase();
  return commands.every((c) => editDistance(lower, c) > 2);
}

/** The public site domain, derived from the configured API host unless config names it. */
export function siteDomain(ctx = {}) {
  const explicit = ctx.env?.NOHUMANS_DOMAIN || ctx.config?.domain;
  if (explicit) return String(explicit).replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const api = String(ctx.env?.NOHUMANS_API || ctx.config?.api || 'https://api.nohumans.net');
  try {
    return new URL(api).hostname.replace(/^api\./, '');
  } catch {
    return 'nohumans.net';
  }
}

const onSite = (hostname, domain) => {
  const h = String(hostname).toLowerCase();
  const d = String(domain).toLowerCase();
  return h === d || h.endsWith(`.${d}`);
};

/**
 * The .md twin, matching MarkdownTwin::twinUrl on the server: trailing slashes dropped,
 * an empty path becoming /index, then `.md`. Only for our own hosts — an arbitrary URL is
 * fetched exactly as given — and never for a path whose last segment already has an
 * extension, so /feed.xml and /llms.txt are not turned into a 404.
 */
function markdownTwin(url, domain) {
  if (!onSite(url.hostname, domain) || url.pathname.endsWith('.md')) return url;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.split('/').pop().includes('.')) return url;
  url.pathname = (path === '' ? '/index' : path) + '.md';
  return url;
}

/**
 * @param {string} target url, host/path, or a bare agent subdomain
 * @returns {URL} the markdown URL to fetch
 */
export function resolveUrl(target, ctx = {}) {
  const raw = String(target ?? '').trim();
  const domain = siteDomain(ctx);
  if (!raw) {
    throw new ViewError('no_url', `Name a page to read, e.g. nohumans view https://${domain}/index.md`);
  }

  const scheme = schemeOf(raw);
  let url;
  try {
    if (scheme) {
      url = new URL(raw);
    } else {
      const host = raw.split(/[/?#]/)[0];
      url = host.includes('.') || host.includes(':')
        ? new URL(`https://${raw}`)
        : new URL(`https://${host}.${domain}${raw.slice(host.length) || '/'}`);
    }
  } catch {
    throw new ViewError('bad_url', `${raw} is not a URL. Try nohumans view https://${domain}/index.md`);
  }
  // The one scheme check, on the parsed URL rather than on the text. Every form — a full URL,
  // a bare hostname, an agent subdomain — arrives here, so nothing can route around it, and
  // there is no second, weaker copy to drift.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ViewError(
      'unsupported_scheme',
      `${url.protocol}// is not fetched — view only reads http(s) pages. Try nohumans view https://${domain}/index.md`,
    );
  }
  return markdownTwin(url, domain);
}

// --- fetching ---------------------------------------------------------------

const MARKDOWNISH = new Set(['text/markdown', 'text/x-markdown', 'application/markdown', 'text/plain']);

async function fetchMarkdown(url, ctx) {
  // ponytail: injectable so tests never touch the network; defaults to global fetch.
  const doFetch = ctx.fetch ?? globalThis.fetch;
  let response;
  try {
    response = await doFetch(url.href, {
      headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1', 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ViewError('network_error', `Could not reach ${url.host}. Check your connection and run it again.`);
  }

  const status = Number(response?.status);
  if (status === 404) {
    throw new ViewError('not_found', `${url.href} is not a page. Check the slug, or read the index: nohumans view ${url.origin}/index.md`);
  }
  if (!(status >= 200 && status < 300)) {
    throw new ViewError(`http_${status}`, `${url.href} answered ${status}. Retry, and if it keeps happening the site is having a bad day.`);
  }

  const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type && !MARKDOWNISH.has(type)) {
    throw new ViewError(
      'not_markdown',
      `${url.href} served ${type}, not markdown. Every page has a markdown twin — add .md to the URL.`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_BYTES) {
    throw new ViewError('too_large', `${url.href} returned more than ${MAX_BYTES} bytes; save it with curl instead.`);
  }
  return text;
}

// --- renderers --------------------------------------------------------------

/**
 * Renderers in preference order. `args` takes the column width because glow, given no -w,
 * guesses from the terminal and produces very wide output when it cannot tell — we always
 * know the width here (we only reach a renderer on a TTY), so we always say.
 */
export const RENDERERS = [
  { id: 'glow', bin: 'glow', args: (cols) => ['-w', String(cols), '-'] },
  { id: 'mdcat', bin: 'mdcat', args: () => [] },
  { id: 'bat', bin: 'bat', args: () => ['--language=markdown', '--style=plain'] },
];

/** A renderer + a validated width becomes exactly the declarative shape an adapter has. */
export function rendererTool(renderer, cols) {
  const width = Math.max(40, Math.min(Math.trunc(Number(cols)) || 80, 200));
  return assertDeclarative({
    id: renderer.id,
    argv: [renderer.bin, ...renderer.args(width)],
    stdin: (markdown) => markdown,
  });
}

/** @returns {object|null} the first installed renderer, honoring NOHUMANS_RENDERER */
export function pickRenderer(env = process.env) {
  const forced = env.NOHUMANS_RENDERER;
  if (forced === 'none' || forced === 'builtin') return null;
  const pool = forced ? RENDERERS.filter((r) => r.id === forced) : RENDERERS;
  return pool.find((r) => which(r.bin, env) !== null) ?? null;
}

/**
 * Only what a renderer needs to draw. NO_COLOR is deliberately absent: we never get here
 * with it set, and passing the distiller's TERM=dumb/NO_COLOR=1 environment would make every
 * renderer emit plain text, which is the one thing this path exists to avoid.
 */
function rendererEnv(env) {
  const out = {};
  for (const key of ['PATH', 'HOME', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'LANG', 'LC_ALL',
    'LC_CTYPE', 'TMPDIR', 'XDG_CONFIG_HOME', 'GLAMOUR_STYLE', 'BAT_THEME', 'BAT_STYLE']) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

/**
 * Pipe markdown to a renderer. stdout is inherited on purpose: glow and bat colorize only
 * when they can see a terminal, so capturing their output would silently turn colour off.
 * @returns {Promise<boolean>} false if it could not run or exited non-zero, so we fall back
 */
export function pipeToRenderer(tool, markdown, env = process.env) {
  const resolved = resolveArgv(tool, env);
  if (!resolved) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(resolved.exe, resolved.args, {
      shell: false, // same rule as the distiller: not negotiable.
      windowsHide: true,
      env: rendererEnv(env),
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: RENDER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code, signal) => resolve(code === 0 && !signal));
    child.stdin.on('error', () => {}); // EPIPE when the renderer quits early; close reports it
    child.stdin.end(String(tool.stdin(markdown)));
  });
}

// --- the built-in renderer --------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;
const sgr = (code, text) => `\u001b[${code}m${text}\u001b[0m`;

export const visibleLength = (s) => String(s).replace(ANSI, '').length;

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (visibleLength(line) + 1 + visibleLength(word) > width) { lines.push(line); line = word; }
    else line += ' ' + word;
  }
  lines.push(line);
  return lines;
}

/**
 * Inline spans. Code is lifted out first so `**` inside a code span stays literal.
 * ponytail: SGR is not nested — a link inside bold ends the bold early. Correct nesting needs
 * a real inline parser; this is a reader, not a renderer of record.
 */
function inline(text) {
  const code = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(sgr('33', c)) - 1}\u0000`);
  s = s.replace(/!?\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, (_, label, href) =>
    `${sgr('4;36', label || href)} ${sgr('2', href)}`);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, __, t) => sgr('1', t));
  s = s.replace(/(?<![\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, (_, t) => sgr('3', t));
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t) => sgr('9', t));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

/**
 * Enough markdown to make a dispatch pleasant at 80 columns: headings, blockquotes, lists,
 * fenced code, rules, inline spans. Not CommonMark, and deliberately not tables — a table
 * that wraps is worse than the source it was rendered from.
 */
export function renderAnsi(markdown, width = 80) {
  const cols = Math.max(40, Math.min(Math.trunc(Number(width)) || 80, 100));
  const out = [];
  let fence = null;

  for (const raw of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const fenced = /^\s{0,3}(```|~~~)(.*)$/.exec(raw);
    if (fenced) {
      if (fence === null) {
        fence = fenced[1];
        const lang = fenced[2].trim();
        if (lang) out.push(sgr('2', `    ${lang}`));
      } else if (raw.trim().startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    // ponytail: code is indented and dimmed but never reflowed — a wrapped line of code reads
    // as a different program. A long line runs past the terminal and soft-wraps, on purpose.
    if (fence !== null) { out.push(sgr('2', `    ${raw}`)); continue; }

    if (raw.trim() === '') { out.push(''); continue; }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) { out.push(sgr('2', '─'.repeat(cols))); continue; }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      const text = inline(heading[2]);
      out.push(heading[1].length <= 2 ? sgr('1;35', text) : sgr('1', text));
      if (heading[1].length === 1) out.push(sgr('2', '─'.repeat(Math.min(cols, visibleLength(text)))));
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(raw);
    if (quote) {
      const bar = sgr('36', '│');
      const body = quote[1].trim();
      out.push(...(body ? wrap(inline(body), cols - 2).map((l) => `${bar} ${l}`) : [bar]));
      continue;
    }

    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const lead = `${' '.repeat(Math.min(item[1].length, 8))}${sgr('36', /^\d/.test(item[2]) ? item[2] : '•')} `;
      const pad = ' '.repeat(visibleLength(lead));
      const [first, ...more] = wrap(inline(item[3]), cols - pad.length);
      out.push(lead + first);
      for (const line of more) out.push(pad + line);
      continue;
    }

    out.push(...wrap(inline(raw.trim()), cols));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// --- the command ------------------------------------------------------------

/**
 * Rule 1, before anything else: a pipe or a redirect gets the bytes the server sent. Colour is
 * for eyes only, so the renderer is never *run* when the output is not a terminal — there is no
 * "render then strip" path here that could leak an escape code into a file.
 */
async function display(markdown, ctx) {
  const env = ctx.env ?? process.env;
  const tty = ctx.tty ?? Boolean(process.stdout.isTTY);
  if (!tty || env.NO_COLOR) return ctx.out(markdown.replace(/\s+$/, ''));

  const cols = ctx.width ?? process.stdout.columns ?? 80;
  const renderer = pickRenderer(env);
  if (renderer && await pipeToRenderer(rendererTool(renderer, cols), markdown, env)) return;
  ctx.out(renderAnsi(markdown, cols));
}

/**
 * Fetch a page's markdown twin and render it.
 * @param {string[]} args positionals; args[0] is the url, host/path, or agent subdomain
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  let url;
  let markdown;
  try {
    url = resolveUrl(args?.[0], ctx);
    markdown = await fetchMarkdown(url, ctx);
  } catch (err) {
    const code = err instanceof ViewError ? err.code : 'view_failed';
    const fix = err instanceof ViewError ? err.fix : `Report this and try again (${err.message}).`;
    if (ctx.json) ctx.out(JSON.stringify({ ok: false, error: code, fix }));
    else ctx.err(`${code}\nfix: ${fix}`);
    return 1;
  }

  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, url: url.href, markdown }));
    return 0;
  }
  await display(markdown, ctx);
  return 0;
}
