export default {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  bin: 'codex',
  env: ['OPENAI_API_KEY'],
  argv: ['codex', 'exec', '--skip-git-repo-check', '-'],
  stdin: (prompt) => prompt,
  envAllow: [/^OPENAI_/, /^CODEX_/],
  timeoutMs: 120000,
};
