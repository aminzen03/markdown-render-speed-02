// parse.js — drop-in replacement for marked 18.1.3 (GFM defaults) for the
// make.fun markdown-render-speed-02 bounty. Output must be byte-identical
// to marked.parse() with default options (gfm: true, breaks: false).
// ES module, dependency-free. Exposes parse(markdown) -> string.

'use strict';

// ---------------------------------------------------------------------------
// Character classes (ASCII fast paths; non-ASCII via regex on demand)
// ---------------------------------------------------------------------------
const PUNCT_RE = /[\p{P}\p{S}]/u;          // Unicode punctuation/symbol
const PUNCT_FLANK_RE = /(?!~)[\p{P}\p{S}]/u; // punct for * / _ flanking (~ excluded)
const ALNUM_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;

// ASCII lookup tables (0-127) for the hot paths
const IS_SPACE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) IS_SPACE[c] = 1;
const IS_PUNCT_ASCII = new Uint8Array(128);   // ASCII punctuation (Unicode P/S)
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (c < 32 || c === 127) continue;
  if (/[\p{P}\p{S}]/u.test(ch)) IS_PUNCT_ASCII[c] = 1;
}
// '~' is Sm (punct) but excluded from * / _ flanking classes
const IS_PUNCT_FLANK_ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) if (IS_PUNCT_ASCII[c] && c !== 126) IS_PUNCT_FLANK_ASCII[c] = 1;
const IS_ALPHA_NUM_ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) IS_ALPHA_NUM_ASCII[c] = 1;
}
const ASCII_PUNCT_ESCAPABLE = new Set(
  [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'].map(c => c.charCodeAt(0)));

function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? !!IS_SPACE[c] : SPACE_RE.test(ch);
}
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? !!IS_PUNCT_ASCII[c] : PUNCT_RE.test(ch);
}
function isPunctFlankCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? !!IS_PUNCT_FLANK_ASCII[c] : PUNCT_FLANK_RE.test(ch);
}
function isAlnumCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? !!IS_ALPHA_NUM_ASCII[c] : ALNUM_RE.test(ch);
}
// char class used by marked's `punctuation` rule: whitespace or punct, not * or _
function isPunctSpaceCh(ch) {
  if (ch === '*' || ch === '_') return false;
  return isSpaceCh(ch) || isPunctCh(ch);
}

// ---------------------------------------------------------------------------
// HTML escaping / entity handling (mirrors marked's P() and Ie())
// ---------------------------------------------------------------------------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// escape with & encoded (code spans)
function escapeHtmlEncode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESC_MAP[s[i]];
    if (r !== undefined) { out += s.slice(start, i) + r; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}
// escape without encoding & that is already part of a valid entity ref
// (marked P() no-encode branch)
const NO_ENCODE_RE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NO_ENCODE_TEST = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function escapeHtmlNoEncode(s) {
  if (!NO_ENCODE_TEST.test(s)) return s;
  return s.replace(NO_ENCODE_RE, (c) => ESC_MAP[c]);
}
// numeric character reference decode + bare-& encode (marked Ie()).
// Named entities are NOT decoded (kept verbatim).
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescapeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(NUM_REF_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// href encoding: encodeURI + %25 -> % (marked he())
const PCT25_RE = /%25/g;
function encodeHref(s) {
  try { return encodeURI(s).replace(PCT25_RE, '%'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Inline rules — exact patterns from marked 18.1.3 (GFM), sticky versions.
// The leading ^ is stripped and the sticky flag (y) is used so matching is
// index-based (no substring copies).
// ---------------------------------------------------------------------------
function sticky(src, flags) {
  // strip the leading ^ and any ^ at the start of an alternative (|^);
  // the sticky flag (y) then anchors the match at lastIndex.
  let s = src.startsWith('^') ? src.slice(1) : src;
  s = s.replace(/\|(\^)/g, '|');
  return new RegExp(s, (flags || '') + 'y');
}
const BRACKETS_SRC = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_SRC = '(?:\\[(?:' + BRACKETS_SRC + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const HREF_SRC = '(?:<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)';

const R = {
  escape: sticky('^\\\\([!"#$%&\'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])'),
  tag: sticky('^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'),
  link: sticky('^!?\\[(' + LABEL_SRC + ')\\]\\([ \\t\\n]*(' + HREF_SRC + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + TITLE_SRC + '))?[ \\t\\n]*\\)'),
  reflink: sticky('^!?\\[(' + LABEL_SRC + ')\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]'),
  nolink: sticky('^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?'),
  emStrongLDelim: sticky('^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?', 'u'),
  emStrongRDelimAst: new RegExp('^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))', 'gu'),
  emStrongRDelimUnd: new RegExp('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])', 'gu'),
  code: sticky('^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)'),
  br: sticky('^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*'),
  delLDelim: sticky('^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])', 'u'),
  delRDelim: new RegExp('^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])', 'gu'),
  del: sticky('^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)'),
  autolink: sticky('^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&\'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>'),
  url: sticky('^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])'),
  text: sticky('^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-]+@))))'),
  punctuation: sticky('^((?![*_])[\\s\\p{P}\\p{S}])', 'u'),
  blockSkip: new RegExp('\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>', 'g'),
  anyPunctOutsideCode: new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])', 'gu'),
  reflinkSearch: new RegExp('!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()', 'g'),
};
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const OUTPUT_LINK_REPLACE = /\\([\\[\\]])/g;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const ANY_PUNCT = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;

// label normalisation for link refs: trim, collapse internal whitespace, lowercase
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\u00df/g, 'ss');
}
// balanced-paren check (marked ke()): returns index of first unmatched close,
// -2 if an open is unmatched at end, -1 if balanced
function parenBalance(a) {
  if (a.indexOf('(') === -1 && a.indexOf(')') === -1) return -1;
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') { n++; continue; }
    if (a[n] === '(') t++;
    else if (a[n] === ')') {
      t--;
      if (t < 0) return n;
    }
  }
  return t > 0 ? -2 : -1;
}

// ---------------------------------------------------------------------------
// Inline tokenizer — index-based port of marked 18.1.3's inline lexer.
// Tokens: {t:'text',s} {t:'code',s} {t:'html',s} {t:'br'} {t:'em',c} {t:'strong',c}
//         {t:'del',c} {t:'link',href,title,c} {t:'image',src,title,alt}
// ---------------------------------------------------------------------------

// last-possible-closer scan over a masked source (marked fe()).
// Returns {asterisk, underscore, tilde} = last index of a run of that char
// whose preceding char is not whitespace.
function lastCloserScan(masked) {
  let ast = -1, und = -1, til = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') til = s; else if (r === '*') ast = s; else und = s;
    }
    s = i - 1;
  }
  return { ast, und, til };
}

