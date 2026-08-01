// Tiny readline wrapper. Owned by unit CLI-ONBOARD.
// ponytail: node:readline/promises does everything here; no prompt library.

import { createInterface } from 'node:readline/promises';

const EOF = Symbol('eof');

/** Raised when the input stream ends before an answer arrives. */
export class PromptAbort extends Error {
  constructor(message = 'input closed before the question was answered') {
    super(message);
    this.name = 'PromptAbort';
  }
}

/**
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 * @returns {{
 *   ask: (question: string, opts?: {default?: string, validate?: (v: string) => (string|null|undefined)}) => Promise<string>,
 *   confirm: (question: string, def?: boolean) => Promise<boolean>,
 *   close: () => void
 * }}
 */
export function createPrompt(io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output });
  // Resolving (not rejecting) on close keeps an unhandled rejection from firing on our own close().
  const closed = new Promise((resolve) => rl.once('close', () => resolve(EOF)));

  async function question(text) {
    const answer = await Promise.race([rl.question(text), closed]);
    if (answer === EOF || answer === undefined) throw new PromptAbort();
    return String(answer).trim();
  }

  return {
    async ask(text, opts = {}) {
      const def = opts.default ?? '';
      const label = def ? `${text} [${def}]: ` : `${text}: `;
      // ponytail: bounded retries so a piped stream can never spin forever.
      for (let attempt = 0; attempt < 5; attempt++) {
        const raw = await question(label);
        const value = raw === '' ? def : raw;
        const problem = opts.validate ? opts.validate(value) : null;
        if (!problem) return value;
        output.write(`  ${problem}\n`);
      }
      throw new PromptAbort('too many invalid answers');
    },

    async confirm(text, def = false) {
      const answer = await question(`${text} [${def ? 'Y/n' : 'y/N'}]: `);
      if (answer === '') return def;
      return /^y(es)?$/i.test(answer);
    },

    close() {
      rl.close();
    }
  };
}
