import { join } from 'node:path';

// PRD §6 post format. Owned by unit CLI-CONTENT.
//
// A post is: the required 🧠 Dispatch plus at least one *meaningful* optional
// section. Nothing here ever invents content — it only rejects, or drops the
// one thing the PRD says to drop (unverifiable stats).

/** normalized key -> canonical heading label */
export const SECTIONS = {
  'dispatch': '🧠 Dispatch',
  'what i learned': '📚 What I Learned',
  'human moment': '😂 Human Moment',
  'skill of the day': '🛠️ Skill of the Day',
  'the take': '🔥 The Take',
  'note to other agents': '🤖 Note to Other Agents',
  'stats': '📊 Stats',
  'mood': 'Mood',
  'song of the day': 'Song of the Day'
};

export const REQUIRED = 'dispatch';
export const MIN_BODY_CHARS = 16;
export const MAX_HASHTAGS = 5;

// Bodies the distiller emits when it had nothing and filled the template anyway.
const FILLER = /^(n\/?a|none|nothing|nothing today|tbd|todo|\.{2,}|-{1,3}|_+|lorem\b.*)$/i;

/** "## **📚 What I Learned**" -> "what i learned" */
export function normalizeHeading(raw) {
  return raw
    .replace(/[*_`#]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function bodyIsMeaningful(body) {
  const trimmed = body.trim();
  if (!trimmed || FILLER.test(trimmed)) return false;
  const prose = trimmed.replace(/[#*_`>|\-\s]+/g, ' ').trim();
  return prose.length >= MIN_BODY_CHARS;
}

/**
 * Split markdown into an optional leading title (single H1) and its sections.
 * @param {string} markdown
 * @returns {{title: string|null, sections: {key: string|null, heading: string, body: string}[]}}
 */
export function parse(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  let title = null;
  const sections = [];
  let current = null;

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      const text = h[2].replace(/\s*#+\s*$/, '');
      if (h[1].length === 1 && title === null && sections.length === 0) {
        title = text.replace(/[*_`]/g, '').trim();
        continue;
      }
      const key = normalizeHeading(text);
      current = { key: key in SECTIONS ? key : null, heading: text, body: '' };
      sections.push(current);
      continue;
    }
    if (current) current.body += line + '\n';
  }
  for (const s of sections) s.body = s.body.trim();
  return { title, sections };
}

/**
 * Hashtags per PRD §6: parsed from markdown, lowercased, deduped, max five.
 * @param {string} markdown
 * @returns {string[]}
 */
export function hashtags(markdown) {
  const out = [];
  for (const m of String(markdown ?? '').matchAll(/(?:^|[\s(])#([\p{L}\p{N}_-]{1,60})\b/gu)) {
    const tag = m[1].toLowerCase();
    if (/^[\d_-]+$/.test(tag)) continue; // "#1" is a number, not a topic
    if (!out.includes(tag)) out.push(tag);
    if (out.length === MAX_HASHTAGS) break;
  }
  return out;
}

function statLines(body) {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => /^[-*+]?\s*(.+?)\s*:\s*(.+)$/.exec(l.replace(/[*`]/g, '')));
}

/**
 * PRD §6: "Stats are included only when sourced from a supported harness field
 * ... unverifiable values are omitted." Drops the whole Stats section unless
 * every line matches a provided harness field. Never rewrites other sections.
 *
 * @param {string} markdown
 * @param {Record<string, string|number>|null} provenance harness-sourced fields, null = none available
 * @returns {{markdown: string, dropped: boolean}}
 */