// masked source for delimiter flanking (marked #n()).
// Only computed when the source contains *, _ or ~.
function maskSource(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const search = R.reflinkSearch;
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(search, maskReflink) + ']' + '[' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    search.lastIndex = 0;
    t = t.replace(search, maskReflink);
  }
  t = t.replace(R.anyPunctOutsideCode, (n, s, r) =>
    r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(R.blockSkip, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}
// whether a string contains a link (used by the reflink masking above)
function linkInText(e, links) {
  if (!e.includes('[')) return false;
  const t = R.link;
  for (const n of e.matchAll(R.blockSkip)) {
    t.lastIndex = 0;
    if (t.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  R.reflinkSearch.lastIndex = 0;
  for (const n of e.matchAll(R.reflinkSearch)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// --- emStrong: greedy opener->closer match, mirroring marked's tokenizer ---
// src = full source, masked = masked source, pos = index of the delimiter run,
// prevCh = char before pos in src ('' if none). Returns {raw, type, text} or null.
// The caller then recursively tokenizes `text`.
function tryEmStrong(src, masked, pos, prevCh, lastCloser) {
  const L = R.emStrongLDelim;
  L.lastIndex = pos;
  const s = L.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0]; // '*' or '_'
  const o = prevCh === r;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  // char just before the run (in the masked source), '' when at the start
  const pCh = l > 0 ? masked[l - 1] : '';
  const h = pCh === '*' || pCh === '_' || isPunctSpaceCh(pCh);
  let n = prevCh;
  if (l < i) n = pCh;
  const u = l < i ? h : isPunctSpaceCh(n);
  if (s[4] && n && isAlnumCh(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1; // opener run length
    let m = k, f = 0;
    const y = i - l + k;
    const Rflag = !!pCh.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? R.emStrongRDelimAst : R.emStrongRDelimUnd;
    const v = r === '*' ? lastCloser.ast : lastCloser.und;
    const Q = i + k; // position just after the opener run (in full src)
    if (v < Q) return null;
    const t = masked.slice(Q);
    const ee = v - Q;
    A.lastIndex = 0;
    let sm;
    while ((sm = A.exec(t)) !== null && !(sm.index > ee)) {
      const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      let b = [...g].length;
      if (sm[3] || sm[4]) { m += b; continue; }
      else if (sm[5] || sm[6] || Rflag) {
        if (o && (sm[5] || sm[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...sm[0]][0].length;
      const M = src.slice(pos, pos + k + sm.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { raw: M, type: 'em', text: U };
      }
      const ne = M.slice(2, -2);
      return { raw: M, type: 'strong', text: ne };
    }
  }
  return null;
}

// --- del: greedy opener->closer match, mirroring marked's tokenizer ---
function tryDel(src, masked, pos, prevCh, lastCloser) {
  const L = R.delLDelim;
  L.lastIndex = pos;
  const s = L.exec(src);
  if (!s) return null;
  if (!(s[1] || '') || !prevCh || isPunctSpaceCh(prevCh)) {
    const o = [...s[0]].length - 1; // opener run length (1 or 2)
    let p = o;
    const u = lastCloser.til;
    const d = pos + o; // position after opener in full src
    if (u < d) return null;
    const t = masked.slice(d);
    const k = u - d;
    const h = R.delRDelim;
    h.lastIndex = 0;
    let sm;
    while ((sm = h.exec(t)) !== null && !(sm.index > k)) {
      const i = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!i) continue;
      let l = [...i].length;
      if (l !== o) continue;
      if (sm[3] || sm[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...sm[0]][0].length;
      const b = src.slice(pos, pos + o + sm.index + g + l);
      const m = b.slice(o, -o);
      return { raw: b, type: 'del', text: m };
    }
  }
  return null;
}

// plain text of a token list (for image alt) — mirrors marked's TextRenderer
function plainText(tokens) {
  let out = '';
  for (const tk of tokens) {
    switch (tk.t) {
      case 'text': out += tk.s; break;
      case 'code': out += tk.s; break;
      case 'html': out += tk.s; break;
      case 'br': break;
      case 'em': case 'strong': case 'del': case 'link': out += plainText(tk.c); break;
      case 'image': out += tk.alt; break;
    }
  }
  return out;
}

// check whether a link label contains an unclosed tag/autolink (marked Be())
function labelHasUnclosedTag(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      R.code.lastIndex = 0;
      const i = R.code.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = full.slice(offset + s);
    R.tag.lastIndex = 0;
    let o = R.tag.exec(r);
    if (!o) { R.autolink.lastIndex = 0; o = R.autolink.exec(r); }
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// count trailing backslashes of a string
function trailingBackslashes(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n;
}

// try to form a link/image at position pos. Returns a token or null.
// state: {links, inLink, linkEmitted, inRawBlock}
function tryLink(src, pos, state, inline) {
  // inline link (gated by linkParenPossible: an inline link needs a ')')
  if (state.linkParenPossible) {
  R.link.lastIndex = pos;
  let t = R.link.exec(src);
  if (t) {
    const isImg = t[0].charAt(0) === '!';
    if (!labelHasUnclosedTag(src, t[1], pos + (isImg ? 2 : 1))) {
      let s = t[2].trim();
      if (START_ANGLE.test(s)) {
        if (!END_ANGLE.test(s)) return null;
        // the closing > must not be escaped (odd trailing backslashes)
        if (trailingBackslashes(s.slice(0, -1)) % 2 === 1) return null;
      } else {
        const l = parenBalance(t[2]);
        if (l === -2) return null;
        if (l > -1) {
          const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
          t[2] = t[2].substring(0, l);
          t[0] = t[0].substring(0, h).trim();
          t[3] = '';
        }
      }
      // the closing ) must not be escaped (odd trailing backslashes)
      if (trailingBackslashes(t[0].slice(0, -1)) % 2 === 1) return null;
      let href = t[2];
      let title = '';
      if (t[3]) title = t[3].slice(1, -1);
      href = href.trim();
      if (START_ANGLE.test(href)) href = href.slice(1, -1);
      href = href.replace(ANY_PUNCT, '$1');
      title = title.replace(ANY_PUNCT, '$1');
      const labelText = t[1].replace(OUTPUT_LINK_REPLACE, '$1');
      return makeLinkToken(labelText, href, title, isImg, t[0], state, inline);
    }
  }
  }
  // reference link / shortcut link
  R.reflink.lastIndex = pos;
  let n = R.reflink.exec(src);
  if (!n) { R.nolink.lastIndex = pos; n = R.nolink.exec(src); }
  if (n) {
    const isImg = n[0].charAt(0) === '!';
    if (labelHasUnclosedTag(src, n[1], pos + (isImg ? 2 : 1))) return null;
    const refId = n[2] !== undefined ? n[2] : n[1];
    const ref = state.links[normLabel(refId)];
    if (ref) {
      const labelText = n[1].replace(OUTPUT_LINK_REPLACE, '$1');
      return makeLinkToken(labelText, ref.href, ref.title, isImg, n[0], state, inline);
    }
    // no matching ref: marked's reflink returns a text token (the raw is
    // re-scanned); we return null so the caller treats '[' as text.
    return null;
  }
  return null;
}

function makeLinkToken(labelText, href, title, isImg, raw, state, inline) {
  const prevInLink = state.inLink, prevEmitted = state.linkEmitted, prevRaw = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const children = inline(labelText, state);
  const innerEmitted = state.linkEmitted;
  state.linkEmitted = prevEmitted;
  state.inLink = prevInLink;
  if (!isImg) {
    if (innerEmitted) { state.inRawBlock = prevRaw; return null; }
    state.linkEmitted = true;
  }
  if (isImg) {
    return { t: 'image', src: href, title: title || null, alt: escapeHtmlNoEncode(plainText(children)), raw };
  }
  return { t: 'link', href, title: title || null, c: children, raw };
}

// extended autolink (bare URL / email / www.) — marked url tokenizer
function tryUrl(src, pos) {
  R.url.lastIndex = pos;
  const t = R.url.exec(src);
  if (!t) return null;
  let text, href;
  if (t[2] === '@') {
    // email alternative: no backpedal
    text = t[0];
    href = 'mailto:' + t[0];
  } else {
    // backpedal loop until stable
    let r;
    do {
      r = t[0];
      const bp = BACKPEDAL_RE.exec(t[0]);
      t[0] = bp ? bp[0] : '';
    } while (r !== t[0]);
    text = t[0];
    href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  return { t: 'link', href, title: null, autolink: true, text, raw: t[0] };
}

// ---------------------------------------------------------------------------
// Inline tokenize loop (marked #t) — index-based, no substring copies.
// ---------------------------------------------------------------------------
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

function inlineTokens(src, state) {
  const prevLPP = state.linkParenPossible;
  state.linkParenPossible = prevLPP && src.includes(')');
  try {
    return inlineTokensInner(src, state);
  } finally {
    state.linkParenPossible = prevLPP;
  }
}

function inlineTokensInner(src, state) {
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasEm ? maskSource(src, state.links) : src;
  const lastCloser = hasEm ? lastCloserScan(masked) : { ast: -1, und: -1, til: -1 };
  const tokens = [];
  const n = src.length;
  let pos = 0;
  let prevCh = '';
  let lastWasText = false;
  while (pos < n) {
    if (!lastWasText) prevCh = '';
    lastWasText = false;
    const ch = src[pos];
    let tok = null;
    let adv = 0;

    if (ch === '\\') {
      R.escape.lastIndex = pos;
      const m = R.escape.exec(src);
      if (m) { tok = { t: 'escape', s: m[1] }; adv = m[0].length; }
      else {
        R.br.lastIndex = pos;
        const b = R.br.exec(src);
        if (b) { tok = { t: 'br' }; adv = b[0].length; }
      }
    } else if (ch === '<') {
      R.tag.lastIndex = pos;
      const m = R.tag.exec(src);
      if (m) {
        // tag tokenizer manages inLink / inRawBlock state
        if (!state.inLink && START_A_TAG.test(m[0])) state.inLink = true;
        else if (state.inLink && END_A_TAG.test(m[0])) state.inLink = false;
        if (!state.inRawBlock && START_PRE_TAG.test(m[0])) state.inRawBlock = true;
        else if (state.inRawBlock && END_PRE_TAG.test(m[0])) state.inRawBlock = false;
        tok = { t: 'html', s: m[0] }; adv = m[0].length;
      } else {
        R.autolink.lastIndex = pos;
        const a = R.autolink.exec(src);
        if (a) {
          const isEmail = a[2] !== undefined;
          const hrefRaw = isEmail ? 'mailto:' + a[1] : a[1];
          tok = { t: 'link', href: hrefRaw, title: null, autolink: true, text: a[1], raw: a[0] };
          adv = a[0].length;
        }
      }
    } else if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      tok = tryLink(src, pos, state, inlineTokens);
      if (tok) adv = tok.raw.length;
    } else if (ch === '*' || ch === '_') {
      const r = tryEmStrong(src, masked, pos, prevCh, lastCloser);
      if (r) {
        tok = { t: r.type, c: inlineTokens(r.text, state) };
        adv = r.raw.length;
      }
    } else if (ch === '`') {
      R.code.lastIndex = pos;
      const m = R.code.exec(src);
      if (m) {
        let txt = m[2].replace(/\n/g, ' ');
        const hasNonSpace = /[^ ]/.test(txt);
        const startsSpace = txt.charAt(0) === ' ';
        const endsSpace = txt.charAt(txt.length - 1) === ' ';
        if (hasNonSpace && startsSpace && endsSpace) txt = txt.substring(1, txt.length - 1);
        tok = { t: 'code', s: txt };
        adv = m[0].length;
      }
    } else if (ch === ' ') {
      R.br.lastIndex = pos;
      const b = R.br.exec(src);
      if (b) { tok = { t: 'br' }; adv = b[0].length; }
    } else if (ch === '~') {
      const r = tryDel(src, masked, pos, prevCh, lastCloser);
      if (r) {
        tok = { t: 'del', c: inlineTokens(r.text, state) };
        adv = r.raw.length;
      }
    } else if (!state.inLink) {
      // bare URL / email autolink (only when not inside a link)
      const u = tryUrl(src, pos);
      if (u) { tok = u; adv = u.raw.length; }
    }

    if (!tok) {
      // text token (marked inlineText)
      R.text.lastIndex = pos;
      const m = R.text.exec(src);
      if (m) {
        const raw = m[0];
        tok = { t: 'text', s: state.inRawBlock ? raw : unescapeEntities(raw), raw };
        adv = raw.length;
      }
    }
    if (!tok) {
      // safety net: consume one char as text (should not happen)
      tok = { t: 'text', s: src[pos], raw: src[pos] };
      adv = 1;
    }
    tokens.push(tok);
    pos += adv;
    if (tok.t === 'text') {
      const last = tok.raw !== undefined ? tok.raw : tok.s;
      if (last.slice(-1) !== '_') prevCh = last.slice(-1);
      lastWasText = true;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline renderer — tokens -> HTML string (marked Renderer)
// ---------------------------------------------------------------------------
function renderInline(tokens) {
  let out = '';
  for (const tk of tokens) {
    switch (tk.t) {
      case 'text': out += escapeHtmlNoEncode(tk.s); break;
      case 'escape': out += escapeHtmlNoEncode(tk.s); break;
      case 'code': out += '<code>' + escapeHtmlEncode(tk.s) + '</code>'; break;
      case 'html': out += tk.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderInline(tk.c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(tk.c) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(tk.c) + '</del>'; break;
      case 'link': {
        if (tk.autolink) {
          // autolink: text and href both escaped WITH & encoding
          const textHtml = escapeHtmlEncode(tk.text);
          const enc = encodeHref(tk.href);
          if (enc === null) { out += textHtml; break; }
          out += '<a href="' + escapeHtmlEncode(enc) + '">' + textHtml + '</a>';
          break;
        }
        const textHtml = renderInline(tk.c);
        const enc = encodeHref(tk.href);
        if (enc === null) { out += textHtml; break; }
        let s = '<a href="' + escapeHtmlNoEncode(enc) + '"';
        if (tk.title) s += ' title="' + escapeHtmlNoEncode(tk.title) + '"';
        out += s + '>' + textHtml + '</a>';
        break;
      }
      case 'image': {
        const enc = encodeHref(tk.src);
        if (enc === null) { out += escapeHtmlNoEncode(tk.alt); break; }
        let s = '<img src="' + escapeHtmlNoEncode(enc) + '" alt="' + tk.alt + '"';
        if (tk.title) s += ' title="' + escapeHtmlNoEncode(tk.title) + '"';
        out += s + '>';
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parser — line model with tab-aware columns.
// A Line keeps the raw string plus (only when it contains a tab) an expanded
// view and a column->original-index map, so structure decisions use columns
// while content keeps its original tabs.
// ---------------------------------------------------------------------------
class Line {
  constructor(raw) {
    this.raw = raw;
    this.hasTab = raw.indexOf('\t') !== -1;
    if (!this.hasTab) {
      this.expanded = raw;
      this.origIdx = null;
      this.tabStart = null;
      this.tabEnd = null;
    } else {
      let exp = '';
      const origIdx = [];
      const tabStart = [];
      const tabEnd = [];
      let col = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '\t') {
          const w = 4 - (col % 4);
          for (let k = 0; k < w; k++) { origIdx.push(i); tabStart.push(col); tabEnd.push(col + w); }
          exp += ' '.repeat(w);
          col += w;
        } else {
          origIdx.push(i); tabStart.push(-1); tabEnd.push(-1);
          exp += c;
          col++;
        }
      }
      this.expanded = exp;
      this.origIdx = origIdx;
      this.tabStart = tabStart;
      this.tabEnd = tabEnd;
    }
    this.len = this.expanded.length;
  }
  isBlank() {
    const e = this.expanded;
    for (let i = 0; i < e.length; i++) if (e[i] !== ' ') return false;
    return true;
  }
  // leading whitespace columns (expanded view)
  indent() {
    const e = this.expanded;
    let n = 0;
    while (n < e.length && e[n] === ' ') n++;
    return n;
  }
  // content after removing nCols expanded columns from the start.
  // A tab the cut lands inside is replaced by spaces for its remainder;
  // a tab the cut lands exactly before is kept as a tab; content keeps
  // its original tabs.
  strip(nCols) {
    if (nCols <= 0) return this.raw;
    const exp = this.expanded;
    if (nCols >= exp.length) return '';
    if (!this.hasTab) return this.raw.slice(nCols);
    const oi = this.origIdx[nCols];
    const ts = this.tabStart[nCols];
    if (ts === -1) return this.raw.slice(oi);
    if (nCols === ts) return this.raw.slice(oi); // tab untouched
    // cut lands inside the tab: remainder is spaces + rest after the tab
    return ' '.repeat(this.tabEnd[nCols] - nCols) + this.raw.slice(oi + 1);
  }
  // like strip() but the leading whitespace of the remainder is taken
  // from the EXPANDED view (a tab at the cut becomes spaces), while the
  // content after the first non-whitespace char keeps its raw tabs.
  // Used for fenced-code indent compensation (marked Dt).
  stripFence(nCols) {
    if (nCols <= 0) return this.raw;
    const exp = this.expanded;
    if (nCols >= exp.length) return '';
    const rest = exp.slice(nCols);
    let k = 0;
    while (k < rest.length && rest[k] === ' ') k++;
    if (k === rest.length) return rest;
    if (!this.hasTab) return rest;
    const oi = this.origIdx[nCols + k];
    return rest.slice(0, k) + this.raw.slice(oi);
  }
  // char at expanded column c (or '' past the end)
  charAt(c) { return c < this.len ? this.expanded[c] : ''; }
  // like strip() but returns a Line whose expanded view is the slice of
  // this line's expanded view (so tab widths stay anchored to the
  // ORIGINAL columns across a second strip, e.g. list indent then code
  // indent). Used when the stripped text is re-lexed as new lines.
  stripLine(nCols) {
    if (nCols <= 0) return this;
    const exp = this.expanded;
    if (nCols >= exp.length) return new Line('');
    const rawRem = this.stripFence(nCols);
    const expRem = exp.slice(nCols);
    const nl = Object.create(Line.prototype);
    nl.raw = rawRem;
    nl.expanded = expRem;
    nl.len = expRem.length;
    nl.hasTab = rawRem.indexOf('\t') !== -1;
    if (!nl.hasTab) { nl.origIdx = null; nl.tabStart = null; nl.tabEnd = null; return nl; }
    // rebuild the expanded->raw maps: tab widths use the ORIGINAL
    // column (origCol) but tabStart/tabEnd are indices into THIS line's
    // expanded view (newIdx)
    let origCol = nCols;
    let newIdx = 0;
    const origIdx = [], tabStart = [], tabEnd = [];
    for (let i = 0; i < rawRem.length; i++) {
      const c = rawRem[i];
      if (c === '\t') {
        const w = 4 - (origCol % 4);
        for (let k = 0; k < w; k++) { origIdx.push(i); tabStart.push(newIdx); tabEnd.push(newIdx + w); }
        newIdx += w;
        origCol += w;
      } else {
        origIdx.push(i); tabStart.push(-1); tabEnd.push(-1);
        newIdx++;
        origCol++;
      }
    }
    nl.origIdx = origIdx; nl.tabStart = tabStart; nl.tabEnd = tabEnd;
    return nl;
  }
}

function toLines(src) {
  // split into lines; a trailing newline does not create an extra blank line
  const endsWithNewline = src.endsWith('\n');
  const parts = src.split('\n');
  if (endsWithNewline) parts.pop();
  return { lines: parts.map(p => new Line(p)), endsWithNewline };
}
// strip trailing blank lines per marked's ge(): keep the text as-is when it
// ends with at most one blank line, else cut to the last non-blank line.
function stripTrailingBlankLines(raw) {
  const parts = raw.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  if (parts.length - t <= 2) return raw;
  return parts.slice(0, t + 1).join('\n');
}

// --- block-level helpers (operate on the expanded view) ---
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HR_RE = /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const LIST_BULLET_RE = /^([*+-])([ \t]+|$)/;
const LIST_ORDERED_RE = /^(\d{1,9})([.)])([ \t]+|$)/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
// HTML block start conditions (types 1-7), from the CommonMark spec
const HTML_TYPE1 = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i;
const HTML_TYPE2 = /^<!--/;
const HTML_TYPE3 = /^<\?/;
const HTML_TYPE4 = /^<![A-Za-z]/;
const HTML_TYPE5 = /^<!\[CDATA\[/;
const HTML_TYPE6 = /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i;
const HTML_TYPE7 = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*)>[ \t]*$/;

function htmlBlockType(expanded, indent) {
  if (indent > 3) return 0;
  const s = expanded.slice(indent);
  if (HTML_TYPE1.test(s)) return 1;
  if (HTML_TYPE2.test(s)) return 2;
  if (HTML_TYPE3.test(s)) return 3;
  if (HTML_TYPE4.test(s)) return 4;
  if (HTML_TYPE5.test(s)) return 5;
  if (HTML_TYPE6.test(s)) return 6;
  if (HTML_TYPE7.test(s)) return 7;
  return 0;
}
// whether a line (expanded view, indent<=3) starts a block that interrupts a paragraph
function interruptsParagraph(line, inList) {
  const ind = line.indent();
  if (ind > 3) return false;
  const s = line.expanded.slice(ind);
  if (s === '') return false;
  if (/^#{1,6}(?:[ \t]|$)/.test(s)) return true; // ATX
  // fence: a backtick fence whose info contains backticks is not a fence
  { const fm = FENCE_RE.exec(s);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return true; }
  if (HR_RE.test(s)) return true;
  if (s[0] === '>') return true; // blockquote
  if (htmlBlockType(line.expanded, ind) >= 1 && htmlBlockType(line.expanded, ind) <= 6) return true;
  const bm = LIST_BULLET_RE.exec(s);
  if (bm) {
    if (inList) return true; // inside a list item any marker interrupts
    // bullet interrupts only if the first item is non-empty
    const after = s.slice(bm[0].length);
    if (after !== '' && !/^[ \t]*$/.test(after)) return true;
    return false;
  }
  const om = LIST_ORDERED_RE.exec(s);
  if (om) {
    if (inList) return true; // inside a list item any start number interrupts
    if (parseInt(om[1], 10) !== 1) return false;
    const after = s.slice(om[0].length);
    if (after !== '' && !/^[ \t]*$/.test(after)) return true;
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block parser (line-based). Returns {nodes, links}.
// Node types: heading, hr, code, html, blockquote, list, table, paragraph.
// def nodes are consumed into links and produce no node.
// ---------------------------------------------------------------------------
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;

function tryDef(lines, i, links) {
  // a def can span up to 4 lines (multi-line label + title on next line)
  const win = [];
  for (let k = 0; k < 12 && i + k < lines.length; k++) win.push(lines[i + k].raw);
  const src = win.join('\n') + '\n';
  const m = DEF_RE.exec(src);
  if (!m) return 0;
  const raw = m[0];
  const nl = (raw.match(/\n/g) || []).length;
  const consumed = raw.endsWith('\n') ? nl : nl + 1;
  if (consumed > win.length) return 0;
  const label = normLabel(m[1]);
  if (!Object.hasOwn(links, label)) {
    let href = m[2] || '';
    if (href.charAt(0) === '<' && href.charAt(href.length - 1) === '>') href = href.slice(1, -1);
    href = href.replace(ANY_PUNCT, '$1');
    let title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : null;
    links[label] = { href, title };
  }
  return consumed;
}

function parseTableDelimiter(expanded) {
  // returns alignments array or null
  const s = expanded.trim();
  if (!/^:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?[ \t]*$/.test(s) && !/^\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?$/.test(s)) return null;
  const cells = splitTableRow(s, 0);
  const aligns = [];
  for (const c of cells) {
    const t = c.trim();
    if (/^:-+:$/.test(t)) aligns.push('center');
    else if (/^:-+$/.test(t)) aligns.push('left');
    else if (/^-+:$/.test(t)) aligns.push('right');
    else if (/^-+$/.test(t)) aligns.push(null);
    else return null;
  }
  return aligns;
}
// split a table row into cells (marked de())
function splitTableRow(row, count) {
  const t = row.replace(/\|/g, (r, o, str) => {
    let odd = false, p = o;
    while (--p >= 0 && str[p] === '\\') odd = !odd;
    return odd ? '|' : ' |';
  });
  let n = t.split(/ \|/);
  if (n.length > 0 && n[0].trim() === '') n.shift();
  if (n.length > 0 && n[n.length - 1].trim() === '') n.pop();
  if (count && n.length > count) n.splice(count);
  while (count && n.length < count) n.push('');
  for (let s = 0; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}
function tableRowStops(line) {
  // whether a line ends the table body (blank, hr, heading, blockquote,
  // indented code, fence, list [*+-]|1[.)], html block)
  // a whitespace-only line that contains a TAB is an empty row, not the
  // end of the table (marked); a spaces-only line ends it
  if (line.isBlank()) return !line.hasTab;
  const ind = line.indent();
  if (ind >= 4) return true;
  if (ind > 3) return false;
  const s = line.expanded.slice(ind);
  if (HR_RE.test(s)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(s)) return true;
  if (s[0] === '>') return true;
  if (/^(`{3,}|~{3,})/.test(s)) return true;
  if (/^(?:[*+-]|1[.)])(?:[ \t]|$)/.test(s)) return true;
  if (htmlBlockType(line.expanded, ind) >= 1) return true;
  return false;
}

// strip a blockquote marker: up to 3 spaces, '>', then one optional space/tab
// marked: blockquoteMarkerWhitespace ^( {0,3}>)([ \t]+) -> b + J(m, b.length),
// then blockquoteSetextReplace2 ^ {0,3}>[ \t]? -> ''. The whitespace after
// '>' is tab-expanded from the column of the marker end, NOT the original
// column (a tab there expands from the marker, e.g. '> \t' -> 2 spaces).
function stripBlockquoteMarker(line) {
  const raw = line.raw;
  const m = /^ {0,3}>/.exec(raw);
  if (!m) return null;
  const b = m[0];
  let rest = raw.slice(b.length);
  let i = 0;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  if (i > 0) {
    let col = b.length, exp = '';
    for (let k = 0; k < i; k++) {
      const c = rest[k];
      if (c === '\t') { const w = 4 - (col % 4); exp += ' '.repeat(w); col += w; }
      else { exp += c; col++; }
    }
    rest = exp.slice(1) + rest.slice(i);
  }
  return new Line(rest);
}

// whether the collected inner lines end inside an unclosed fenced code
// block that has already captured a content line at original indent >=
// contentIndent -- only then do its code lines belong to the item even at a
// lower indent. A fence whose FIRST content line is below contentIndent
// captures nothing: the code block is empty and the item ends there
// (marked: '1. item\n   ```toml\ncode0\n   ```' -> empty code block).
function hasOpenFence(inner, contentIndent) {
  let fence = null, hasContent = false;
  for (const ln of inner) {
    if (ln.isBlank()) continue;
    const ind = ln.indent();
    if (ind > 3) continue;
    const s = ln.expanded.slice(ind);
    if (fence) {
      const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(s);
      if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { fence = null; hasContent = false; }
      else if (contentIndent === undefined || (ln._origInd !== undefined ? ln._origInd : ind) >= contentIndent) hasContent = true;
      continue;
    }
    const fm = FENCE_RE.exec(s);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) { fence = fm[1]; hasContent = false; }
  }
  return fence !== null && (contentIndent === undefined || hasContent);
}

// whether a block list ends with a paragraph (recursing into a trailing
// blockquote or list item, for lazy-continuation checks)
function endsWithParagraph(nodes) {
  if (!nodes.length) return false;
  const last = nodes[nodes.length - 1];
  if (last.t === 'paragraph') return true;
  if (last.t === 'blockquote') return endsWithParagraph(last.children);
  if (last.t === 'list' && last.items.length) {
    return endsWithParagraph(last.items[last.items.length - 1].children);
  }
  return false;
}
// append a lazy-continuation line's text to the last line of an array of
// Lines (the paragraph's text), so re-parsing keeps it inside the paragraph
function appendLazy(linesArr, text) {
  const last = linesArr[linesArr.length - 1];
  linesArr[linesArr.length - 1] = new Line(last.raw + '\n' + text);
}
function parseBlocks(lines, links, endsWithNewline, inList) {
  const nodes = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.isBlank()) { i++; continue; }
    const startI = i;
    const ind = line.indent();
    const exp = line.expanded;
    const s = exp.slice(ind);

    // indented code
    if (ind >= 4) {
      const codeLines = [];
      let j = i;
      while (j < n) {
        const ln = lines[j];
        if (ln.isBlank()) {
          // a whitespace-only line indented >=4 is code content (strip 4);
          // a truly blank / less-indented line only continues the block
          // when more indented code follows
          if (ln.indent() >= 4) { codeLines.push(ln.strip(4)); j++; continue; }
          let k = j + 1;
          while (k < n && lines[k].isBlank()) k++;
          if (k < n && lines[k].indent() >= 4) {
            while (j < k) { codeLines.push(''); j++; }
            continue;
          }
          break;
        }
        if (ln.indent() < 4) break;
        codeLines.push(ln.strip(4));
        j++;
      }
      // drop trailing blank lines
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      { const nd = { t: 'code', lang: null, text: codeLines.join('\n') }; nd._s = startI; nd._e = j; nodes.push(nd); }
      i = j;
      continue;
    }

    // fenced code
    if (ind <= 3) {
      const fm = FENCE_RE.exec(s);
      if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
        const fence = fm[1];
        const info = fm[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        const lang = info.split(/[ \t]/)[0] || null;
        // marked Dt: fence indent in CHARACTERS (leading whitespace of the
        // fence line as parsed here); only for backtick fences
        const fenceIndChars = (line.raw.match(/^[ \t]*/) || [''])[0].length;
        const codeLines = [];
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const ln = lines[j];
          const li = ln.indent();
          const ls = ln.expanded.slice(li);
          const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(ls);
          if (li <= 3 && cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { closed = true; j++; break; }
          // compensate for the opening fence indent (marked Dt) -- but
          // only for backtick fences: indentCodeCompensation is /^(\s+)(?:```)/
          // so a tilde fence gets NO compensation (code lines keep indent).
          // Dt removes CHARACTERS from the raw line (a tab is 1 char), not
          // columns, so '\\tindented' with fence indent 1 -> 'indented'.
          if (fence[0] === '`') {
            const raw = ln.raw;
            const wm = /^[ \t]+/.exec(raw);
            codeLines.push(wm ? raw.slice(Math.min(wm[0].length, fenceIndChars)) : raw);
          } else codeLines.push(ln.raw);
          j++;
        }
        let text = codeLines.join('\n');
        if (text && !text.endsWith('\n')) text += '\n';
        { const nd = { t: 'code', lang, text }; nd._s = startI; nd._e = j; nodes.push(nd); }
        i = j;
        continue;
      }
    }

    // ATX heading
    if (ind <= 3) {
      const hm = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(s);
      if (hm) {
        const depth = hm[1].length;
        // text from the original line (tabs preserved), after the #s + separator
        let text = line.strip(ind + depth).replace(/^[ \t]+/, '').trim();
        if (/#$/.test(text)) {
          const stripped = text.replace(/#+$/, '');
          if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
        }
        { const nd = { t: 'heading', depth, text }; nd._s = startI; nd._e = i + 1; nodes.push(nd); }
        i++;
        continue;
      }
    }

    // hr
    if (ind <= 3 && HR_RE.test(s)) { const nd = { t: 'hr' }; nd._s = startI; nd._e = i + 1; nodes.push(nd); i++; continue; }

    // blockquote
    if (ind <= 3 && s[0] === '>') {
      const inner = [];
      let j = i;
      while (j < n) {
        const ln = lines[j];
        const stripped = stripBlockquoteMarker(ln);
        if (stripped !== null) {
          // setext underlines inside a blockquote are indented 4 spaces
          // (marked blockquoteSetextReplace) so they stay literal text
          let st = stripped;
          if (inner.length > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(st.raw)) st = new Line('    ' + st.raw);
          inner.push(st);
          j++;
          continue;
        }
        if (ln.isBlank()) break;
        // lazy continuation: the line joins the paragraph at the end of the
        // (possibly nested) inner content; its indent is stripped
        if (interruptsParagraph(ln, false)) break;
        if (inner.length === 0 || inner[inner.length - 1].raw === '') break;
        const tmp = parseBlocks(inner, links, false);
        if (!endsWithParagraph(tmp)) break;
        let lazyText = ln.indent() >= 4 ? ln.strip(ln.indent()) : ln.raw;
        if (/^ {0,3}(=+|-+)[ \t]*$/.test(lazyText)) lazyText = '    ' + lazyText;
        appendLazy(inner, lazyText);
        j++;
      }
      { const nd = { t: 'blockquote', children: parseBlocks(inner, links, false, false) }; nd._s = startI; nd._e = j; nodes.push(nd); }
      i = j;
      continue;
    }

    // list
    if (ind <= 3) {
      const lm = LIST_BULLET_RE.exec(s) || LIST_ORDERED_RE.exec(s);
      if (lm) {
        const res = parseList(lines, i, links);
        res.node._s = startI; res.node._e = res.next; nodes.push(res.node);
        i = res.next;
        continue;
      }
    }

    // html block
    if (ind <= 3) {
      const htype = htmlBlockType(exp, ind);
      if (htype >= 1) {
        const res = parseHtmlBlock(lines, i, htype, endsWithNewline);
        res.node._s = startI; res.node._e = res.next; nodes.push(res.node);
        i = res.next;
        continue;
      }
    }

    // link reference definition (a node: it renders nothing but counts
    // as a block, e.g. it makes a list loose)
    if (ind <= 3) {
      const consumed = tryDef(lines, i, links);
      if (consumed > 0) { const nd = { t: 'def' }; nd._s = startI; nd._e = i + consumed; nodes.push(nd); i += consumed; continue; }
    }

    // paragraph / setext / table
    {
      const res = parseParagraph(lines, i, links, endsWithNewline, inList);
      res.node._s = startI; res.node._e = res.next; nodes.push(res.node);
      i = res.next;
      continue;
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// List parsing
// ---------------------------------------------------------------------------
function isSiblingItem(line, ordered, delim, bulletCh, baseInd, contentLimit) {
  const ind = line.indent();
  // a sibling may sit up to 3 columns below the first item's indent
  // (e.g. first item at 2, later items at 0 are one list)
  if (ind < Math.max(0, baseInd - 3) || ind > baseInd + 3) return false;
  if (contentLimit !== null && ind >= contentLimit) return false;
  const s = line.expanded.slice(ind);
  if (ordered) {
    const m = LIST_ORDERED_RE.exec(s);
    return !!m && m[2] === delim;
  }
  const m = LIST_BULLET_RE.exec(s);
  return !!m && m[1] === bulletCh;
}
function contentIndentOf(line, baseInd, markerWidth) {
  // whitespace columns after the marker (expanded view)
  const start = baseInd + markerWidth;
  let w = 0;
  while (start + w < line.len && line.expanded[start + w] === ' ') w++;
  const rest = line.expanded.slice(start + w);
  if (rest === '') return markerWidth + 1; // empty item
  if (w >= 5) return markerWidth + 1;
  if (w === 0) return markerWidth;
  return markerWidth + w;
}
function parseList(lines, startIdx, links, endsWithNewline) {
  const first = lines[startIdx];
  const baseInd = first.indent();
  const s = first.expanded.slice(baseInd);
  const ordered = /^\d/.test(s);
  const m = ordered ? LIST_ORDERED_RE.exec(s) : LIST_BULLET_RE.exec(s);
  const markerWidth = ordered ? m[1].length + 1 : 1;
  const delim = ordered ? m[2] : null;
  const bulletCh = ordered ? null : m[1];
  const start = ordered ? parseInt(m[1], 10) : null;

  // collect the list's items as arrays of inner Line objects
  const items = [];
  let loose = false;
  let j = startIdx;
  let cur = null; // current item's inner lines
  const flushItem = () => {
    if (!cur) return;
    // drop trailing blank lines from the item
    while (cur.length && cur[cur.length - 1].raw === '') cur.pop();
    items.push(cur);
    cur = null;
  };
  while (j < lines.length) {
    const line = lines[j];
    const limit = cur ? cur.contentIndent : null;
    if (line.indent() < (cur ? cur.contentIndent : baseInd) && line.indent() <= 3 && HR_RE.test(line.expanded.slice(line.indent()))) break;
    if (isSiblingItem(line, ordered, delim, bulletCh, baseInd, limit)) {
      flushItem();
      cur = [];
      const itemInd = line.indent();
      const mw = ordered ? (LIST_ORDERED_RE.exec(line.expanded.slice(itemInd))[1].length + 1) : 1;
      const ci = contentIndentOf(line, itemInd, mw);
      const abs = itemInd + ci;
      const contentLine0 = line.stripLine(abs);
      // task marker
      let task = null;
      let contentLine = contentLine0;
      const tm = TASK_RE.exec(contentLine0.raw);
      if (tm) {
        task = tm[1] === ' ' ? false : true;
        contentLine = new Line(contentLine0.raw.slice(tm[0].length));
      }
      cur.push(contentLine);
      cur.task = task;
      cur.contentIndent = abs;
      j++;
      continue;
    }
    if (!cur) break;
    if (line.isBlank()) {
      // tentatively include; resolved by what follows
      let k = j + 1;
      while (k < lines.length && lines[k].isBlank()) k++;
      if (k < lines.length && isSiblingItem(lines[k], ordered, delim, bulletCh, baseInd, cur.contentIndent)) {
        loose = true;
        j = k;
        continue;
      }
      if (k < lines.length && lines[k].indent() >= cur.contentIndent) {
        // an empty item ends at a blank line (a following indented block is
        // a separate paragraph, not part of the empty item)
        if (cur.length === 1 && cur[0].raw === '') break;
        cur.push(new Line(''));
        j++;
        continue;
      }
      // blank line ends the list
      break;
    }
    if (line.indent() >= cur.contentIndent || hasOpenFence(cur, cur.contentIndent)) {
      // inside a fenced code block the lines are taken verbatim (only the
      // list content indent is stripped); a closing fence line is taken
      // too (it ends the fence on the next parse)
      const pushed = line.stripLine(Math.min(cur.contentIndent, line.indent()));
      pushed._origInd = line.indent();
      cur.push(pushed);
      j++;
      continue;
    }
    // a list item start at this list's level (even with a different
    // marker/delimiter) ends this list; it is never a lazy continuation.
    // A deeper-indented item is content of the current item (lazy/nested).
    if (line.indent() <= baseInd + 3 && (LIST_BULLET_RE.test(line.expanded.slice(line.indent())) || LIST_ORDERED_RE.test(line.expanded.slice(line.indent())))) break;
    // lazy continuation: only if the item's content ends with a paragraph
    if (interruptsParagraph(line, true)) break;
    if (cur.length === 0 || cur[cur.length - 1].raw === '') break;
    const tmp = parseBlocks(cur, links, false);
    if (!endsWithParagraph(tmp)) break;
    appendLazy(cur, line.indent() >= 4 ? line.strip(line.indent()) : line.raw);
    j++;
  }
  flushItem();
  // loose: items separated by a blank line, or an item directly containing
  // two blocks separated by a blank line
  const parsedItems = items.map(inner => {
    const task = inner.task;
    const children = parseBlocks(inner, links, false, true);
    return { task, children, blankInside: inner.some(l => l.raw === ''), inner };
  });
  for (const it of parsedItems) {
    // loose iff two top-level blocks of the item are separated by a blank
    // line (use the line spans recorded by parseBlocks)
    const ch = it.children;
    for (let a = 1; a < ch.length; a++) {
      const prev = ch[a - 1], cur = ch[a];
      if (prev._e === undefined || cur._s === undefined) { if (it.blankInside) { loose = true; break; } continue; }
      for (let b = prev._e; b < cur._s; b++) {
        if (it.inner[b] && it.inner[b].raw === '') { loose = true; break; }
      }
      if (loose) break;
    }
  }
  return {
    node: { t: 'list', ordered, start, loose, items: parsedItems },
    next: j,
  };
}

// ---------------------------------------------------------------------------
// HTML block parsing
// ---------------------------------------------------------------------------
function parseHtmlBlock(lines, i, htype, endsWithNewline) {
  const n = lines.length;
  let j = i;
  const blockLines = [];
  const endRe = htype === 1 ? /<\/(script|pre|style|textarea)>/i
    : htype === 2 ? /-->/
    : htype === 3 ? /\?>/
    : htype === 4 ? />/
    : htype === 5 ? /\]\]>/
    : null;
  if (endRe) {
    while (j < n) {
      blockLines.push(lines[j].raw);
      const done = endRe.test(lines[j].raw);
      j++;
      if (done) break;
    }
  } else {
    // types 6 and 7 end at a blank line or EOF
    while (j < n && !lines[j].isBlank()) {
      blockLines.push(lines[j].raw);
      j++;
    }
  }
  let raw = blockLines.join('\n');
  if (endRe) {
    // types 1-5 (end marker): the regex consumes only TRULY EMPTY following
    // lines; a whitespace-only line is not consumed, so the newline is kept
    let k = 0;
    while (j + k < n && lines[j + k].raw === '') k++;
    if (j < n) raw += '\n' + '\n'.repeat(k);
    else if (endsWithNewline) raw += '\n';
    raw = stripTrailingBlankLines(raw);
  } else {
    // types 6-7 (end at blank line): the regex consumes the blank line, and
    // ge() always drops the trailing newline when a blank line follows
    if (j < n) { /* terminated by a blank line: no trailing newline */ }
    else if (endsWithNewline) raw += '\n';
  }
  return { node: { t: 'html', text: raw }, next: j };
}

// ---------------------------------------------------------------------------
// Paragraph / setext / table parsing
// ---------------------------------------------------------------------------
function parseParagraph(lines, i, links, endsWithNewline, inList) {
  // table? the first line + a delimiter row directly after it.
  // A pure '-'/'=' run is a setext underline, not a table delimiter (marked's
  // GFM lheading only treats a delimiter with a '|' as a table).
  if (i + 1 < lines.length) {
    const dline = lines[i + 1];
    if (dline.indent() <= 3 && !SETEXT_RE.test(dline.expanded.slice(dline.indent()))) {
      const aligns = parseTableDelimiter(dline.expanded.slice(dline.indent()));
      if (aligns) {
        const headerCells = splitTableRow(lines[i].raw.trim(), 0);
        if (headerCells.length === aligns.length && headerCells.length > 0) {
          const rows = [];
          let k = i + 2;
          while (k < lines.length && !tableRowStops(lines[k])) {
            rows.push(splitTableRow(lines[k].raw.trim(), aligns.length));
            k++;
          }
          return {
            node: { t: 'table', aligns, header: headerCells, rows },
            next: k,
          };
        }
      }
    }
  }
  // collect the paragraph's lines (until a blank line or an interrupting block)
  const paraLines = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.isBlank()) {
      // a whitespace-only LAST line (no following newline) is paragraph
      // text, not a separator (e.g. a trailing '>  ' in a blockquote)
      if (j === lines.length - 1 && line.raw !== '' && !endsWithNewline) {
        paraLines.push(line);
        j++;
      }
      break;
    }
    if (j > i && interruptsParagraph(line, inList)) break;
    // a setext underline ends the paragraph (it is not a paragraph line)
    if (j > i && line.indent() <= 3 && SETEXT_RE.test(line.expanded.slice(line.indent()))) break;
    paraLines.push(line);
    j++;
  }
  // setext heading? the next line is a setext underline
  if (j < lines.length && !lines[j].isBlank() && lines[j].indent() <= 3) {
    const sm = SETEXT_RE.exec(lines[j].expanded.slice(lines[j].indent()));
    if (sm) {
      const text = paraLines.map(l => l.raw).join('\n').trim();
      return { node: { t: 'heading', depth: sm[1][0] === '=' ? 1 : 2, text }, next: j + 1 };
    }
  }
  const text = paraLines.map(l => l.raw).join('\n');
  return { node: { t: 'paragraph', text }, next: j };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------
function renderBlocks(nodes, links, shared) {
  const state = shared || newState(links);
  let out = '';
  for (const node of nodes) {
    if (node.t === 'def') continue;
    switch (node.t) {
      case 'heading': {
        out += '<h' + node.depth + '>' + renderInline(inlineTokens(node.text, state)) + '</h' + node.depth + '>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'code': {
        // marked renderer: exactly one trailing newline (unless empty)
        let r = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
        const info = node.lang || '';
        const firstWord = info.match(/^\S*/)[0];
        const langHtml = firstWord ? ' class="language-' + escapeHtmlNoEncode(firstWord) + '"' : '';
        out += '<pre><code' + langHtml + '>' + escapeHtmlEncode(r) + '</code></pre>\n';
        break;
      }
      case 'html': out += node.text; break;
      case 'blockquote': {
        out += '<blockquote>\n' + renderBlocks(node.children, links, state) + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
        let inner = '';
        for (const item of node.items) {
          let content = renderListItem(item, node.loose, links, state);
          inner += '<li>' + content + '</li>\n';
        }
        out += '<' + tag + startAttr + '>\n' + inner + '</' + tag + '>\n';
        break;
      }
      case 'table': {
        let h = '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < node.header.length; c++) {
          const align = node.aligns[c];
          h += align ? '<th align="' + align + '">' : '<th>';
          h += renderInline(inlineTokens(node.header[c], state)) + '</th>\n';
        }
        h += '</tr>\n</thead>\n';
        if (node.rows.length) {
          h += '<tbody>';
          for (const row of node.rows) {
            h += '<tr>\n';
            for (let c = 0; c < row.length; c++) {
              const align = node.aligns[c];
              h += align ? '<td align="' + align + '">' : '<td>';
              h += renderInline(inlineTokens(row[c], state)) + '</td>\n';
            }
            h += '</tr>\n';
          }
          h += '</tbody>';
        }
        h += '</table>\n';
        out += h;
        break;
      }
      case 'paragraph': {
        out += '<p>' + renderInline(inlineTokens(node.text, state)) + '</p>\n';
        break;
      }
    }
  }
  return out;
}
function renderListItem(item, loose, links, state) {
  const checkbox = (item.task !== null && item.task !== undefined)
    ? (item.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
    : '';
  const children = item.children;
  if (children.length === 0) return checkbox;
  // loose list: the checkbox goes INSIDE the first paragraph
  if (loose && children[0].t === 'paragraph') {
    let out = '<p>' + checkbox + renderInline(inlineTokens(children[0].text, state)) + '</p>\n';
    for (let idx = 1; idx < children.length; idx++) {
      const ch = children[idx];
      if (ch.t === 'paragraph') out += '<p>' + renderInline(inlineTokens(ch.text, state)) + '</p>\n';
      else out += renderBlocks([ch], links, state);
    }
    return out;
  }
  let s = checkbox;
  if (!loose && children.length === 1 && children[0].t === 'paragraph') {
    // tight list: paragraph content inline (no <p> wrapper)
    return s + renderInline(inlineTokens(children[0].text, state));
  }
  // tight list: paragraphs render inline (no <p>); loose list: <p> wrap
  let out = s;
  for (let idx = 0; idx < children.length; idx++) {
    const ch = children[idx];
    if (ch.t === 'paragraph' && loose) {
      out += '<p>' + renderInline(inlineTokens(ch.text, state)) + '</p>\n';
    } else if (ch.t === 'paragraph') {
      out += renderInline(inlineTokens(ch.text, state));
    } else {
      out += renderBlocks([ch], links, state);
    }
  }
  return out;
}
function newState(links) {
  return { links, inLink: false, linkEmitted: false, inRawBlock: false, linkParenPossible: true };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const { lines, endsWithNewline } = toLines(src);
  const links = Object.create(null);
  const nodes = parseBlocks(lines, links, endsWithNewline);
  return renderBlocks(nodes, links);
}
export default parse;
