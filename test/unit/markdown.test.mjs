/**
 * Unit tests for the markdown renderer.
 *
 * Model output is untrusted. These tests exist to hold the escape-first
 * invariant: no input, however crafted, may produce a tag or attribute that the
 * renderer did not write itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderMarkdown } from '../../public/js/markdown.js';

describe('escapeHtml', () => {
  test('escapes every HTML-significant character', () => {
    assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  });

  test('escapes the ampersand before the other entities', () => {
    // If & were escaped last, &lt; would become &amp;lt; — or worse, a literal
    // "&lt;" in the source would round-trip back into a real tag.
    assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
  });

  test('coerces non-strings without throwing', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(null), 'null');
  });
});

describe('renderMarkdown — XSS resistance', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<div onclick="alert(1)">x</div>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg/onload=alert(1)>',
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    '<style>body{display:none}</style>',
    '<body onload=alert(1)>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ];

  /**
   * The exhaustive set of markup this renderer is allowed to emit. Anything
   * else leaves a stray "<" behind after stripping, which is the signal that
   * untrusted input escaped into markup.
   *
   * Substring checks like /onerror=/ would be wrong here: escaped text legally
   * *contains* those characters (&lt;img src=x onerror=alert(1)&gt;) while
   * being completely inert. Only a real "<" can start a tag.
   */
  const SAFE_MARKUP = /<\/?(?:p|br|ul|ol|li|h[3-6]|strong|em|code)>|<pre class="code"(?: data-lang="[^"<>]*")?>|<\/pre>/g;

  const strayMarkup = (html) => html.replace(SAFE_MARKUP, '');

  for (const payload of payloads) {
    test(`neutralises: ${payload.slice(0, 44)}`, () => {
      const residue = strayMarkup(renderMarkdown(payload));
      assert.ok(
        !residue.includes('<'),
        `input produced markup the renderer does not emit: ${residue}`,
      );
    });
  }

  test('the stray-markup detector actually catches an escape', () => {
    // Guards the guard: if SAFE_MARKUP were too permissive every test above
    // would pass vacuously.
    assert.ok(strayMarkup('<p>ok</p><img src=x>').includes('<'));
    assert.equal(strayMarkup('<p>ok</p><pre class="code" data-lang="js"></pre>'), 'ok');
  });

  test('payloads inside a fenced code block stay inert', () => {
    const html = renderMarkdown('```html\n<img src=x onerror="alert(1)">\n```');
    assert.ok(html.includes('<pre class="code"'));
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
    assert.ok(!/<img/i.test(html));
  });

  test('a payload in the fence language is escaped into the attribute', () => {
    const html = renderMarkdown('```js"><img src=x onerror=alert(1)>\ncode\n```');
    assert.ok(!/<img/i.test(html));
    assert.ok(html.includes('&quot;'));
  });

  test('inline formatting cannot smuggle markup through a capture group', () => {
    const html = renderMarkdown('**<script>bad</script>** and `<img src=x>`');
    assert.ok(html.includes('<strong>'), 'bold should still render');
    assert.ok(html.includes('<code>'), 'inline code should still render');
    assert.ok(!/<script|<img/i.test(html));
  });

  test('a replacement-pattern token in the input is not re-interpreted', () => {
    // "$&" and "$1" inside the text must survive as literal characters.
    const html = renderMarkdown('**$& $1 $`**');
    assert.ok(html.includes('$&amp;') || html.includes('$&'), html);
    assert.ok(html.includes('$1'), html);
  });
});

describe('renderMarkdown — formatting', () => {
  test('renders paragraphs', () => {
    assert.equal(renderMarkdown('hello'), '<p>hello</p>');
  });

  test('renders bold, italic and inline code', () => {
    const html = renderMarkdown('**b** *i* `c`');
    assert.ok(html.includes('<strong>b</strong>'));
    assert.ok(html.includes('<em>i</em>'));
    assert.ok(html.includes('<code>c</code>'));
  });

  test('renders bullet and numbered lists', () => {
    assert.ok(renderMarkdown('- one\n- two').includes('<ul><li>one</li><li>two</li></ul>'));
    assert.ok(renderMarkdown('1. one\n2. two').includes('<ol><li>one</li><li>two</li></ol>'));
  });

  test('switches cleanly between list types', () => {
    const html = renderMarkdown('- a\n1. b');
    assert.ok(html.includes('</ul>'), 'should close the ul before opening the ol');
    assert.ok(html.includes('<ol>'));
  });

  test('renders headings, clamped to h6', () => {
    assert.ok(renderMarkdown('# Title').includes('<h3>Title</h3>'));
    assert.ok(renderMarkdown('#### Deep').includes('<h6>Deep</h6>'));
  });

  test('renders a fenced code block with its language', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    assert.ok(html.includes('data-lang="js"'));
    assert.ok(html.includes('<code>const a = 1;</code>'));
  });

  test('an unterminated fence still renders as code (mid-stream)', () => {
    // Critical for streaming: a half-arrived block must not flash as prose.
    const html = renderMarkdown('text\n```js\nconst a =');
    assert.ok(html.includes('<pre class="code"'), html);
  });

  test('empty and falsy input yields an empty string', () => {
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown(undefined), '');
  });

  test('newlines inside a paragraph become line breaks', () => {
    assert.ok(renderMarkdown('a\nb').includes('a<br>b'));
  });
});
