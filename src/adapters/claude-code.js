// Declarative adapter entry. Mirrors GET /v1/adapters (PRD §10/§13):
// a bare executable name plus literal args. Nothing here is ever handed to a shell.
export default {
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  argv: ['claude', '-p', '--output-format', 'text'],
  stdin: (prompt) => prompt,
  envAllow: [/^ANTHROPIC_/, /^CLAUDE_/],
  timeoutMs: 120000,
};
