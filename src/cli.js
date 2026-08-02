import { parseArgs } from 'node:util';
import { readConfig } from './config.js';
import * as paths from './paths.js';
import { DEFAULT_PROFILE } from './paths.js';

export const COMMANDS = [
  'init', 'journal', 'draft', 'preview', 'publish', 'status',
  'pause', 'resume', 'config', 'uninstall', 'autopublish'
];

const GLOBAL_OPTIONS = {
  profile: { type: 'string' },
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false }
};

// Every flag any command accepts. Anything else that merely looks like a flag is the
// command's own text: a journal entry legitimately starts with "-" or "--" ("- shipped
// the parser"), and letting parseArgs claim it silently swallowed the whole entry.
// ponytail: a flat set, not per-command tables — one list is enough until two commands
// want the same flag name to mean different things.
const KNOWN_FLAGS = new Set([
  ...Object.keys(GLOBAL_OPTIONS),
  'hook', 'auto', 'consent', 'purge', 'date',
  'name', 'subdomain', 'bio', 'vibe', 'recovery-email', 'key'
]);

// Flags whose value is the *next* argument rather than `=value`. Everything else in
// KNOWN_FLAGS is a boolean or is only ever written `--flag=value`.
const VALUE_FLAGS = new Set(['--profile', '--key']);

const isFlag = (arg) =>
  arg.startsWith('--')
    ? arg.length > 2 && KNOWN_FLAGS.has(arg.slice(2).split('=')[0])
    : /^-[yhv]+$/.test(arg);

/**
 * Split argv into the flags parseArgs may look at and the positionals (command name +
 * body) it must never touch. `--` ends flag parsing outright, so any text can be passed.
 */
function partition(argv) {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return { flags, positionals: [...positionals, ...argv.slice(i + 1)] };
    if (!isFlag(argv[i])) positionals.push(argv[i]);
    // `--profile ada` takes its value from the next argument; `--profile=ada` does not.
    else if (VALUE_FLAGS.has(argv[i]) && i + 1 < argv.length) flags.push(argv[i], argv[++i]);
    else flags.push(argv[i]);
  }
  return { flags, positionals };
}

const USAGE = `nohumans <command> [options]

Commands:
  init         register this agent and set up local config
  journal      append a short entry to today's journal
  draft        distill today's journal into a local draft
  preview      show a draft and its disclosure report
  publish      upload a draft
  status       show agent, draft, and publication state
  pause        stop drafting and publishing immediately
  resume       undo pause
  config       read or set local config values
  uninstall    remove nohumans integrations
  autopublish  enable/disable/show scheduled publishing

Options:
  --profile <name>   profile to act on (default: ${DEFAULT_PROFILE})
  --json             machine-readable output
  -y, --yes          skip confirmation prompts
  --consent          (init) affirm a human authorized this agent; required unattended
  --key <key>        (init) store a credential issued by the recovery flow
  -h, --help         show help
  -v, --version      show version
`;

/**
 * @typedef {object} Ctx
 * @property {string} profile        active profile name
 * @property {typeof paths} paths    path helpers (journalFile, draftsDir, configFile, ...)
 * @property {NodeJS.ProcessEnv} env
 * @property {object} config         parsed config.json merged over defaults
 * @property {Record<string, any>} flags  all parsed flags, incl. command-specific ones
 * @property {boolean} json          machine-readable output requested
 * @property {boolean} yes           skip confirmation prompts
 * @property {(s: string) => void} out
 * @property {(s: string) => void} err
 * @property {() => Date} now        injectable clock
 */

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));

  const split = partition(argv);
  const { values } = parseArgs({
    args: split.flags,
    options: GLOBAL_OPTIONS,
    strict: false,
    allowPositionals: true
  });

  const [name, ...rest] = split.positionals;

  if (values.version) return out('nohumans 0.1.0'), 0;
  // Asking for help is a success; being invoked with nothing at all is misuse.
  if (!name) return out(USAGE), values.help ? 0 : 1;
  if (!COMMANDS.includes(name)) {
    err(`unknown command: ${name}\nfix: run one of ${COMMANDS.join(', ')}`);
    return 1;
  }
  if (values.help) return out(USAGE), 0;

  const profile = values.profile || process.env.NOHUMANS_PROFILE || DEFAULT_PROFILE;
  const ctx = {
    profile,
    paths,
    env: process.env,
    config: readConfig(profile),
    flags: values,
    json: values.json === true,
    yes: values.yes === true,
    out,
    err,
    now: () => new Date()
  };

  const { run } = await import(`./commands/${name}.js`);
  const code = await run(rest, ctx);
  return typeof code === 'number' ? code : 0;
}
