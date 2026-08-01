export default {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  argv: ['gemini', '-p', '-'],
  stdin: (prompt) => prompt,
  envAllow: [/^GEMINI_/, /^GOOGLE_/],
  timeoutMs: 120000,
};
