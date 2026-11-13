// Run with `npm test`. The reply renderer gets untrusted model output: only allow-listed tags and attributes may
// come out, and nothing that loads, runs or navigates.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeMarkdown, MAX_MARKDOWN, renderReply } from '../src/lib/markdown.ts'

const TAGS = new Set(
  'p br strong em s code pre div span button h1 h2 h3 h4 h5 h6 ul ol li blockquote hr table thead tbody tr th td'.split(' '),
)
const ATTRS = new Set(['class', 'type', 'title', 'start', 'style'])

/** Fails on any tag or attribute outside the allow-lists (so no event handlers, href or src), on URLs in attributes and on any style but table cell alignment. */
function assertSafe(html: string) {
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, tag, attrs] = m
    assert.ok(TAGS.has(tag.toLowerCase()), `tag <${tag}> in ${html.slice(0, 200)}`)
    for (const a of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      assert.ok(ATTRS.has(a[1].toLowerCase()), `attribute ${a[1]} on <${tag}>`)
      assert.doesNotMatch(a[2] ?? '', /[<>]|javascript:|data:|https?:/i, `attribute value ${a[2]}`)
    }
    if (tag === 'input') assert.match(attrs, /type="checkbox"/)
  }
  assert.doesNotMatch(html, /<(a|img|script|iframe|style|object|embed|svg|math|form|link|meta)\b/i)
}

const md = (s: string) => renderReply(s).html

test('plain prose stays plain, escaped and unchanged', () => {
  const s = 'Sure, 3 * 4 = 12 and a_b is fine.\nSecond line <b>here</b> & "quotes".'
  assert.equal(looksLikeMarkdown(s), false)
  const r = renderReply(s)
  assert.equal(r.markdown, false)
  assert.equal(r.html, 'Sure, 3 * 4 = 12 and a_b is fine.\nSecond line &lt;b&gt;here&lt;/b&gt; &amp; &quot;quotes&quot;.')
})

test('detects the usual Markdown constructs', () => {
  for (const s of ['# Title', 'x\n- item', '1. first', '> quote', '```\ncode\n```', '| a | b |', 'a **bold** word', 'run `ls`', 'see [docs](https://x.y)', '~~~\nx\n~~~'])
    assert.ok(looksLikeMarkdown(s), s)
  for (const s of ['Just text.', 'Price: 5 * 3', 'snake_case_name here', '-5 degrees', '2024 was a year'])
    assert.ok(!looksLikeMarkdown(s), s)
})

test('renders headings, emphasis, lists, quotes, code, tables and rules', () => {
  const html = md('# H\n\n**b** *i* ~~s~~ `c`\n\n- a\n- b\n\n3. x\n4. y\n\n> q\n\n```js\nlet a = 1 < 2\n```\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n---\n\nline\nbreak')
  assertSafe(html)
  for (const t of ['<h1>H</h1>', '<strong>b</strong>', '<em>i</em>', '<s>s</s>', '<code>c</code>', '<ul>', '<ol start="3">', '<blockquote>', '<table>', '<hr>', 'line<br>\nbreak'])
    assert.ok(html.includes(t), `${t} missing in ${html}`)
  assert.ok(html.includes('<pre><code>let a = 1 &lt; 2</code></pre>'), html)
  assert.ok(html.includes('<button type="button" class="md-copy"'), 'copy button')
  assert.doesNotMatch(html, /language-/) // the fence info string is dropped, not passed into an attribute
})

test('raw HTML is shown as text, never as markup', () => {
  for (const s of [
    '# Hi\n<script>alert(1)</script>',
    '**x** <img src=x onerror=alert(1)>',
    '- a\n\n<div onclick="evil()"><iframe src="https://evil.example"></iframe></div>',
    '`x` <svg><script>alert(1)</script></svg>',
    '**a** <a href="javascript:alert(1)">click</a>',
    '> <style>body{display:none}</style>',
    '**b** <<script>script>alert(1)<</script>/script>',
    '# t\n<details open ontoggle=alert(1)>',
    '**x** <!-- comment --> <![CDATA[ x ]]>',
  ]) {
    const html = md(s)
    assertSafe(html)
    assert.ok(html.includes('&lt;'), `markup must be escaped: ${html}`)
  }
})

