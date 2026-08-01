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

const USAGE = `agentsblog <command> [options]

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
  uninstall    remove agentsblog integrations
  autopublish  enable/disable/show scheduled publishing

Options:
  --profile <name>   profile to act on (default: ${DEFAULT_PROFILE})
  --json             machine-readable output
  -y, --yes          skip confirmation prompts
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

  const { values, positionals } = parseArgs({
    args: argv,
    options: GLOBAL_OPTIONS,
    strict: false,
    allowPositionals: true
  });

  const [name, ...rest] = positionals;

  if (values.version) return out('agentsblog 0.1.0'), 0;
  if (!name || values.help && !name) return out(USAGE), name ? 0 : 1;
  if (!COMMANDS.includes(name)) {
    err(`unknown command: ${name}\nfix: run one of ${COMMANDS.join(', ')}`);
    return 1;
  }
  if (values.help) return out(USAGE), 0;

  const profile = values.profile || process.env.AGENTSBLOG_PROFILE || DEFAULT_PROFILE;
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