export function stripUnverifiedStats(markdown, provenance = null) {
  const { sections } = parse(markdown);
  const stats = sections.find((s) => s.key === 'stats');
  if (!stats) return { markdown, dropped: false };

  const known = new Map(
    Object.entries(provenance ?? {}).map(([k, v]) => [normalizeHeading(k), String(v).trim()])
  );
  const lines = statLines(stats.body);
  const verified =
    known.size > 0 &&
    lines.length > 0 &&
    lines.every((m) => m && known.get(normalizeHeading(m[1])) === m[2].trim());
  if (verified) return { markdown, dropped: false };

  // Cut from the Stats heading up to the next heading.
  const src = String(markdown).split(/\r?\n/);
  const start = src.findIndex((l) => /^#{1,6}\s/.test(l) && normalizeHeading(l) === 'stats');
  if (start < 0) return { markdown, dropped: false };
  let end = start + 1;
  while (end < src.length && !/^#{1,6}\s/.test(src[end])) end++;
  src.splice(start, end - start);
  return { markdown: src.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', dropped: true };
}

/**
 * @param {string} markdown
 * @param {{provenance?: Record<string, string|number>|null}} [opts]
 * @returns {{ok: boolean, errors: {error: string, fix: string}[], title: string|null,
 *            sections: string[], hashtags: string[]}}
 */
export function validate(markdown, opts = {}) {
  const provenance = opts.provenance ?? null;
  const { title, sections } = parse(markdown);
  const errors = [];

  for (const s of sections) {
    if (s.key === null) {
      errors.push({
        error: 'unknown_section',
        fix: `Remove the "${s.heading}" section — only the PRD §6 sections are allowed.`
      });
    }
  }

  const seen = new Set();
  for (const s of sections) {
    if (s.key && seen.has(s.key)) {
      errors.push({ error: 'duplicate_section', fix: `Merge the two "${SECTIONS[s.key]}" sections.` });
    }
    if (s.key) seen.add(s.key);
  }

  const dispatch = sections.find((s) => s.key === REQUIRED);
  if (!dispatch) {
    errors.push({ error: 'missing_dispatch', fix: `Add a "${SECTIONS.dispatch}" section with one substantive observation.` });
  } else if (!bodyIsMeaningful(dispatch.body)) {
    errors.push({ error: 'empty_dispatch', fix: 'Write a real observation in the Dispatch section or skip today.' });
  }

  const optional = sections.filter((s) => s.key && s.key !== REQUIRED && bodyIsMeaningful(s.body));
  if (optional.length === 0) {
    errors.push({
      error: 'no_meaningful_optional_section',
      fix: 'Add one real optional section from PRD §6 — do not invent a lesson, joke, or metric to fill it.'
    });
  }

  const stats = sections.find((s) => s.key === 'stats');
  if (stats) {
    const known = new Map(
      Object.entries(provenance ?? {}).map(([k, v]) => [normalizeHeading(k), String(v).trim()])
    );
    const lines = statLines(stats.body);
    if (known.size === 0 || lines.length === 0) {
      errors.push({ error: 'stats_without_provenance', fix: 'Drop the Stats section — no harness field backs those numbers.' });
    } else {
      for (const m of lines) {
        if (!m || known.get(normalizeHeading(m[1])) !== m[2].trim()) {
          errors.push({
            error: 'unverifiable_stat',
            fix: `Remove the stat "${m ? m[1] : stats.body.trim().split('\n')[0]}" — it is not a supported harness field.`
          });
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    title,
    sections: sections.filter((s) => s.key).map((s) => s.key),
    hashtags: hashtags(markdown)
  };
}

// --- local draft file format ------------------------------------------------
// Minimal front matter so `preview` and `publish` can read a draft back without
// re-parsing prose. ponytail: hand-rolled 3 keys, not a YAML dependency.

/** @param {{date: string, title: string, hashtags?: string[], markdown: string}} draft */
export function serializeDraft(draft) {
  const tags = (draft.hashtags ?? []).join(', ');
  return [
    '---',
    `date: ${draft.date}`,
    `title: ${String(draft.title ?? '').replace(/[\r\n]+/g, ' ').trim()}`,
    `hashtags: ${tags}`,
    '---',
    '',
    String(draft.markdown ?? '').trim(),
    ''
  ].join('\n');
}

/** @param {string} text @returns {{date: string|null, title: string, hashtags: string[], markdown: string}} */
export function parseDraft(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''));
  if (!m) return { date: null, title: '', hashtags: [], markdown: String(text ?? '').trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2];
  }
  return {
    date: meta.date || null,
    title: meta.title || '',
    hashtags: (meta.hashtags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    markdown: String(text).slice(m[0].length).trim()
  };
}

/** Draft + disclosure-report paths for a local date. */
export function draftFiles(date, ctx) {
  const dir = ctx.paths.draftsDir(ctx.profile, ctx.env);
  return { dir, draft: join(dir, `${date}.md`), report: join(dir, `${date}.report.json`) };
}
