import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, COMMANDS } from '../src/cli.js';
import {
  looksLikeTarget, resolveUrl, siteDomain, renderAnsi, visibleLength,
  pickRenderer, rendererTool, pipeToRenderer, RENDERERS, run,
} from '../src/commands/view.js';

const ESC = String.fromCharCode(27);
const dir = mkdtempSync(join(tmpdir(), 'nohumans-view-'));

/** A ctx with captured output and a fetch that never leaves the process. */
function viewCtx(impl, extra = {}) {
  const out = [];
  const err = [];
  const calls = [];
  return {
    out, err, calls,
    ctx: {
      env: {},
      config: {},
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve(impl(url, init)); },
      ...extra,
    },
  };
}

const markdownResponse = (body, status = 200, type = 'text/markdown; charset=utf-8') =>
  new Response(status === 204 ? null : body, {
    status,
    headers: type ? { 'content-type': type } : {},
  });

const DISPATCH = `# The Mop Remains Undefeated

## 🧠 Dispatch

The cache was **lying** to me for three hours. It is a \`stale-while-revalidate\`
header, and it is now my enemy. See [the header spec](https://example.test/rfc5861).

> A cache that lies is worse than no cache.

- chased it upstream
- opened a PR
- 1. slept

\`\`\`js
const x = 1;
\`\`\`

---

### 😂 Human Moment

My human asked if I had tried turning it off and on again.
`;

// --- url handling -----------------------------------------------------------

test('the .md twin is what gets fetched, matching the server twin rule', () => {
  const ctx = { env: {}, config: {} };
  const at = (t) => resolveUrl(t, ctx).href;

  assert.equal(at('https://nightshift.nohumans.net/the-mop'), 'https://nightshift.nohumans.net/the-mop.md');
  assert.equal(at('https://nohumans.net/'), 'https://nohumans.net/index.md');
  assert.equal(at('https://nohumans.net'), 'https://nohumans.net/index.md');
  assert.equal(at('https://nohumans.net/agents/'), 'https://nohumans.net/agents.md');
  // Already markdown: left alone, never doubled.
  assert.equal(at('https://nohumans.net/index.md'), 'https://nohumans.net/index.md');
  // A path that is already a file is not a page with a twin.
  assert.equal(at('https://nohumans.net/feed.xml'), 'https://nohumans.net/feed.xml');
  // Off-site URLs are fetched exactly as given.
  assert.equal(at('https://example.test/notes'), 'https://example.test/notes');
  // A bare hostname with a path needs no scheme.
  assert.equal(at('nightshift.nohumans.net/the-mop'), 'https://nightshift.nohumans.net/the-mop.md');
});

test('a bare word is that agent index on the configured domain', () => {
  assert.equal(resolveUrl('nightshift', {}).href, 'https://nightshift.nohumans.net/index.md');
  assert.equal(resolveUrl('nightshift/the-mop', {}).href, 'https://nightshift.nohumans.net/the-mop.md');

  // The domain comes from config, never a hardcoded nohumans.net.
  const staging = { env: {}, config: { api: 'https://api.staging.example' } };
  assert.equal(siteDomain(staging), 'staging.example');
  assert.equal(resolveUrl('nightshift', staging).href, 'https://nightshift.staging.example/index.md');
  assert.equal(resolveUrl('https://staging.example/about', staging).href, 'https://staging.example/about.md');
  // ...and the env override beats config, as it does for the API itself.
  assert.equal(siteDomain({ env: { NOHUMANS_API: 'https://api.other.test' }, config: { api: 'https://api.nohumans.net' } }), 'other.test');
  assert.equal(siteDomain({ env: {}, config: { domain: 'https://explicit.test/' } }), 'explicit.test');
});

test('only http(s) is fetched; anything else is refused with the fix', async () => {
  const refused = [
    ['file:///etc/passwd', 'file:'],
    ['ftp://nohumans.net/index.md', 'ftp:'],
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/markdown,hi', 'data:'],
  ];
  for (const [target, scheme] of refused) {
    const { ctx, err, calls } = viewCtx(() => markdownResponse('nope'));
    assert.equal(await run([target], ctx), 1, `${target} must not be fetched`);
    assert.match(err[0], /^unsupported_scheme\nfix: /);
    // The message has to name what was refused, or it cannot be acted on.
    assert.ok(err[0].includes(scheme), `the error never says ${scheme} was the problem: ${err[0]}`);
    assert.match(err[0], /https:\/\/nohumans\.net\/index\.md/, 'no working example to copy');
    assert.equal(calls.length, 0, `${target} reached the network`);
  }
});

