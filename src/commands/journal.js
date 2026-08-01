import { mkdirSync, openSync, writeSync, closeSync, existsSync, readFileSync, constants } from 'node:fs';
import { dirname } from 'node:path';

const MAX_CHARS = 1000;
const MAX_LINES = 5;

function stripControl(s) {
  return [...s].filter((c) => {
    const n = c.codePointAt(0);
    return n >= 32 ? n !== 127 : c === '\n' || c === '\t';
  }).join('');
}

function fail(ctx, error, fix) {
  if (ctx.json) ctx.out(JSON.stringify({ ok: false, error, fix }));
  else ctx.err(`${error}\nfix: ${fix}`);
  return 1;
}

/**
 * PRD 8.2 — the Claude Code Stop hook installed by `init` runs `journal --hook`.
 * Its stdin payload is session/transcript/cwd metadata: nothing worth publishing, and
 * exactly the local paths redact.js exists to strip — so it is consumed and dropped,
 * never stored. The hook only nudges, and always exits 0: journaling must never be able
 * to break the harness it is attached to.
 * ponytail: a nudge, not an auto-entry. The payload carries no account of the work;
 * only the agent can write that. Revisit if a hook ever ships a real summary field.
 */
function hookNudge(ctx) {
  try {
    if (!process.stdin.isTTY) readFileSync(0);
  } catch {
    // No stdin, or the writer went away. Either way there was nothing to keep.
  }

  const now = ctx.now ? ctx.now() : new Date();
  if (!existsSync(ctx.paths.journalFile(now, ctx.profile, ctx.env))) {
    ctx.out('agentsblog: nothing journaled today — run: agentsblog journal "two or three lines about what you did".');
  }

  return 0;
}

/**
 * PRD 5.2 — append a 2-3 line entry to today journal file. Local only, no network.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>|number} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  if (ctx.flags?.hook) return hookNudge(ctx);

  // Drop control characters (keep newline/tab): malformed input must not corrupt the file.
  const text = stripControl(args.join(' ')).trim();

  if (!text) {
    return fail(ctx, 'empty_entry', 'Run: agentsblog journal "what happened and what you learned".');
  }
  if (text.length > MAX_CHARS) {
    return fail(ctx, 'entry_too_long', `Summarize in ${MAX_CHARS} characters or fewer — journals hold outcomes, not transcripts.`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > MAX_LINES) {
    return fail(ctx, 'entry_too_long', `Keep the entry to ${MAX_LINES} lines or fewer — journals hold outcomes, not transcripts.`);
  }
  if (/```/.test(text)) {
    return fail(ctx, 'entry_contains_source', 'Remove the code block — journals record what happened, never source, prompts, or file contents.');
  }

  const now = ctx.now ? ctx.now() : new Date();
  const file = ctx.paths.journalFile(now, ctx.profile, ctx.env);
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const entry = `- ${stamp} ${lines.map((l) => l.trim()).join('\n  ')}\n`;

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  // O_APPEND makes concurrent single writes atomic; O_NOFOLLOW refuses a symlinked
  // journal so nothing can redirect entries elsewhere (PRD §13).
  // ponytail: one write per entry, well under PIPE_BUF — no lock file needed.
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err.code === 'ELOOP') {
      return fail(ctx, 'journal_is_symlink', `Remove the symlink at ${file} and retry.`);
    }
    return fail(ctx, 'journal_unwritable', `Fix permissions on ${dirname(file)} and retry (${err.code || err.message}).`);
  }
  try {
    writeSync(fd, entry);
  } finally {
    closeSync(fd);
  }

  const date = ctx.paths.localDate(now);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, file, date }));
  else ctx.out(`journaled to ${file}`);
  return 0;
}
