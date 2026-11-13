// Assistant replies as Markdown. Pure module (tested with `node --test`); the text is untrusted model output.
// Safety: markdown-it with `html: false` never parses raw HTML (it stays escaped text) and escapes all text and
// attributes; links are rendered as plain text with their target (no <a>, so nothing navigates) and images as their
// alt text (no <img>, so nothing is loaded). tests/markdown.test.ts checks the output against a tag allow-list.
// markdown-it rather than marked: its emphasis parsing is linear, marked's took seconds on 8 kB of unmatched `**`.
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false })
export const escapeHtml = md.utils.escapeHtml

const r = md.renderer.rules
// The target is shown after the label; an autolink (<https://…>) shows it once.
// Links cannot nest in Markdown and rendering is synchronous, so one pending target is enough.
// null: an autolink, whose label is the URL itself.
let pendingHref: string | null = null
r.link_open = (tokens, i) => {
  const t = tokens[i]
  pendingHref = t.markup === 'autolink' ? null : String(t.attrGet('href') ?? '')
  return pendingHref === null ? '<span class="md-url">' : ''
}
r.link_close = () =>
  pendingHref === null ? '</span>' : pendingHref ? ` <span class="md-url">(${escapeHtml(pendingHref)})</span>` : ''
r.image = (tokens, i, o, env) => {
  const alt = md.renderer.renderInlineAsText(tokens[i].children ?? [], o, env)
  return `<span class="md-img">[image${alt ? `: ${escapeHtml(alt)}` : ''}]</span>`
}
const codeBlock = (code: string) =>
  `<div class="md-code"><button type="button" class="md-copy" title="Copy this code">Copy</button><pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>\n`
r.fence = (tokens, i) => codeBlock(tokens[i].content)
r.code_block = (tokens, i) => codeBlock(tokens[i].content)

// Any of: heading, list item, numbered item, quote, fence, table row (line start); **bold**, __bold__, `code`,
// [text](url) anywhere. A lone asterisk or underscore in prose does not count. The inline spans have bounded
// lengths: unbounded, 50 000 `[` took a second of backtracking.
const MD_HINT =
  /^ {0,3}(?:#{1,6}\s|[-*+] +\S|\d{1,9}[.)] +\S|>|```|~~~|\|.*\|)|\*\*\S[^*\n]{0,300}\*\*|__\S[^_\n]{0,300}__|`[^`\n]{1,300}`|\[[^\]\n]{1,300}\]\([^)\s]{1,2000}\)/m

/** Cheap check whether a reply uses Markdown at all. */
export const looksLikeMarkdown = (s: string) => MD_HINT.test(s)

/** Longer replies are shown as plain text (a bound on render time; no real reply gets near it). */
export const MAX_MARKDOWN = 100_000

/** Reply text to HTML for `{@html}`: Markdown when detected, otherwise escaped text (the bubble keeps line breaks). */
export function renderReply(text: string): { html: string; markdown: boolean } {
  const plain = { html: escapeHtml(text), markdown: false }
  if (text.length > MAX_MARKDOWN || !looksLikeMarkdown(text)) return plain
  try {
    return { html: md.render(text, {}), markdown: true }
  } catch {
    return plain
  }
}
