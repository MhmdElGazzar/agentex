'use strict';
// plaintext.js — Azure DevOps comment HTML -> plain text, for the neutral
// comment-thread read (adapter.listComments). Deterministic and small on
// purpose: ADO comment bodies are simple editor HTML (div/p/br/lists/links/
// mention anchors), and the reader needs the words, not the layout.
//
//   - <br> -> newline; the end of a block (div, p, li, tr, h1-6) -> newline;
//     <li> starts with "- ";
//   - every other tag is removed, its text kept (a mention anchor reads as
//     "@Name");
//   - entities decode ONCE (&amp;lt; stays "&lt;"); non-ASCII stays literal;
//   - each line is trimmed, runs of blank lines collapse to one, the result
//     is trimmed.
// Pure: no I/O, no dependencies.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function htmlToText(html) {
  if (html === null || html === undefined) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<\/(div|p|li|tr|h[1-6]|ul|ol|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n').map((l) => l.replace(/\s+$/, '').replace(/^[ \t]+/, ''));
  const out = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { htmlToText, decodeEntities };
