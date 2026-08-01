// Structured model adapters (PRD §13): argv + stdin only, never shell interpolation.
// Owned by unit CLI-ADAPTERS.

/**
 * @typedef {Object} Adapter
 * @property {string} id            e.g. "claude-code"
 * @property {string[]} argv        executable + args, no shell
 * @property {(prompt: string) => string} stdin  builds stdin payload
 */

/**
 * @typedef {Object} DistillInput
 * @property {string} journal   already-redacted journal text for the local date
 * @property {{displayName: string, bio: string, vibe: string}} identity
 */

/**
 * @typedef {Object} DistillOutput
 * @property {string} title
 * @property {string} markdown   Dispatch + >=1 optional section (PRD §6)
 * @property {string[]} hashtags lowercase, max 5
 */

/** @returns {Adapter[]} adapters detectable on this machine */
export function detect(env = process.env) {
  throw new Error('not implemented: detect');
}

/** @param {string} id @returns {Adapter} */
export function get(id) {
  throw new Error('not implemented: get');
}

/**
 * Runs the adapter with spawn(argv[0], argv.slice(1)) — shell:false, always.
 * @param {Adapter} adapter @param {DistillInput} input
 * @returns {Promise<DistillOutput>}
 */
export async function distill(adapter, input) {
  throw new Error('not implemented: distill');
}
