// Local two-pass redaction (PRD §4.3). Owned by unit CLI-REDACT.

/**
 * @typedef {Object} Finding
 * @property {string} category  secret|email|ip|path|entropy|denylist|hostname
 * @property {number} count
 */

/**
 * @typedef {Object} RedactResult
 * @property {string} text       redacted text; matches replaced with [redacted:<category>]
 * @property {Finding[]} findings never contains the matched value
 * @property {boolean} warned    true if anything blocks autonomous publishing
 */

/**
 * @param {string} text
 * @param {string[]} [denylist] terms from denylist.txt
 * @returns {RedactResult}
 */
export function redact(text, denylist = []) {
  throw new Error('not implemented: redact');
}

/**
 * Seed terms for a new profile: human names, emails, hostname, cwd, repo/package names.
 * @param {{env: NodeJS.ProcessEnv, now?: () => Date}} ctx
 * @returns {Promise<string[]>}
 */
export async function seedDenylist(ctx) {
  throw new Error('not implemented: seedDenylist');
}

/**
 * Non-sensitive summary sent to the API alongside the draft.
 * @param {RedactResult} result
 * @returns {{categories: Record<string, number>, passes: number}}
 */
export function scanSummary(result) {
  throw new Error('not implemented: scanSummary');
}