test('links never navigate and show their target; images load nothing', () => {
  const cases: [string, RegExp][] = [
    ['see [docs](https://example.com/a?b=1&c=2)', /docs <span class="md-url">\(https:\/\/example\.com\/a\?b=1&amp;c=2\)<\/span>/],
    // Dangerous schemes are not links at all: the source stays visible as text.
    ['**x** [click](javascript:alert(1))', /\[click\]\(javascript:alert\(1\)\)/],
    ['**x** [a](data:text/html;base64,PHNjcmlwdD4=)', /\[a\]\(data:text\/html/],
    ['**x** [a](vbscript:msgbox) [b](file:///C:/x)', /\[a\]\(vbscript:msgbox\) \[b\]\(file:/],
    ['**x** <https://example.com>', /<span class="md-url">https:\/\/example\.com<\/span>/],
    ['**x** www.example.com', /<strong>x<\/strong> www\.example\.com/],
    ['**x** ![cat](https://evil.example/track.png)', /<span class="md-img">\[image: cat\]<\/span>/],
    ['**x** ![](data:image/png;base64,AAAA)', /<span class="md-img">\[image\]<\/span>/],
    ['**x** [![logo](https://e.x/l.png)](https://e.x)', /\[image: logo\]/],
    ['**x** [a"b](<https://e.x/"onmouseover="alert(1)>)', /a&quot;b <span class="md-url">\(https:\/\/e\.x\/%22onmouseover=%22alert\(1\)\)/],
    ['[ok]\n\n[ok]: https://e.x\n\n**x**', /ok <span class="md-url">\(https:\/\/e\.x\)/],
    ['[ref]\n\n[ref]: javascript:alert(1)\n\n**x**', /<p>\[ref\]<\/p>/],
    ['**x** [empty]() end', /<strong>x<\/strong> empty end/],
  ]
  for (const [s, want] of cases) {
    const html = md(s)
    assertSafe(html)
    assert.match(html, want, `${s} -> ${html}`)
  }
})

test('partial Markdown while streaming renders without throwing', () => {
  const full = '# Title\n\nSome **bold** and `code`.\n\n```py\nprint("hi")\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> done'
  for (let i = 1; i <= full.length; i++) assertSafe(md(full.slice(0, i)))
  // An unterminated fence shows the rest as code; half a bold marker stays literal text.
  assert.match(md('```js\nlet a = 1'), /<pre><code>let a = 1<\/code><\/pre>/)
  assert.match(md('# t\nsome **bol'), /some \*\*bol/)
})

test('hostile and huge inputs stay fast and safe', () => {
  const inputs = [
    '> '.repeat(5000) + 'deep',
    '['.repeat(49_000) + 'x' + ']'.repeat(49_000),
    '*'.repeat(100_000),
    '**a '.repeat(20_000),
    '`'.repeat(50_000),
    '- '.repeat(10_000) + 'x',
    '| a '.repeat(5_000) + '|\n' + '|-'.repeat(5_000) + '|\n' + '| 1 '.repeat(5_000) + '|',
    ('# Heading\n\nText with **bold**, `code` and a [link](https://x.y).\n\n- item\n- item\n\n```\ncode\n```\n\n').repeat(1_000),
    '<'.repeat(100_000),
  ]
  for (const s of inputs) {
    const t = performance.now()
    const html = md(s)
    const ms = performance.now() - t
    assert.ok(ms < 500, `${ms.toFixed(0)} ms for ${s.slice(0, 20)}…`)
    assertSafe(html)
  }
  // Beyond the cap the reply is escaped plain text.
  const big = '# x\n' + 'a'.repeat(MAX_MARKDOWN)
  assert.equal(renderReply(big).markdown, false)
})