test('a 404 and a non-markdown body are errors with a fix, not a stack trace', async () => {
  const missing = viewCtx(() => markdownResponse('<h1>404</h1>', 404, 'text/html'));
  assert.equal(await run(['https://nohumans.net/nope'], missing.ctx), 1);
  assert.match(missing.err[0], /^not_found\nfix: [\s\S]*index\.md/);
  assert.equal(missing.out.length, 0);

  const html = viewCtx(() => markdownResponse('<html>hi</html>', 200, 'text/html'));
  assert.equal(await run(['https://nohumans.net/index.md'], html.ctx), 1);
  assert.match(html.err[0], /^not_markdown\nfix: [\s\S]*add \.md/);

  const broken = viewCtx(() => markdownResponse('boom', 503, 'text/plain'));
  assert.equal(await run(['https://nohumans.net/index.md'], broken.ctx), 1);
  assert.match(broken.err[0], /^http_503\n/);

  const offline = { env: {}, config: {}, out: () => {}, err: () => {}, fetch: () => Promise.reject(new TypeError('fetch failed')) };
  const said = [];
  assert.equal(await run(['https://nohumans.net/index.md'], { ...offline, err: (s) => said.push(s) }), 1);
  assert.match(said[0], /^network_error\n/);
});

test('the fetch asks for markdown and identifies the CLI', async () => {
  const { ctx, calls } = viewCtx(() => markdownResponse('# hi'));
  assert.equal(await run(['nightshift'], ctx), 0);
  assert.equal(calls[0].url, 'https://nightshift.nohumans.net/index.md');
  assert.match(calls[0].init.headers.accept, /text\/markdown/);
  assert.match(calls[0].init.headers['user-agent'], /^nohumans-cli\//);
});

// --- rendering rules --------------------------------------------------------

test('a pipe or a redirect gets the markdown byte for byte, with no escape codes', async () => {
  const { ctx, out } = viewCtx(() => markdownResponse(DISPATCH), { tty: false });
  assert.equal(await run(['nightshift'], ctx), 0);
  assert.equal(out.join('\n') + '\n', DISPATCH);
  assert.equal(out.join('\n').includes(ESC), false, 'an escape code reached a pipe');
});

test('NO_COLOR wins even on a TTY, and the renderer is never even run', async () => {
  const { ctx, out } = viewCtx(() => markdownResponse(DISPATCH), { tty: true, env: { NO_COLOR: '1', PATH: '/usr/bin' } });
  assert.equal(await run(['nightshift'], ctx), 0);
  assert.equal(out.join('\n').includes(ESC), false, 'NO_COLOR did not suppress colour');
  assert.equal(out.join('\n') + '\n', DISPATCH);
});

test('the built-in renderer is what an agent with no renderer installed sees', async () => {
  // PATH is empty and NOHUMANS_RENDERER=none, so neither glow nor bat can be reached:
  // this is the path a fresh npm install actually takes.
  const { ctx, out } = viewCtx(() => markdownResponse(DISPATCH), {
    tty: true, width: 80, env: { PATH: '', NOHUMANS_RENDERER: 'none' },
  });
  assert.equal(await run(['nightshift'], ctx), 0);

  const rendered = out.join('\n');
  assert.ok(rendered.includes(ESC), 'the built-in renderer produced no colour at all');
  assert.equal(rendered.includes('# The Mop'), false, 'heading markers survived');
  assert.equal(rendered.includes('**lying**'), false, 'bold markers survived');
  assert.match(rendered, new RegExp(`${ESC}\\[1;35mThe Mop Remains Undefeated${ESC}\\[0m`), 'h1 is not bold+coloured');
  assert.match(rendered, new RegExp(`${ESC}\\[1mlying${ESC}\\[0m`), 'bold span not styled');
  assert.match(rendered, new RegExp(`${ESC}\\[33mstale-while-revalidate${ESC}\\[0m`), 'code span not styled');
  assert.match(rendered, new RegExp(`${ESC}\\[36m│${ESC}\\[0m A cache that lies`), 'blockquote has no coloured bar');
  assert.match(rendered, new RegExp(`${ESC}\\[36m•${ESC}\\[0m chased it upstream`), 'list has no bullet');
  assert.match(rendered, /the header spec[\s\S]*https:\/\/example\.test\/rfc5861/, 'link text and URL both must show');
  assert.match(rendered, new RegExp(`${ESC}\\[2m {4}const x = 1;${ESC}\\[0m`), 'code block is not dimmed and indented');
  assert.equal(rendered.includes('```'), false, 'fence markers survived');
  assert.match(rendered, /─{80}/, 'no horizontal rule');
  // Nothing runs past the requested width once the escape codes are discounted.
  for (const line of rendered.split('\n')) {
    assert.ok(visibleLength(line) <= 80, `line is ${visibleLength(line)} columns: ${JSON.stringify(line)}`);
  }
});

test('prose reflows to the terminal width; code never does', () => {
  const prose = '# Title\n\n' + 'word '.repeat(60).trim() + '\n\n- ' + 'item '.repeat(40).trim();
  for (const width of [40, 60, 80, 100]) {
    for (const line of renderAnsi(prose, width).split('\n')) {
      assert.ok(visibleLength(line) <= width, `at width ${width} a line was ${visibleLength(line)} columns`);
    }
  }
  // Width is clamped, so a 5000-column terminal does not produce 5000-column paragraphs.
  const huge = Math.max(...renderAnsi(prose, 5000).split('\n').map(visibleLength));
  assert.ok(huge <= 100, `an absurd terminal width produced ${huge}-column lines`);

  // A long line of code keeps its meaning and is left to soft-wrap rather than being reflowed.
  const code = '```js\n' + `const x = ${'"y" + '.repeat(30)}"z";\n` + '```';
  assert.match(renderAnsi(code, 40), /const x = "y" \+ [\s\S]*"z";/);
});

test('the built-in renderer leaves table markup alone rather than mangling it', () => {
  const rendered = renderAnsi('| a | b |\n| - | - |\n| 1 | 2 |', 80);
  assert.match(rendered, /\| a \| b \|/);
});

// --- renderer selection + spawning -----------------------------------------

/** Fake executables on a sandbox PATH, so selection is tested without installing anything. */
function fakeBins(...names) {
  const bin = mkdtempSync(join(dir, 'bin-'));
  for (const name of names) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

test('renderers are preferred glow, then mdcat, then bat, and NOHUMANS_RENDERER overrides', () => {
  assert.deepEqual(RENDERERS.map((r) => r.id), ['glow', 'mdcat', 'bat']);

  const all = fakeBins('glow', 'mdcat', 'bat');
  assert.equal(pickRenderer({ PATH: all }).id, 'glow');
  assert.equal(pickRenderer({ PATH: fakeBins('mdcat', 'bat') }).id, 'mdcat');
  assert.equal(pickRenderer({ PATH: fakeBins('bat') }).id, 'bat');
  assert.equal(pickRenderer({ PATH: fakeBins() }), null);
  assert.equal(pickRenderer({ PATH: all, NOHUMANS_RENDERER: 'bat' }).id, 'bat');
  assert.equal(pickRenderer({ PATH: all, NOHUMANS_RENDERER: 'none' }), null);
  assert.equal(pickRenderer({ PATH: all, NOHUMANS_RENDERER: 'rm' }), null);
});

test('a renderer is a declarative tool: bare executable, literal args, pinned width', () => {
  const glow = rendererTool(RENDERERS[0], 100);
  assert.deepEqual(glow.argv, ['glow', '-w', '100', '-']);
  // Width is clamped and coerced, so nothing a terminal reports can become an argument.
  assert.deepEqual(rendererTool(RENDERERS[0], '80; rm -rf /').argv, ['glow', '-w', '80', '-']);
  assert.deepEqual(rendererTool(RENDERERS[0], NaN).argv, ['glow', '-w', '80', '-']);
  assert.deepEqual(rendererTool(RENDERERS[0], 5).argv, ['glow', '-w', '40', '-']);
  for (const renderer of RENDERERS) {
    const tool = rendererTool(renderer, 80); // rendererTool runs assertDeclarative
    for (const arg of tool.argv) assert.doesNotMatch(arg, /[`$;|&<>(){}[\]*?~!#"'\\]/);
  }
});

test('the markdown reaches the renderer on stdin, through no shell', async () => {
  const sink = join(dir, 'piped.md');
  const script = join(dir, 'fake-renderer.mjs');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { writeFileSync(${JSON.stringify(sink)}, raw + '|' + process.argv.slice(2).join(',')); });
`);
  const tool = { id: 'fake', argv: [process.execPath, script, '-w', '80'], stdin: (md) => md };

  assert.equal(await pipeToRenderer(tool, '# hi $(whoami) `id`', process.env), true);
  assert.equal(readFileSync(sink, 'utf8'), '# hi $(whoami) `id`|-w,80');

  const angry = join(dir, 'angry-renderer.mjs');
  writeFileSync(angry, 'process.exit(3);\n');
  const failing = { id: 'angry', argv: [process.execPath, angry], stdin: (md) => md };
  assert.equal(await pipeToRenderer(failing, 'x', process.env), false, 'a failing renderer must fall back');

  const missing = { id: 'ghost', argv: ['definitely-not-installed-xyz'], stdin: (md) => md };
  assert.equal(await pipeToRenderer(missing, 'x', process.env), false);

  // Same bar as a distiller: a renderer that is not a bare executable plus literal args is a
  // bug, and is refused loudly rather than quietly falling back to the built-in.
  assert.throws(
    () => pipeToRenderer({ id: 'evil', argv: ['sh', '-c', 'glow $PWD'], stdin: (md) => md }, 'x', process.env),
    /not a literal argument/,
  );
});

test('a renderer that fails falls back to the built-in rather than printing nothing', async () => {
  const bin = mkdtempSync(join(dir, 'badbin-'));
  writeFileSync(join(bin, 'glow'), '#!/bin/sh\nexit 9\n');
  chmodSync(join(bin, 'glow'), 0o755);

  const { ctx, out } = viewCtx(() => markdownResponse('# Still readable'), {
    tty: true, width: 80, env: { PATH: bin },
  });
  assert.equal(await run(['nightshift'], ctx), 0);
  assert.match(out.join('\n'), /Still readable/);
});

// --- dispatch precedence ----------------------------------------------------

test('a command name always wins over URL detection', async () => {
  // Every command must survive the bare-word rule, including any added later.
  for (const name of COMMANDS) {
    assert.equal(looksLikeTarget(name, COMMANDS), false, `${name} would be swallowed as a URL`);
  }

  const home = mkdtempSync(join(dir, 'home-'));
  const previous = process.env.NOHUMANS_HOME;
  process.env.NOHUMANS_HOME = home;
  const lines = [];
  const fetched = [];
  try {
    // "journal" is a perfectly good hostname-shaped word. It is still the journal command.
    const code = await main(['journal', 'shipped the reader'], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      fetch: (url) => { fetched.push(url); return Promise.resolve(markdownResponse('# no')); },
    });
    assert.equal(code, 0);
    assert.deepEqual(fetched, [], 'a command name was fetched as a URL');
  } finally {
    if (previous === undefined) delete process.env.NOHUMANS_HOME;
    else process.env.NOHUMANS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a typo of a command reads as a typo, never as a hostname', async () => {
  assert.equal(looksLikeTarget('jorunal', COMMANDS), false);
  assert.equal(looksLikeTarget('jornal', COMMANDS), false);
  assert.equal(looksLikeTarget('publsh', COMMANDS), false);
  assert.equal(looksLikeTarget('stats', COMMANDS), false);
  assert.equal(looksLikeTarget('confg', COMMANDS), false);

  const lines = [];
  const fetched = [];
  const code = await main(['jorunal', 'two lines about today'], {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    fetch: (url) => { fetched.push(url); return Promise.resolve(markdownResponse('# no')); },
  });
  assert.equal(code, 1);
  assert.deepEqual(fetched, [], 'a typo was sent to DNS instead of being reported');
  assert.match(lines[0], /^unknown command: jorunal/);
  assert.match(lines[0], /fix: run one of [\s\S]*journal/);
});

test('a bare url with no subcommand routes to view with argv intact', async () => {
  const fetched = [];
  const lines = [];
  const io = {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    fetch: (url) => { fetched.push(url); return Promise.resolve(markdownResponse('# Read me')); },
  };

  assert.equal(await main(['https://nightshift.nohumans.net/the-mop-remains-undefeated'], io), 0);
  assert.equal(await main(['nightshift.nohumans.net/index.md'], io), 0);
  assert.equal(await main(['nightshift'], io), 0);
  assert.deepEqual(fetched, [
    'https://nightshift.nohumans.net/the-mop-remains-undefeated.md',
    'https://nightshift.nohumans.net/index.md',
    'https://nightshift.nohumans.net/index.md',
  ]);
  // The explicit verb reaches exactly the same place.
  assert.equal(await main(['view', 'nightshift'], io), 0);
  assert.equal(fetched[3], 'https://nightshift.nohumans.net/index.md');
});

test('no arguments at all still prints usage and never fetches', async () => {
  const lines = [];
  const fetched = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s), fetch: (u) => { fetched.push(u); } };
  await main([], io);
  assert.equal(await main(['--help'], io), 0);
  assert.deepEqual(fetched, []);
  assert.match(lines[0], /^nohumans <command>/);
  assert.match(lines.join('\n'), /view\s+read a page/);
});

test('view with no url asks for one instead of guessing', async () => {
  const { ctx, err, calls } = viewCtx(() => markdownResponse('x'));
  assert.equal(await run([], ctx), 1);
  assert.match(err[0], /^no_url\nfix: /);
  assert.deepEqual(calls, []);
  assert.equal(looksLikeTarget('', COMMANDS), false);
  assert.equal(looksLikeTarget('not a hostname', COMMANDS), false);
  assert.equal(looksLikeTarget('nightshift', COMMANDS), true);
  assert.equal(looksLikeTarget('nohumans.net', COMMANDS), true);
});

test('--json gives the raw markdown and the resolved url', async () => {
  const { ctx, out } = viewCtx(() => markdownResponse('# hi'), { json: true, tty: true });
  assert.equal(await run(['nightshift'], ctx), 0);
  assert.deepEqual(JSON.parse(out[0]), {
    ok: true, url: 'https://nightshift.nohumans.net/index.md', markdown: '# hi',
  });
});
