// A fast, dependency-free Markdown renderer that matches marked 18.1.3 byte
// for byte (its default options: gfm on, breaks off, pedantic off, async
// off). Where marked departs from the CommonMark / GFM spec, marked wins.
//
// Architecture: a line-driven block builder turns the source into a tree of
// block nodes, then a span parser renders the inline content of each leaf.
// No input is recognised, nothing is cached across calls, and the output is
// a pure function of the markdown given.
//
// Notable marked behaviours reproduced here (each verified against the
// vendored marked as an oracle):
//  * tilde fences never strip content indentation; backtick fences strip up
//    to the fence indent.
//  * a fenced code block inside a list item does not swallow an
//    under-indented line: that line ends the block (and the item).
//  * a backtick fence whose info string holds a backtick cannot interrupt
//    a paragraph.
//  * HTML blocks of types 1-5 keep their trailing newline when the next
//    line is whitespace-only but non-empty.
//  * a table ends when the next line starts any block (heading, fence, list,
//    hr, html, blockquote) or is indented code.
//  * trailing spaces are stripped from the last paragraph of the last item
//    of every list (recursing through nested lists and blockquotes).
//  * extended autolinks scan through balanced (...) groups and keep ']' in
//    the URL; a trailing ')' is dropped only when unmatched, and the URL is
//    cut at the first unmatched '('.
//  * an inline <a ...> tag (space after <a) suppresses bare-URL and email
//    autolinks until a literal </a>; the flag is document-wide.
//  * a link whose text holds an odd number of backtick runs (counting
//    unclosed runs) and whose last backtick-code span with a backtick in
//    its content does not end the text does not form (inline or full
//    reference; collapsed and shortcut references are unaffected).
//  * emphasis: a strong closed by a run that a word character follows
//    blocks an outer emphasis of the same mark when the word runs to the
//    outer closer; a *** closer that leaves one '*' puts it inside the
//    strong when a closed inner emphasis is immediately followed by a
//    word character.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

const NAMED_ENTITIES = {
  quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00A0', copy: '\u00A9',
  reg: '\u00AE', trade: '\u2122', hellip: '\u2026', mdash: '\u2014',
  ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C',
  rdquo: '\u201D', laquo: '\u00AB', raquo: '\u00BB', times: '\u00D7',
  divide: '\u00F7', plusmn: '\u00B1', deg: '\u00B0', micro: '\u00B5',
  para: '\u00B6', middot: '\u00B7', bull: '\u2022', dagger: '\u2020',
  Dagger: '\u2021', permil: '\u2030', prime: '\u2032', Prime: '\u2033',
  oline: '\u203E', frasl: '\u2044', euro: '\u20AC', pound: '\u00A3',
  yen: '\u00A5', cent: '\u00A2', curren: '\u00A4', brvbar: '\u00A6',
  sect: '\u00A7', uml: '\u00A8', ordf: '\u00AA', ordm: '\u00BA',
  iquest: '\u00BF', iexcl: '\u00A1', szlig: '\u00DF', agrave: '\u00E0',
  aacute: '\u00E1', acirc: '\u00E2', atilde: '\u00E3', auml: '\u00E4',
  aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7', egrave: '\u00E8',
  eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB', igrave: '\u00EC',
  iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF', eth: '\u00F0',
  ntilde: '\u00F1', ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4',
  otilde: '\u00F5', ouml: '\u00F6', oslash: '\u00F8', ugrave: '\u00F9',
  uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC', yacute: '\u00FD',
  thorn: '\u00FE', yuml: '\u00FF', Agrave: '\u00C0', Aacute: '\u00C1',
  Acirc: '\u00C2', Atilde: '\u00C3', Auml: '\u00C4', Aring: '\u00C5',
  AElig: '\u00C6', Ccedil: '\u00C7', Egrave: '\u00C8', Eacute: '\u00C9',
  Ecirc: '\u00CA', Euml: '\u00CB', Igrave: '\u00CC', Iacute: '\u00CD',
  Icirc: '\u00CE', Iuml: '\u00CF', ETH: '\u00D0', Ntilde: '\u00D1',
  Ograve: '\u00D2', Oacute: '\u00D3', Ocirc: '\u00D4', Otilde: '\u00D5',
  Ouml: '\u00D6', Oslash: '\u00D8', Ugrave: '\u00D9', Uacute: '\u00DA',
  Ucirc: '\u00DB', Uuml: '\u00DC', Yacute: '\u00DD', THORN: '\u00DE',
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4',
  epsilon: '\u03B5', zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8',
  iota: '\u03B9', kappa: '\u03BA', lambda: '\u03BB', mu: '\u03BC',
  nu: '\u03BD', xi: '\u03BE', omicron: '\u03BF', pi: '\u03C0',
  rho: '\u03C1', sigma: '\u03C3', tau: '\u03C4', upsilon: '\u03C5',
  phi: '\u03C6', chi: '\u03C7', psi: '\u03C8', omega: '\u03C9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398',
  Iota: '\u0399', Kappa: '\u039A', Lambda: '\u039B', Mu: '\u039C',
  Nu: '\u039D', Xi: '\u039E', Omicron: '\u039F', Pi: '\u03A0',
  Rho: '\u03A1', Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5',
  Phi: '\u03A6', Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9',
  infin: '\u221E', ne: '\u2260', le: '\u2264', ge: '\u2265', minus: '\u2212',
  lowast: '\u2217', radic: '\u221A', prop: '\u221D', empty: '\u2205',
  isin: '\u2208', notin: '\u2209', ni: '\u220B', prod: '\u220F',
  sum: '\u2211', sim: '\u223C', cong: '\u2245', asymp: '\u2248',
  sub: '\u2282', sup: '\u2283', sube: '\u2286', supe: '\u2287',
  oplus: '\u2295', otimes: '\u2297', perp: '\u22A5', sdot: '\u22C5',
  lceil: '\u2308', rceil: '\u2309', lfloor: '\u230A', rfloor: '\u230B',
  lang: '\u27E8', rang: '\u27E9', loz: '\u25CA', spades: '\u2660',
  clubs: '\u2663', hearts: '\u2665', diams: '\u2666', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D',
  lrm: '\u200E', rlm: '\u200F', sbquo: '\u201A', bdquo: '\u201E',
  circ: '\u02C6', tilde: '\u02DC', shy: '\u00AD', apos: "'",
};

// ---------- character classes ----------

function asciiPunct(c) {
  return c !== undefined && c.length === 1 &&
    ((c >= '!' && c <= '/') || (c >= ':' && c <= '@') ||
     (c >= '[' && c <= '`') || (c >= '{' && c <= '~'));
}

function isPunctCh(c) {
  if (c === undefined || c === '') return false;
  return /[\p{P}\p{S}]/u.test(c);
}

function isUniWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
    c === '\f' || c === '\u00A0' || c === '\u1680' ||
    (c >= '\u2000' && c <= '\u200A') || c === '\u2028' || c === '\u2029' ||
    c === '\u202F' || c === '\u205F' || c === '\u3000' || c === '\uFEFF';
}

function isWordCh(c) {
  if (c === undefined || c === '') return false;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') || c === '_') return true;
  return /[\p{L}\p{N}]/u.test(c);
}

// Alphanumeric (letter or number), but not '_': used by the M1 rule to tell
// whether a strong's opener follows a word character directly.
function isAlnumCh(c) {
  if (c === undefined || c === '') return false;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9')) return true;
  return /[\p{L}\p{N}]/u.test(c);
}

function isAsciiLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isAsciiAlnum(c) {
  return isAsciiLetter(c) || (c >= '0' && c <= '9');
}

function isHexDigit(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
    (c >= 'A' && c <= 'F');
}

function isSchemeChar(c) {
  return isAsciiAlnum(c) || c === '+' || c === '-' || c === '.';
}

function isEmailLocalChar(c) {
  return isAsciiAlnum(c) ||
    ".!#$%&'*+/=?^_`{|}~-".indexOf(c) >= 0;
}

function isDomainChar(c) {
  return isAsciiAlnum(c) || c === '-' || c === '.' || c === '_';
}

// ---------- escaping / encoding ----------

const ENTITY_AT = /&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)/y;

function looksLikeEntity(src, i) {
  ENTITY_AT.lastIndex = i;
  return ENTITY_AT.test(src);
}

function escapeText(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else if (c === '&') {
      if (looksLikeEntity(s, i)) {
        const semi = s.indexOf(';', i);
        out += s.slice(i, semi + 1);
        i = semi;
      } else out += '&amp;';
    } else out += c;
    i++;
  }
  return out;
}

function escapeCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else if (c === '&') out += '&amp;';
    else out += c;
  }
  return out;
}

function escapeAttr(s) {
  return escapeText(s);
}

function stripBackslashes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && asciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// Numeric character reference: &#123; &#x1F600; &#X41;. Invalid (0,
// surrogates, > 0x10FFFF, empty) becomes U+FFFD. `body` is the text after
// '&' up to ';', with an optional 'x'/'X' prefix for hex.
function decodeNumeric(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    if (body.length === 1) return null;
    cp = parseInt(body.slice(1), 16);
  } else {
    if (body.length === 0) return null;
    cp = parseInt(body, 10);
  }
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Encode a link destination the way marked does: encodeURI, then restore
// an already-valid %XX escape in the source (marked preserves it; plain
// encodeURI would turn %20 into %2520), and a bare % stays %.
// encodeURI leaves [ ] alone, so percent-encode those too.
function encodeLink(dest) {
  let s = encodeURI(dest);
  s = s.replace(/%25([0-9A-Fa-f]{2})?/g, (m, hex) => (hex ? '%' + hex : '%'));
  s = s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  return s;
}

// Normalise a link label for reference lookup: collapse whitespace, trim,
// lowercase, and fold ß to ss.
function normalizeLabel(label) {
  return label.replace(/[\s]+/g, ' ').trim().toLowerCase()
    .replace(/\u00DF/g, 'ss');
}

function hasUnescapedOpenBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
    if (s[i] === '[') return true;
  }
  return false;
}

// ---------- line cursor ----------

// A cursor over one source line. `i` is the byte index, `col` the column
// (tabs expanded to the next multiple of 4). `partial` holds the spaces a
// tab was split into when a column advance stopped mid-tab. `itemIndent`
// accumulates the list-item indentation stripped for this line, so tab
// expansion in fenced code can use the column relative to the item content
// (marked counts the blockquote marker but not the list indent).
class Cursor {
  constructor(text, hasNL) {
    this.text = text;
    this.hasNL = hasNL;
    this.i = 0;
    this.col = 0;
    this.partial = 0;
    this.itemIndent = 0;
  }
  ch() {
    if (this.partial > 0) return ' ';
    if (this.i < this.text.length) return this.text[this.i];
    return this.hasNL ? '\n' : '';
  }
  chAt(k) {
    const idx = this.i + k;
    if (idx < this.text.length) return this.text[idx];
    if (idx === this.text.length) return this.hasNL ? '\n' : '';
    return '';
  }
  rest() {
    if (this.partial > 0) {
      return ' '.repeat(this.partial) + this.text.slice(this.i + 1);
    }
    return this.text.slice(this.i);
  }
  restFrom(k) {
    if (this.partial > 0) {
      if (k < this.partial) return ' '.repeat(this.partial - k) + this.text.slice(this.i + 1);
      k -= this.partial;
      const idx = this.i + 1 + k;
      return idx < this.text.length ? this.text.slice(idx) : '';
    }
    const idx = this.i + k;
    return idx < this.text.length ? this.text.slice(idx) : '';
  }
  // Advance by n columns. `base` is subtracted from the column when a
  // tab's width is measured, so a caller can measure the advance relative
  // to a list item's content instead of the absolute line start.
  advanceCols(n, base = 0) {
    while (n > 0) {
      if (this.partial > 0) {
        const k = this.partial < n ? this.partial : n;
        this.partial -= k;
        this.col += k;
        n -= k;
        if (this.partial === 0) this.i++;
      } else if (this.i < this.text.length) {
        const c = this.text[this.i];
        if (c === '\t') {
          const w = 4 - ((this.col - base) % 4);
          if (w <= n) { this.col += w; this.i++; n -= w; }
          else { this.partial = w - n; this.col += n; n = 0; }
        } else {
          this.i++;
          this.col++;
          n--;
        }
      } else {
        this.col += n;
        n = 0;
      }
    }
  }
  advanceChars(n) {
    while (n > 0 && this.i < this.text.length) {
      const c = this.text[this.i];
      if (c === '\t') this.col += 4 - (this.col % 4);
      else this.col++;
      this.i++;
      n--;
    }
    if (this.partial > 0) { this.partial = 0; this.i++; }
  }
  skipSpaces(maxCols) {
    let n = 0;
    while (n < maxCols) {
      const c = this.ch();
      if (c !== ' ' && c !== '\t') break;
      this.advanceCols(1);
      n++;
    }
    return n;
  }
  isBlank() {
    for (let k = 0; ; k++) {
      const c = this.chAt(k);
      // End of the line (with or without a newline) after only spaces/tabs
      // is blank; a line with no trailing newline ends in '' instead.
      if (c === '\n' || c === '') return true;
      if (c !== ' ' && c !== '\t') return false;
    }
  }
  // Columns of indentation at the cursor. `base` is subtracted from the
  // starting column, so a caller can measure the indent relative to a
  // list item's content instead of the absolute line start.
  indentCols(base = 0) {
    let n = 0;
    let col = this.col - base;
    let i = this.i;
    let partial = this.partial;
    while (true) {
      let c;
      if (partial > 0) c = ' ';
      else if (i < this.text.length) c = this.text[i];
      else break;
      if (c === ' ') {
        n++;
        col++;
        if (partial > 0) { partial--; if (partial === 0) i++; }
        else i++;
      } else if (c === '\t') {
        const w = 4 - (col % 4);
        n += w;
        col += w;
        i++;
        partial = 0;
      } else break;
    }
    return n;
  }
  // True when the line, from the cursor on, holds only spaces/tabs.
  onlySpaces() {
    for (let k = 0; ; k++) {
      const c = this.chAt(k);
      if (c === '\n' || c === '') return true;
      if (c !== ' ' && c !== '\t') return false;
    }
  }
}

// ---------- block nodes ----------

function mk(type) {
  return { t: type, children: [] };
}

// ---------- block builder ----------

class DocBuilder {
  constructor(src) {
    src = src.replace(/\r\n?/g, '\n');
    this.src = src;
    const raw = src.split('\n');
    if (raw.length && raw[raw.length - 1] === '' && src.endsWith('\n')) raw.pop();
    if (src === '') raw.length = 0;
    this.lines = raw.map((text, i) => new Cursor(text, i < raw.length - 1 || src.endsWith('\n')));
    this.root = mk('document');
    this.stack = [this.root];
    this.refs = new Map();
    this.blankLine = false;
    this.lineIdx = 0;
  }

  tip() { return this.stack[this.stack.length - 1]; }

  save(line) { return [line.i, line.col, line.partial, line.itemIndent]; }
  restore(line, s) {
    line.i = s[0];
    line.col = s[1];
    line.partial = s[2];
    line.itemIndent = s[3];
  }

  finalize(blk) {
    if (blk.t === 'code') {
      if (!blk.fenced) {
        while (blk.lines.length && blk.lines[blk.lines.length - 1] === '') blk.lines.pop();
      }
      blk.text = blk.lines.join('\n');
      if (blk.lines.length && blk.lines[blk.lines.length - 1] !== '') blk.text += '\n';
      delete blk.lines;
    }
    if (blk.t === 'html') {
      blk.text = blk.lines.join('\n');
      if (blk.trailNL === undefined) {
        blk.trailNL = blk.topLevel && blk.lastIdx === this.lines.length - 1 && blk.lastHasNL;
      }
      if (blk.trailNL) blk.text += '\n';
      delete blk.lines;
      delete blk.trailNL;
      delete blk.topLevel;
      delete blk.lastIdx;
      delete blk.lastHasNL;
    }
    if (blk.t === 'para' || blk.t === 'heading') {
      blk.text = blk.lines.join('\n');
      delete blk.lines;
    }
  }

  popTo(depth) {
    while (this.stack.length > depth) {
      const blk = this.stack.pop();
      // A blank line seen inside a blockquote does not loosen an outer
      // list: once the quote closes, that blank line separates nothing at
      // the list level (cm-320).
      if (blk.t === 'blockquote') this.blankLine = false;
      this.finalize(blk);
    }
  }

  // Strip the container prefixes of the open stack from the line. Returns
  // the stack depth of the last matched container, or -1 when a container
  // failed (then _failDepth holds the failing index and nothing was popped).
  // A blank line matches a list item but NOT a blockquote.
  matchContainers(line) {
    let depth = 0;
    for (let k = 1; k < this.stack.length; k++) {
      const blk = this.stack[k];
      if (blk.t === 'blockquote') {
        const save = this.save(line);
        line.skipSpaces(3);
        if (line.ch() !== '>') {
          this.restore(line, save);
          this._failDepth = k;
          return -1;
        }
        line.advanceChars(1);
        if (line.ch() === ' ') line.advanceCols(1);
        else if (line.ch() === '\t') line.advanceCols(1);
        depth = k;
      } else if (blk.t === 'list') {
        depth = k;
      } else if (blk.t === 'item') {
        if (line.isBlank()) {
          if (blk.children.length === 0) {
            this._failDepth = k;
            return -1;
          }
          depth = k;
          break;
        }
        const ind = line.indentCols();
        if (ind >= blk.indent) {
          line.advanceCols(blk.indent);
          line.itemIndent += blk.indent;
          depth = k;
        } else {
          this._failDepth = k;
          return -1;
        }
      } else {
        break;
      }
    }
    return depth;
  }

  // Content of lines[idx] after stripping the container prefixes of the
  // stack as it stands now. Returns a Cursor, or null when the line is blank
  // or does not continue the containers.
  peekContent(idx) {
    if (idx >= this.lines.length) return null;
    const line = new Cursor(this.lines[idx].text, this.lines[idx].hasNL);
    for (let k = 1; k < this.stack.length; k++) {
      const blk = this.stack[k];
      if (blk.t === 'blockquote') {
        if (line.isBlank()) return null;
        const save = this.save(line);
        line.skipSpaces(3);
        if (line.ch() !== '>') return null;
        line.advanceChars(1);
        if (line.ch() === ' ') line.advanceCols(1);
        else if (line.ch() === '\t') line.advanceCols(1);
      } else if (blk.t === 'list') {
        continue;
      } else if (blk.t === 'item') {
        if (line.isBlank()) return null;
        if (line.indentCols() < blk.indent) return null;
        line.advanceCols(blk.indent);
      } else {
        break;
      }
    }
    return line;
  }

  parse() {
    for (this.lineIdx = 0; this.lineIdx < this.lines.length; this.lineIdx++) {
      this.processLine(this.lines[this.lineIdx]);
    }
    this.popTo(0);
    return { root: this.root, refs: this.refs };
  }

  processLine(line) {
    const wasBlank = this.blankLine;
    // 1. Container matching. A failed container is a lazy paragraph
    // continuation when the tip is a paragraph and the line starts no
    // interrupting block; otherwise the unmatched blocks close. A fenced
    // code block absorbs a non-blank line that fails its enclosing LIST
    // ITEM's indent (a code line need not be indented to the list that
    // holds it), as long as the line starts no block: a closing fence at
    // indent 0 still ends the item and opens a new top-level code block.
    // But only when the code block already holds at least one line: the
    // FIRST content line at column 0 is not absorbed, it ends the list
    // and becomes a paragraph ('- item\n  ```sh\nprint("hi")' leaves the
    // code empty; an indented line first, then a column-0 line, IS
    // absorbed).
    if (this.matchContainers(line) === -1) {
      const tip0 = this.tip();
      if (tip0.t === 'code' && tip0.fenced && tip0.lines.length > 0 && !line.isBlank() && !this.startsAnyBlock(line) && this.stack[this._failDepth] && this.stack[this._failDepth].t === 'item') {
        this.addCodeLine(tip0, line);
        this.blankLine = false;
        return;
      }
      if (tip0.t === 'para' && !line.isBlank() && !this.startsAnyBlock(line)) {
        // Lazy continuation. A lazy line's leading indent is stripped by
        // exactly one indented-code level (4 columns) when it has at least
        // that much, and kept otherwise (cm-238, cm-291). A leading tab is
        // expanded to spaces first, from the current column.
        let text;
        {
          const rest = line.rest();
          let col = line.col;
          let lead = '';
          let k = 0;
          while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
            if (rest[k] === ' ') { lead += ' '; col++; k++; }
            else { const w = 4 - (col % 4); lead += ' '.repeat(w); col += w; k++; }
          }
          const indentCols = col - line.col;
          if (indentCols >= 4) lead = lead.slice(4);
          text = lead + rest.slice(k);
        }
        if (this.paragraphInBlockquote()) {
          const m = /^([ \t]*)(=+|-+)[ \t]*$/.exec(text);
          if (m) {
            let cols = 0;
            for (const ch of m[1]) {
              if (ch === ' ') cols++;
              else if (ch === '\t') cols += 4 - (cols % 4);
            }
            if (cols < 4) text = ' '.repeat(4 - cols) + text.slice(m[1].length);
          }
        }
        tip0.lines.push(text);
        this.blankLine = false;
        return;
      }
      this.popTo(this._failDepth);
    }

    // 2. Leaf blocks that consume the line wholesale.
    let tip = this.tip();
    if (tip.t === 'code' && tip.fenced) {
      if (this.isClosingFence(line)) {
        this.popTo(this.stack.length - 1);
        this.blankLine = false;
        return;
      }
      this.addCodeLine(tip, line);
      this.blankLine = false;
      return;
    }
    if (tip.t === 'code' && !tip.fenced) {
      // Indented code: blank lines and lines indented 4+ continue it. A
      // blank line inside the code is content, not a block separator.
      if (line.isBlank()) {
        const save = this.save(line);
        line.advanceCols(4);
        tip.lines.push(line.rest());
        this.restore(line, save);
        this.blankLine = false;
        return;
      }
      if (line.indentCols() >= 4) {
        line.advanceCols(4);
        tip.lines.push(line.rest());
        this.blankLine = false;
        return;
      }
      this.popTo(this.stack.length - 1);
    } else if (tip.t === 'html') {
      if (this.htmlEndsHere(tip, line)) {
        // Types 1-5: the closing marker is on this line; the line belongs
        // to the block. Types 6-7: a blank line ends it and is not consumed.
        if (tip.htmlType <= 5) {
          tip.lines.push(line.rest());
          tip.lastIdx = this.lineIdx;
          tip.lastHasNL = line.hasNL;
          tip.trailNL = this.htmlTrailNL(tip, line);
          this.popTo(this.stack.length - 1);
          this.blankLine = false;
          return;
        }
        this.popTo(this.stack.length - 1);
      } else {
        tip.lines.push(line.rest());
        tip.lastIdx = this.lineIdx;
        tip.lastHasNL = line.hasNL;
        this.blankLine = false;
        return;
      }
    } else if (tip.t === 'table') {
      // A line of only spaces (or empty) ends the table, but a line holding
      // a tab is a row of empty cells: the tab counts as content here.
      const rest = line.rest();
      let tableBlank = true;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== ' ') { tableBlank = false; break; }
      }
      if (tableBlank) {
        this.popTo(this.stack.length - 1);
      } else if (!line.isBlank() && (this.startsAnyBlock(line) || line.indentCols() >= 4)) {
        // A line with content that starts any block (heading, fence, list,
        // hr, html, blockquote) or is indented code ends the table; it is
        // not a row. A whitespace-only line is not indented code: a line
        // holding a tab is a row of empty cells.
        this.popTo(this.stack.length - 1);
      } else {
        const row = this.splitTableRow(rest);
        if (row === null) {
          this.popTo(this.stack.length - 1);
        } else {
          tip.rows.push(row);
          this.blankLine = false;
          return;
        }
      }
    }

    // A line inside a blockquote whose content after the '>' marker is
    // non-empty (even if only spaces) is paragraph content, not a blank
    // line: '>  ' contributes a space line to the paragraph (cm-241).
    // Outside a blockquote, a whitespace-only line is blank.
    const inBlockquote = this.stack.some((b) => b.t === 'blockquote');
    if (inBlockquote ? line.rest().length === 0 : line.isBlank()) {
      this.handleBlankLine();
      return;
    }

    // Paragraph continuation / conversion. A blank line ends the paragraph.
    const cur = this.tip();
    if (cur.t === 'para') {
      if (wasBlank) {
        this.popTo(this.stack.length - 1);
        this.openNewBlocks(line);
        this.blankLine = false;
        return;
      }
      if (this.trySetext(line)) { this.blankLine = false; return; }
      if (this.tryTableConvert(line)) { this.blankLine = false; return; }
      if (this.startsInterruptBlock(line)) {
        this.popTo(this.stack.length - 1);
        this.openNewBlocks(line);
        this.blankLine = false;
        return;
      }
      cur.lines.push(line.col > 0 ? this.expandLead(line.rest(), line.col - line.itemIndent) : line.rest());
      this.blankLine = false;
      return;
    }
    this.openNewBlocks(line);
    this.blankLine = false;
  }

  handleBlankLine() {
    const cur = this.tip();
    if (cur.t === 'para') this.popTo(this.stack.length - 1);
    this.blankLine = true;
  }

  isClosingFence(line) {
    const tip = this.tip();
    const save = this.save(line);
    line.skipSpaces(3);
    const c = line.ch();
    if (c !== tip.fenceChar) { this.restore(line, save); return false; }
    let n = 0;
    while (line.chAt(n) === tip.fenceChar) n++;
    if (n < tip.fenceLen) { this.restore(line, save); return false; }
    // A closing fence holds only spaces/tabs after the run.
    let j = n;
    while (line.chAt(j) === ' ' || line.chAt(j) === '\t') j++;
    const ok = line.chAt(j) === '\n' || line.chAt(j) === '';
    this.restore(line, save);
    return ok;
  }

  addCodeLine(tip, line) {
    // Marked expands a tab in fenced-code content while stripping the
    // containers (blockquote: J over the whitespace after '>', starting
    // at the marker length; list: J over the line's leading whitespace
    // from column 0, then the item indent is sliced off), and only then
    // strips the fence indent by CHARACTER count (Dt). So expand the
    // leading tabs first, using the column frame marked uses, and strip
    // the fence indent (backtick only) from the expanded spaces.
    // - innermost container is a blockquote: the tab column is measured
    //   on the list-stripped line, i.e. line.col minus itemIndent.
    // - innermost container is a list item: the tab column is the
    //   absolute column (list J starts at column 0 on the whole line).
    // - top level: the tab stays literal.
    let content = line.rest();
    const parent = this.stack[this.stack.length - 2];
    if (this.stack.length > 2 && parent && content.length) {
      let col = -1;
      // The innermost container's J frame starts fresh on the line after
      // the outer containers were stripped. For a blockquote that is the
      // content start in that frame: the absolute column, minus the list
      // indent, minus 2 for each blockquote above the innermost one
      // (each outer '> ' is stripped before the inner J runs). A list
      // item's J starts at column 0 on the whole line, so the tab column
      // is the absolute column.
      if (parent.t === 'blockquote') {
        let bq = 0;
        for (let s = 1; s < this.stack.length - 1; s++) if (this.stack[s].t === 'blockquote') bq++;
        col = line.col - line.itemIndent - 2 * Math.max(0, bq - 1);
      } else if (parent.t === 'item') col = line.col;
      if (col >= 0) {
        let k = 0;
        let out = '';
        while (k < content.length && (content[k] === ' ' || content[k] === '\t')) {
          if (content[k] === ' ') { out += ' '; col++; k++; }
          else {
            const w = 4 - (col % 4);
            out += ' '.repeat(w);
            col += w;
            k++;
          }
        }
        content = out + content.slice(k);
      }
    }
    // Tilde fences never strip content indentation; backtick fences strip
    // up to the fence indent by CHARACTER count from the raw leading
    // whitespace (marked's Dt slices min(leadingWhitespace.length,
    // fenceIndent.length) chars: a tab counts as one character, so an
    // indented fence strips a leading tab outright). After container tab
    // expansion the leading whitespace is all spaces, so this also
    // covers that case.
    if (tip.fenceChar === '`') {
      let strip = 0;
      while (strip < content.length && strip < tip.fenceIndent && (content[strip] === ' ' || content[strip] === '\t')) strip++;
      content = content.slice(strip);
    }
    tip.lines.push(content);
  }

  // Whether this line ends an open HTML block of types 1-7.
  htmlEndsHere(tip, line) {
    if (tip.htmlType >= 6) return line.isBlank();
    const rest = line.rest();
    if (tip.htmlType === 1) {
      return new RegExp('</' + tip.htmlTag + '\\s*>', 'i').test(rest);
    }
    if (tip.htmlType === 2) return rest.indexOf('-->') >= 0;
    if (tip.htmlType === 3) return rest.indexOf('?>') >= 0;
    if (tip.htmlType === 4) return rest.indexOf('>') >= 0;
    if (tip.htmlType === 5) return rest.indexOf(']]>') >= 0;
    return line.isBlank();
  }

  // Whether the HTML block's text keeps the trailing newline of its last
  // line. Types 1-5 keep it when the following line is whitespace-only
  // but non-empty (spaces/tabs); a truly empty next line, or non-blank
  // content, drops it.
  htmlTrailNL(html, line) {
    const next = this.lines[this.lineIdx + 1];
    if (next) {
      if (next.isBlank()) {
        // Whitespace-only but non-empty: the line holds at least one
        // space or tab before its newline.
        return next.text.length > 0;
      }
      const peek = this.peekContent(this.lineIdx + 1);
      return peek !== null;
    }
    return html.topLevel && line.hasNL;
  }

  // --- setext heading / table conversion (tip is a paragraph) ---
  trySetext(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    const c = line.ch();
    if (c !== '=' && c !== '-') { this.restore(line, save); return false; }
    let i = 0;
    while (line.chAt(i) === c) i++;
    let j = i;
    while (line.chAt(j) === ' ' || line.chAt(j) === '\t') j++;
    if (line.chAt(j) !== '\n') { this.restore(line, save); return false; }
    const para = this.tip();
    const h = mk('heading');
    h.level = c === '=' ? 1 : 2;
    // A setext heading's content drops the first line's leading whitespace
    // and the last line's trailing whitespace.
    const lines = para.lines.slice();
    lines[0] = lines[0].replace(/^[ \t]+/, '');
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
    h.lines = lines;
    const parent = this.stack[this.stack.length - 2];
    parent.children[parent.children.length - 1] = h;
    this.stack.pop();
    this.finalize(h);
    this.blankLine = false;
    return true;
  }

  // A one-line paragraph followed by a delimiter row becomes a table.
  tryTableConvert(line) {
    const para = this.tip();
    if (para.lines.length !== 1) return false;
    const header = this.splitTableRow(para.lines[0]);
    if (header === null) return false;
    const save = this.save(line);
    const delim = this.parseTableDelimiter(line.rest());
    if (!delim) { this.restore(line, save); return false; }
    if (delim.length !== header.length) { this.restore(line, save); return false; }
    const table = mk('table');
    table.header = header;
    table.aligns = delim;
    table.rows = [];
    const parent = this.stack[this.stack.length - 2];
    parent.children[parent.children.length - 1] = table;
    this.stack.pop();
    this.stack.push(table);
    this.blankLine = false;
    return true;
  }

  splitTableRow(s) {
    let a = 0;
    let b = s.length;
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
    s = s.slice(a, b);
    const cells = [];
    let cur = '';
    let i = 0;
    if (s[0] === '|') i = 1;
    let end = s.length;
    if (end > i && s[end - 1] === '|' && s[end - 2] !== '\\') end--;
    for (; i < end; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < end && s[i + 1] === '|') {
        // An escaped pipe is a literal pipe in the cell. The backslash is
        // resolved here, not by the span parser: a code span's content is
        // not escape-processed, so `\|` inside one must still come out as |.
        cur += '|';
        i++;
        continue;
      }
      if (c === '\\' && i + 1 < end && s[i + 1] === '\\') {
        cur += s[i] + s[i + 1];
        i++;
        continue;
      }
      if (c === '|') {
        cells.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  parseTableDelimiter(s) {
    if (s.indexOf('|') < 0) return null;
    const cells = this.splitTableRow(s);
    if (cells === null || cells.length === 0) return null;
    const aligns = [];
    for (const cell of cells) {
      const m = /^(:?)-+(:?)$/.exec(cell);
      if (!m) return null;
      if (m[1] && m[2]) aligns.push('center');
      else if (m[1]) aligns.push('left');
      else if (m[2]) aligns.push('right');
      else aligns.push(null);
    }
    return aligns;
  }

  // Does this line start any block at all (used for lazy continuations: a
  // line that starts a block outside the failed container is not lazy)?
  // Any list marker counts, and so does any HTML block type. Indented code
  // does not: an indented lazy line stays paragraph text. A backtick fence
  // whose info string holds a backtick is not a fence at all.
  startsAnyBlock(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    const c = line.ch();
    if (c === '#') { this.restore(line, save); return true; }
    if (c === '`' || c === '~') {
      let n = 0;
      while (line.chAt(n) === c) n++;
      if (n >= 3) {
        if (c === '`') {
          let j = n;
          let hasTick = false;
          while (line.chAt(j) !== '\n' && line.chAt(j) !== '') {
            if (line.chAt(j) === '`') { hasTick = true; break; }
            j++;
          }
          if (!hasTick) { this.restore(line, save); return true; }
        } else {
          this.restore(line, save);
          return true;
        }
      }
    }
    if (c === '<') {
      const ht = this.htmlBlockType(line);
      this.restore(line, save);
      if (ht !== 0) return true;
    }
    if (c === '-' || c === '*' || c === '_') {
      const rest = line.rest();
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) { this.restore(line, save); return true; }
    }
    if (c === '>') { this.restore(line, save); return true; }
    this.restore(line, save);
    const marker = this.parseListMarker(line, true);
    if (marker) { this.restore(line, save); return true; }
    this.restore(line, save);
    return false;
  }

  paragraphInBlockquote() {
    for (let k = this.stack.length - 1; k >= 1; k--) {
      if (this.stack[k].t === 'blockquote') return true;
    }
    return false;
  }

  // Can this line start a block that interrupts a paragraph? (ATX heading,
  // fenced code, HTML block types 1-6, thematic break, blockquote, or a list
  // that may interrupt.) A backtick fence whose info string holds a
  // backtick cannot interrupt: it is paragraph text (an inline code span).
  startsInterruptBlock(line) {
    const save = this.save(line);
    const c0 = line.ch();
    line.skipSpaces(3);
    let c = line.ch();
    if (c === '#') { this.restore(line, save); return true; }
    if (c === '`' || c === '~') {
      let n = 0;
      while (line.chAt(n) === c) n++;
      if (n >= 3) {
        if (c === '`') {
          let j = n;
          let hasTick = false;
          while (line.chAt(j) !== '\n' && line.chAt(j) !== '') {
            if (line.chAt(j) === '`') { hasTick = true; break; }
            j++;
          }
          if (!hasTick) { this.restore(line, save); return true; }
        } else {
          this.restore(line, save);
          return true;
        }
      }
    }
    if (c === '<') {
      const ht = this.htmlBlockType(line);
      this.restore(line, save);
      if (ht !== 0 && ht !== 7) return true;
    }
    if (c === '-' || c === '*' || c === '_') {
      const rest = line.rest();
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) { this.restore(line, save); return true; }
    }
    if (c === '>') { this.restore(line, save); return true; }
    this.restore(line, save);
    const marker = this.parseListMarker(line, true);
    if (marker) {
      if (!marker.ordered) {
        if (!marker.empty) { this.restore(line, save); return true; }
      } else if (marker.start === 1 || this.paragraphInListItem()) {
        // An ordered list interrupts a top-level paragraph only when it
        // starts with 1; inside a list item the marker is a nested list,
        // so any start number interrupts the item's paragraph. An empty
        // item never interrupts (cm-285: '1.' stays paragraph text).
        if (!marker.empty) {
          this.restore(line, save);
          return true;
        }
      }
    }
    this.restore(line, save);
    return false;
  }

  paragraphInListItem() {
    for (let k = 1; k < this.stack.length; k++) {
      if (this.stack[k].t === 'item') return true;
    }
    return false;
  }

  // --- block starts ---
  openNewBlocks(line) {
    // A blank line before a new block inside a list item makes the list
    // loose. (A blank line before a new item is handled by pushListItem.)
    // When the tip is a list AND the line is a list item for it, the new
    // item joins that list and pushListItem marks it loose; the walk below
    // would otherwise find the OUTER item (the old item was already popped)
    // and loosen the wrong list. When the line is not such an item, the new
    // block belongs to the item that contains the tip list, so the walk
    // runs (cm-325: 'baz' after a nested list loosens the outer list).
    let skipLoose = false;
    if (this.blankLine && this.tip().t === 'list') {
      const save = this.save(line);
      const item = this.parseListMarker(line, false);
      skipLoose = !!(item && this.listMatches(this.tip(), item));
      this.restore(line, save);
    }
    if (this.blankLine && !skipLoose) {
      // Walk down to the innermost item (a nested list on top does not stop
      // the search: it belongs to the item below it, and a blank line before
      // a new block in that item makes the item's list loose, cm-325).
      for (let k = this.stack.length - 1; k >= 1; k--) {
        const blk = this.stack[k];
        if (blk.t === 'item') {
          if (blk.children.length > 0) {
            const list = this.stack[k - 1];
            if (list && list.t === 'list') list.loose = true;
          }
          break;
        }
      }
    }
    while (true) {
      if (line.isBlank()) return;
      const tip = this.tip();
      if (tip.t === 'list') {
        // A thematic break ends the list; it is not a list item.
        if (!this.isHRLine(line)) {
          const save = this.save(line);
          const item = this.parseListMarker(line, false);
          if (item && this.listMatches(tip, item)) {
            this.pushListItem(tip, item, line);
            continue;
          }
          this.restore(line, save);
        }
        this.popTo(this.stack.length - 1);
        continue;
      }
      // Link reference definition.
      const defLines = this.tryLinkDef(line);
      if (defLines > 0) {
        this.lineIdx += defLines - 1;
        return;
      }
      // ATX heading.
      const atx = this.tryATX(line);
      if (atx) return;
      // Fenced code.
      const fence = this.tryFence(line);
      if (fence) return;
      // HTML block.
      const html = this.tryHtmlBlock(line);
      if (html) return;
      // Thematic break.
      if (this.tryHR(line)) return;
      // Blockquote.
      if (this.tryBlockquote(line)) continue;
      // List.
      const marker = this.parseListMarker(line, false);
      if (marker) {
        this.pushList(marker, line);
        continue;
      }
      // Indented code. The indent is measured relative to the enclosing
      // list item's content (indentCols(itemIndent)): a tab after a
      // blockquote marker inside an item expands from the item-content
      // column, so '> \tindented' in an item of indent 2 is an indent of
      // 2 — a paragraph — not 4 (indented code).
      if (line.indentCols(line.itemIndent) >= 4) {
        const code = mk('code');
        code.fenced = false;
        code.lines = [];
        line.advanceCols(4);
        code.lines.push(line.rest());
        this.tip().children.push(code);
        this.stack.push(code);
        this.blankLine = false;
        return;
      }
      // Paragraph: the text starts where the containers left it (leading
      // spaces are kept, exactly as marked renders them). A leading tab
      // is expanded to spaces from the column relative to the list-item
      // content (col - itemIndent: '  > \tindented' inside an item of
      // indent 2 puts the tab at relative column 2, so it becomes two
      // spaces), but only when a container was actually consumed
      // (col > 0). At the top level a leading tab is literal content.
      const para = mk('para');
      const pcol = line.col - line.itemIndent;
      para.lines = [line.col > 0 ? this.expandLead(line.rest(), pcol) : line.rest()];
      this.tip().children.push(para);
      this.stack.push(para);
      this.blankLine = false;
      return;
    }
  }

  // Expand leading tabs in `text` to spaces, measuring from column `col`
  // (a tab advances to the next multiple of 4). Leading spaces pass
  // through unchanged. Used for paragraph text after the containers have
  // been stripped, where a tab is content, not indentation.
  expandLead(text, col) {
    let out = '';
    let k = 0;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) {
      if (text[k] === ' ') { out += ' '; col++; k++; }
      else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; k++; }
    }
    return out + text.slice(k);
  }

  tryATX(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    let level = 0;
    while (line.ch() === '#' && level < 7) { line.advanceChars(1); level++; }
    if (level === 0 || level > 6) { this.restore(line, save); return false; }
    const c = line.ch();
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '') {
      this.restore(line, save);
      return false;
    }
    // All spaces/tabs after the hashes are the separator.
    while (line.ch() === ' ' || line.ch() === '\t') line.advanceCols(1);
    let text = line.rest();
    // Strip trailing whitespace, then a closing sequence of #s preceded by a
    // space (unless the whole content is just #s, which is then empty).
    text = text.replace(/[ \t]+$/, '');
    const m = /^(.*?)[ \t]+#+$/.exec(text);
    if (m) text = m[1];
    else if (/^#+$/.test(text)) text = '';
    const h = mk('heading');
    h.level = level;
    h.lines = [text];
    this.tip().children.push(h);
    this.stack.push(h);
    this.finalize(h);
    this.stack.pop();
    this.blankLine = false;
    return true;
  }

  tryFence(line) {
    const save = this.save(line);
    // The fence's indent is relative to the container content, not the
    // absolute column: a '>' marker must not count as indent, or code lines
    // inside a blockquote lose a leading space.
    const colBefore = line.col;
    line.skipSpaces(3);
    const fenceIndent = line.col - colBefore;
    const c = line.ch();
    if (c !== '`' && c !== '~') { this.restore(line, save); return false; }
    let n = 0;
    while (line.ch() === c) { line.advanceChars(1); n++; }
    if (n < 3) { this.restore(line, save); return false; }
    let info = line.rest();
    if (c === '`' && info.indexOf('`') >= 0) { this.restore(line, save); return false; }
    // The info string is the first word, after leading spaces, with
    // backslash escapes resolved.
    info = info.replace(/^[ \t]+/, '');
    const sp = info.search(/[ \t]/);
    if (sp >= 0) info = info.slice(0, sp);
    info = stripBackslashes(info);
    const code = mk('code');
    code.fenced = true;
    code.fenceChar = c;
    code.fenceLen = n;
    code.fenceIndent = fenceIndent;
    code.info = info;
    code.lines = [];
    this.tip().children.push(code);
    this.stack.push(code);
    this.blankLine = false;
    return true;
  }

  // HTML block start. Returns the type (1-7) or 0 when the line does not start
  // one. The line cursor is left after any consumed indentation.
  htmlBlockType(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    const rest = line.rest();
    if (rest[0] !== '<') { this.restore(line, save); return 0; }
    const m1 = /^<(script|pre|textarea|style)(?:[\s>]|\/>|$)/i.exec(rest);
    if (m1) return 1;
    if (rest.startsWith('<!--')) return 2;
    if (rest.startsWith('<?')) return 3;
    if (/^<![A-Za-z]/.test(rest)) return 4;
    if (rest.startsWith('<![CDATA[')) return 5;
    const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(rest);
    if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
    // Type 7: a complete open or closing tag alone on the line. The tag
    // must be a valid tag (well-formed attributes); a bare regex is too
    // permissive (<a h*#ref="hi"> is not a tag).
    const m7 = parseTagAt(rest, 0, rest.length);
    if (m7 >= 0 && rest.slice(m7).trim() === '') return 7;
    this.restore(line, save);
    return 0;
  }

  tryHtmlBlock(line) {
    const save = this.save(line);
    const type = this.htmlBlockType(line);
    if (type === 0) { this.restore(line, save); return false; }
    // The block's text keeps the line as it stands, leading spaces included.
    this.restore(line, save);
    const html = mk('html');
    html.htmlType = type;
    html.topLevel = this.stack.length === 1;
    html.lines = [];
    html.lastIdx = this.lineIdx;
    html.lastHasNL = line.hasNL;
    if (type === 1) {
      const m = /^<(script|pre|textarea|style)/i.exec(line.rest());
      html.htmlTag = m[1].toLowerCase();
    }
    html.lines.push(line.rest());
    // A type 1-5 block may already end on this very line.
    if (type <= 5 && this.htmlEndsHere(html, line)) {
      html.trailNL = this.htmlTrailNL(html, line);
      this.tip().children.push(html);
      this.finalize(html);
      this.blankLine = false;
      return true;
    }
    this.tip().children.push(html);
    this.stack.push(html);
    this.blankLine = false;
    return true;
  }

  isHRLine(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    const c = line.ch();
    if (c !== '-' && c !== '*' && c !== '_') { this.restore(line, save); return false; }
    const rest = line.rest();
    const ok = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest);
    this.restore(line, save);
    return ok;
  }

  tryHR(line) {
    if (!this.isHRLine(line)) return false;
    const hr = mk('hr');
    this.tip().children.push(hr);
    this.finalize(hr);
    this.blankLine = false;
    return true;
  }

  tryBlockquote(line) {
    const save = this.save(line);
    line.skipSpaces(3);
    if (line.ch() !== '>') { this.restore(line, save); return false; }
    line.advanceChars(1);
    if (line.ch() === ' ') line.advanceCols(1);
    else if (line.ch() === '\t') line.advanceCols(1);
    const bq = mk('blockquote');
    this.tip().children.push(bq);
    this.stack.push(bq);
    this.blankLine = false;
    return true;
  }

  // Parse a list marker at the cursor. Returns null when there is none, or
  // {ordered, start, indent, empty, bullet}. `interrupt` is true when the
  // marker is being tested as a paragraph interrupter (an empty item never
  // interrupts, and an ordered marker must start with 1 at the top level).

  // Parse a list item marker at the cursor. Returns null when there is none.
  // `probe` means: do not leave the cursor moved (used when testing whether
  // a line interrupts a paragraph).
  parseListMarker(line, probe) {
    const save = this.save(line);
    const startCol = line.col;
    line.skipSpaces(3);
    const markerCol = line.col;
    const c = line.ch();
    let bullet = null;
    let ordered = false;
    let start = 0;
    let delim = null;
    let markerLen = 0;
    if (c === '-' || c === '+' || c === '*') {
      bullet = c;
      markerLen = 1;
      line.advanceChars(1);
    } else if (c >= '0' && c <= '9') {
      let num = 0;
      let digits = 0;
      while (digits < 9 && line.ch() >= '0' && line.ch() <= '9') {
        num = num * 10 + (line.ch().charCodeAt(0) - 48);
        line.advanceChars(1);
        digits++;
      }
      if (digits === 0) { this.restore(line, save); return null; }
      // A 10th digit disqualifies the marker.
      if (line.ch() >= '0' && line.ch() <= '9') { this.restore(line, save); return null; }
      const d = line.ch();
      if (d !== '.' && d !== ')') { this.restore(line, save); return null; }
      ordered = true;
      start = num;
      delim = d;
      markerLen = digits + 1;
      line.advanceChars(1);
    } else {
      this.restore(line, save);
      return null;
    }
    // The marker must be followed by 1+ spaces/tabs or the end of the line.
    const after = line.ch();
    if (after !== ' ' && after !== '\t' && after !== '\n') {
      this.restore(line, save);
      return null;
    }
    // Content indent: the whitespace after the marker, in columns. It is
    // measured relative to the position where the container's content starts
    // (startCol), because continuation lines are measured from there too.
    let wsCols = 0;
    {
      let col = line.col;
      let i = line.i;
      let partial = line.partial;
      while (true) {
        let ch;
        if (partial > 0) ch = ' ';
        else if (i < line.text.length) ch = line.text[i];
        else break;
        if (ch === ' ') {
          wsCols++;
          col++;
          if (partial > 0) { partial--; if (partial === 0) i++; }
          else i++;
        } else if (ch === '\t') {
          const w = 4 - (col % 4);
          wsCols += w;
          col += w;
          i++;
          partial = 0;
        } else break;
      }
    }
    let contentIndent;
    let empty = false;
    // An item with only whitespace after the marker is empty: its content
    // indent is marker + 1, not marker + all the trailing spaces (cm-279:
    // '-   ' has content indent 2, so the following '  foo' is its content).
    const restAfterMarker = line.rest();
    let onlyWs = true;
    for (let k = 0; k < restAfterMarker.length; k++) {
      const ch = restAfterMarker[k];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n') { onlyWs = false; break; }
    }
    if (onlyWs) {
      contentIndent = markerCol + markerLen + 1;
      empty = true;
    } else if (wsCols >= 1 && wsCols <= 4) {
      contentIndent = markerCol + markerLen + wsCols;
    } else {
      contentIndent = markerCol + markerLen + 1;
    }
    // Move the cursor to the content position.
    line.advanceCols(contentIndent - line.col);
    const info = { bullet, ordered, start, delim, indent: contentIndent - startCol, empty, startCol };
    if (probe) this.restore(line, save);
    return info;
  }

  listMatches(list, item) {
    if (list.ordered !== item.ordered) return false;
    if (item.ordered) return list.delim === item.delim;
    return list.bullet === item.bullet;
  }

  pushList(marker, line) {
    const list = mk('list');
    list.ordered = marker.ordered;
    list.bullet = marker.bullet;
    list.delim = marker.delim;
    list.start = marker.start;
    list.loose = false;
    this.tip().children.push(list);
    this.stack.push(list);
    this.pushListItem(list, marker, line);
  }

  pushListItem(list, marker, line) {
    // A blank line before a new item (after the first) makes the list loose.
    if (this.blankLine && list.children.length > 0) list.loose = true;
    const item = mk('item');
    item.indent = marker.indent;
    item.task = null;
    // Task list checkbox: [ ], [x], [X] followed by a space/tab or EOL.
    if (!marker.empty) {
      const rest = line.rest();
      const m = /^\[([ xX])\]([ \t]|\n|$)/.exec(rest);
      if (m) {
        item.task = m[1] === ' ' ? 'unchecked' : 'checked';
        line.advanceChars(3);
        if (line.ch() === ' ' || line.ch() === '\t') line.advanceCols(1);
      }
    }
    list.children.push(item);
    this.stack.push(item);
    this.blankLine = false;
  }

  // --- link reference definitions ---
  // Parse a link reference definition starting at the cursor. Returns the
  // number of source lines consumed (1..4) or 0. The definition is parsed
  // from the current line plus up to 10 following lines (after container
  // stripping). The first definition for a label wins.
  tryLinkDef(line) {
    const parts = [line.rest()];
    for (let k = 1; k <= 10; k++) {
      const nxt = this.peekContent(this.lineIdx + k);
      if (nxt === null) break;
      parts.push(nxt.rest());
    }
    const s = parts.join('\n');
    const res = this.parseDefText(s);
    if (!res) return 0;
    const key = normalizeLabel(res.label);
    // An empty label (all whitespace) or an overlong one is not a
    // definition at all: the lines stay as ordinary text.
    if (!key || res.label.length > 999) return 0;
    if (!this.refs.has(key)) {
      this.refs.set(key, { dest: res.dest, title: res.title });
    }
    // Lines consumed: the part containing the last character of the def.
    let pos = 0;
    for (let p = 0; p < parts.length; p++) {
      if (res.end <= pos + parts[p].length) return p + 1;
      pos += parts[p].length + 1;
    }
    return parts.length;
  }

  // Skip spaces/tabs and at most one newline. Returns the new index, or -1
  // when a blank line is hit.
  skipDefWs(s, i) {
    let nl = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\n') {
        nl++;
        if (nl > 1) return -1;
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  // Parse the whole definition text (label ':' dest [title], then end of
  // line). Returns {label, dest, title, end} or null.
  parseDefText(s) {
    let i = 0;
    let sp = 0;
    while (s[i] === ' ' && sp < 3) { i++; sp++; }
    if (s[i] !== '[') return null;
    i++;
    // Label: no unescaped '[' inside, newlines allowed (but no blank line).
    // Backslash escapes stay raw in the label (they are resolved when the
    // label is rendered as text, not when it is matched).
    let label = '';
    let closed = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        label += c + s[i + 1];
        i += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') { closed = true; i++; break; }
      if (c === '\n') {
        if (s[i + 1] === '\n') return null;
        label += ' ';
        i++;
        continue;
      }
      label += c;
      i++;
    }
    if (!closed || label.length === 0) return null;
    if (s[i] !== ':') return null;
    i++;
    i = this.skipDefWs(s, i);
    if (i < 0) return null;
    if (s[i] === '<') {
      // Angle destination: try each '>' on this line in turn (marked's
      // permissive rule) and keep the first one whose remainder completes.
      // An escaped \> is part of the destination, not the closer.
      let j = i + 1;
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
        if (s[j] === '>') {
          const fin = this.defFinish(s, j + 1);
          if (fin) return { label, dest: stripBackslashes(s.slice(i + 1, j)), title: fin.title, end: fin.end };
        }
        j++;
      }
      return null;
    }
    // Bare destination: non-space, non-control characters, balanced parens,
    // backslash escapes. It cannot span lines.
    let j = i;
    let ddepth = 0;
    let dest = '';
    while (j < s.length) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < s.length && asciiPunct(s[j + 1])) {
        dest += s[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') ddepth++;
      else if (c === ')') {
        if (ddepth === 0) break;
        ddepth--;
      }
      dest += c;
      j++;
    }
    if (dest.length === 0 || ddepth !== 0) return null;
    const fin = this.defFinish(s, j);
    if (!fin) return null;
    return { label, dest, title: fin.title, end: fin.end };
  }

  // After the destination at index i, finish the definition: an optional
  // title (same line or the next), then only whitespace to the end of a line.
  // Returns {end, title} or null.
  defFinish(s, i) {
    let j = i;
    const wsStart = j;
    while (s[j] === ' ' || s[j] === '\t') j++;
    const hadWs = j > wsStart;
    let title = null;
    if (s[j] === '"' || s[j] === "'" || s[j] === '(') {
      // A title must be separated from the destination by whitespace; a
      // quote/paren glued to the destination is trailing junk, not a title.
      if (!hadWs) return null;
      const t = this.parseDefTitle(s, j);
      if (!t) return null;
      title = t.title;
      j = t.end;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === '\n' || j >= s.length) return { end: j, title };
      return null;
    }
    if (s[j] === '\n') {
      // Maybe the title is on the next line. If it is there but malformed
      // (or followed by junk), the definition still stands without a
      // title and the next line is not consumed.
      let k = j + 1;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
        const t = this.parseDefTitle(s, k);
        if (!t) return { end: j, title: null };
        title = t.title;
        k = t.end;
        while (s[k] === ' ' || s[k] === '\t') k++;
        if (s[k] === '\n' || k >= s.length) return { end: k, title };
        return { end: j, title: null };
      }
      return { end: j, title: null };
    }
    if (j >= s.length) return { end: j, title: null };
    return null;
  }

  // Parse a link title at index i of s ('"' / "'" / '(' form). Returns
  // {title, end} or null. The title may span lines, but not a blank line.
  parseDefTitle(s, i) {
    const q = s[i];
    let j = i + 1;
    let title = '';
    if (q === '"' || q === "'") {
      while (j < s.length) {
        const c = s[j];
        if (c === '\\' && j + 1 < s.length && asciiPunct(s[j + 1])) {
          title += s[j + 1];
          j += 2;
          continue;
        }
        if (c === q) return { title, end: j + 1 };
        if (c === '\n') {
          if (s[j + 1] === '\n') return null;
          title += '\n';
          j++;
          continue;
        }
        title += c;
        j++;
      }
      return null;
    }
    // '(' form: no unescaped '(' inside; ends at the first unescaped ')'.
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && asciiPunct(s[j + 1])) {
        title += s[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') return null;
      if (c === ')') return { title, end: j + 1 };
      if (c === '\n') {
        if (s[j + 1] === '\n') return null;
        title += '\n';
        j++;
        continue;
      }
      title += c;
      j++;
    }
    return null;
  }
}

// ---------- shared tag / title / autolink helpers ----------
// A domain label for www/scheme autolinks: starts with alnum or '-'
// (never '_'), then alnum, '-' or '_' — marked links www.foo_bar.com
// and www.-foo.com but not www._foo.com.
// Email domains are more permissive (labels may start with '_'):
// see EMAIL_LABEL_RE.
const LABEL_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]*$/;
const EMAIL_LABEL_RE = /^[A-Za-z0-9_-]+$/;
function validDomainLabels(domain, minLabels, re = LABEL_RE) {
  const labels = domain.split('.');
  if (labels.length < minLabels) return false;
  for (const lab of labels) {
    if (!re.test(lab)) return false;
  }
  return true;
}
function isValidEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  for (let i = 0; i < local.length; i++) {
    if (!isEmailLocalChar(local[i])) return false;
  }
  return validDomainLabels(domain, 2, EMAIL_LABEL_RE);
}

// Trim a GFM extended autolink: trailing ? ! . , : ; * _ ~, a trailing ')'
// only when that specific ')' is unmatched in a stack scan (repeat), then
// everything from the first unmatched '('. A truncation can expose trailing
// punctuation again, so strip it a second time.
function trimAutolink(url) {
  const PUNCT = '?!.,:;*_~';
  // Repeat the whole trim until stable: trimming a ')' can expose a '.',
  // trimming that can expose another ')', and so on
  // ('https://x/nova).)' -> 'https://x/nova').
  let prev;
  do {
    prev = url;
    let end = url.length;
    while (end > 0 && PUNCT.indexOf(url[end - 1]) >= 0) end--;
    url = url.slice(0, end);
    // Drop a trailing ')' only when that specific ')' is unmatched.
    while (url.length > 0 && url[url.length - 1] === ')') {
      let depth = 0;
      let matched = false;
      for (let i = 0; i < url.length; i++) {
        if (url[i] === '(') depth++;
        else if (url[i] === ')') {
          if (depth > 0) {
            depth--;
            if (i === url.length - 1) matched = true;
          }
        }
      }
      if (!matched) url = url.slice(0, -1);
      else break;
    }
    // Truncate at the first unmatched '('.
    {
      const stack = [];
      for (let i = 0; i < url.length; i++) {
        if (url[i] === '(') stack.push(i);
        else if (url[i] === ')') stack.pop();
      }
      if (stack.length) url = url.slice(0, stack[0]);
    }
    end = url.length;
    while (end > 0 && PUNCT.indexOf(url[end - 1]) >= 0) end--;
    url = url.slice(0, end);
  } while (url !== prev);
  return url;
}

// Parse an HTML tag starting at index i of s (s has length len). Returns
// the index just past the tag, or -1. Shared by block HTML (type 7) and
// inline HTML: tag name, then attributes separated by whitespace, each an
// optional name = value (quoted or unquoted); a closing tag takes no
// attributes.
function parseTagAt(s, i, len) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (!isAsciiLetter(s[j])) return -1;
  j++;
  while (isAsciiAlnum(s[j]) || s[j] === '-') j++;
  if (closing) {
    while (j < len && isUniWs(s[j])) j++;
    if (s[j] === '>') return j + 1;
    return -1;
  }
  while (true) {
    const wsStart = j;
    while (j < len && isUniWs(s[j])) j++;
    const hadWs = j > wsStart;
    if (j >= len) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') {
      if (s[j + 1] === '>') return j + 2;
      return -1;
    }
    if (!hadWs) return -1;
    if (!isAsciiLetter(s[j]) && s[j] !== '_' && s[j] !== ':') return -1;
    j++;
    while (isAsciiAlnum(s[j]) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-') j++;
    // Whitespace before '=' is allowed, but only consume it when '=' really
    // follows: otherwise the space belongs to the next attribute (which
    // needs hadWs to be recognized, e.g. '_boolean zoop:33=...').
    const wsAfterName = j;
    while (j < len && isUniWs(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < len && isUniWs(s[j])) j++;
      if (s[j] === '"') {
        j++;
        while (j < len && s[j] !== '"') j++;
        if (j >= len) return -1;
        j++;
      } else if (s[j] === "'") {
        j++;
        while (j < len && s[j] !== "'") j++;
        if (j >= len) return -1;
        j++;
      } else {
        const start = j;
        while (j < len) {
          const c = s[j];
          if (c === ' ' || c === '\t' || c === '\n' || c === '"' || c === "'" || c === '=' || c === '<' || c === '>' || c === '`') break;
          j++;
        }
        if (j === start) return -1;
      }
    } else {
      // No '=': the attribute has no value, and the whitespace we skipped
      // belongs to the next attribute.
      j = wsAfterName;
    }
  }
}

// Parse a link title ('"' / "'" / '(' form) at index i of s. Returns
// {title, end} or null. Shared by inline links and reference definitions.
function parseTitle(s, i) {
  const q = s[i];
  let j = i + 1;
  let title = '';
  if (q === '"' || q === "'") {
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && asciiPunct(s[j + 1])) {
        title += s[j + 1];
        j += 2;
        continue;
      }
      if (c === q) return { title, end: j + 1 };
      if (c === '\n') {
        if (s[j + 1] === '\n') return null;
        title += '\n';
        j++;
        continue;
      }
      title += c;
      j++;
    }
    return null;
  }
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && asciiPunct(s[j + 1])) {
      title += s[j + 1];
      j += 2;
      continue;
    }
    if (c === '(') return null;
    if (c === ')') return { title, end: j + 1 };
    if (c === '\n') {
      if (s[j + 1] === '\n') return null;
      title += '\n';
      j++;
      continue;
    }
    title += c;
    j++;
  }
  return null;
}

// Scan a link's text (raw source) for code spans, for the rule that a link
// is blocked when its text holds an odd number of "bad" code spans (whose
// content contains a backtick) plus unclosed backtick runs, unless the last
// bad span ends exactly at the end of the text. Returns true when the link
// is blocked. Collapsed and shortcut references are exempt (callers decide).
function linkTextBlockedBySpans(text) {
  let bad = 0;
  let unclosed = 0;
  let lastBadEnd = -1;
  let i = 0;
  while (i < text.length) {
    // A backslash escape is a literal character, not a code-span
    // delimiter: '\`' is a literal backtick, so it can neither open a
    // span nor count as unclosed ('[but \`promise](url)' forms the link).
    if (text[i] === '\\' && i + 1 < text.length && asciiPunct(text[i + 1])) { i += 2; continue; }
    if (text[i] !== '`') { i++; continue; }
    let n = 0;
    while (text[i + n] === '`') n++;
    // Search for a closing run of the same length (skipping escapes).
    let k = i + n;
    let found = -1;
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length && asciiPunct(text[k + 1])) { k += 2; continue; }
      if (text[k] === '`') {
        let m = 0;
        while (text[k + m] === '`') m++;
        if (m === n) { found = k; break; }
        k += m;
      } else {
        k++;
      }
    }
    if (found < 0) {
      unclosed++;
      i += n;
      continue;
    }
    const content = text.slice(i + n, found);
    if (content.indexOf('`') >= 0) {
      bad++;
      lastBadEnd = found + n;
    }
    i = found + n;
  }
  if (bad === 0) return (unclosed % 2) === 1;
  const total = bad + unclosed;
  return (total % 2) === 1 && lastBadEnd !== text.length;
}

// ---------- inline parser (SpanParser) ----------
// Token model: the inline content is a flat list of tokens. Text tokens hold
// raw source text; delimiter tokens hold a run of *, _ or ~ plus the emphasis
// tags they earned (openTags prepended, closeTags appended) and how many of
// the run were consumed (used). Emphasis is resolved by resolveEmphasis,
// which only mutates delimiter tokens, so no token list restructuring is
// needed. A link is formed by replacing the '[' token with a linkOpen token
// and appending a linkClose token; an image replaces the '!' token and drops
// the tokens from '[' onward.
//
// `linkState` is a document-level object shared across every inline parse:
// an inline `<a ` tag sets linkState.inLink, an inline `</a>` clears it, and
// while it is set, bare-URL and email extended autolinks are plain text.
// (Angle-bracket autolinks and markdown links are unaffected.)
class SpanParser {
  constructor(src, refs, linkState) {
    this.s = src;
    this.refs = refs;
    this.linkState = linkState;
    this.len = src.length;
    this.i = 0;
    this.toks = [];
    this.stack = [];
    this.openLinks = [];
    this.text = '';
    // Buffer indices that came from a backslash escape (the char is a
    // literal, not a structural character): an email autolink's local part
    // may not include such a character.
    this.textEsc = new Set();
    // Emphasis spans that have already formed in this inline run, as
    // {tag, ch, openPos, closeEnd} (source positions). Used by the M1 and R
    // rules, which look at what formed inside a span before it closes.
    this.formed = [];
  }

  run() {
    while (this.i < this.len) {
      const c = this.s[this.i];
      if (c === '\\') { this.scanBackslash(); continue; }
      if (c === '`') { this.scanBacktick(); continue; }
      if (c === '[') { this.pushBracket(false); continue; }
      if (c === '!') {
        if (this.s[this.i + 1] === '[') { this.pushBracket(true); continue; }
        this.text += '!';
        this.i++;
        continue;
      }
      if (c === ']') { this.closeBracket(); continue; }
      if (c === '<') { this.scanAngle(); continue; }
      if (c === '&') { this.scanEntity(); continue; }
      if (c === '*' || c === '_' || c === '~') { this.scanDelim(c); continue; }
      if (c === '\n') { this.scanNewline(); continue; }
      if (c === '@') {
        if (!this.linkState.inLink && this.scanEmail()) continue;
        this.text += '@';
        this.i++;
        continue;
      }
      if (c === 'w' || isAsciiLetter(c)) {
        if (!this.linkState.inLink && this.scanAutolink()) continue;
        this.text += c;
        this.i++;
        continue;
      }
      this.text += c;
      this.i++;
    }
    this.flushText();
    this.resolveEmphasis(null, true);
    return this.render();
  }

  flushText() {
    if (this.text.length) {
      this.toks.push({ k: 'text', s: this.text, esc: this.textEsc.size ? new Set(this.textEsc) : undefined });
      this.text = '';
      this.textEsc = new Set();
    }
  }

  scanBackslash() {
    const next = this.s[this.i + 1];
    if (next === '\n') {
      // Hard break (backslash + newline): the next line's leading
      // whitespace is swallowed with it.
      this.flushText();
      this.toks.push({ k: 'br' });
      this.i += 2;
      while (this.i < this.len && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
      return;
    }
    if (next !== undefined && asciiPunct(next)) {
      // An escaped & is a literal &, so it must be escaped in the output
      // (escapeText would otherwise leave &word; alone).
      this.text += next === '&' ? '&amp;' : next;
      this.textEsc.add(this.text.length - 1);
      this.i += 2;
      return;
    }
    this.text += '\\';
    this.i++;
  }

  scanBacktick() {
    const pos = this.i;
    let n = 0;
    while (this.s[pos + n] === '`') n++;
    // A single backtick inside a link text that already holds an
    // unclosed double-backtick run is literal, not a code-span opener:
    // '[docs each ``url`](...)' forms the link (the '`' after 'url'
    // must not pair with a '`' after the link and swallow the ']').
    // Without the unclosed '``' the single backtick pairs normally
    // (cm-342 '[not a `link](/foo`)' keeps its code span).
    if (n === 1 && this.openLinks.length > 0) {
      const link = this.openLinks[this.openLinks.length - 1];
      if (this.linkTextHasUnclosedDouble(link.srcPos, pos)) {
        this.text += '`';
        this.i += 1;
        return;
      }
    }
    const res = this.readCodeSpan(pos, n);
    if (res) {
      this.flushText();
      this.toks.push({ k: 'code', s: res.text });
      this.i = res.end;
      return;
    }
    this.text += '`'.repeat(n);
    this.i += n;
  }

  // Is there a '``' run in s[from, to) with no closing run of exactly 2
  // backticks in the same range? (Backslash-escaped backticks are skipped.)
  linkTextHasUnclosedDouble(from, to) {
    let i = from;
    while (i < to) {
      if (this.s[i] === '\\' && i + 1 < to && asciiPunct(this.s[i + 1])) { i += 2; continue; }
      if (this.s[i] !== '`') { i++; continue; }
      let n = 0;
      while (this.s[i + n] === '`') n++;
      if (n === 2) {
        let k = i + n;
        let closed = false;
        while (k < to) {
          if (this.s[k] === '\\' && k + 1 < to && asciiPunct(this.s[k + 1])) { k += 2; continue; }
          if (this.s[k] === '`') {
            let m = 0;
            while (this.s[k + m] === '`') m++;
            if (m === 2) { closed = true; break; }
            k += m;
          } else {
            k++;
          }
        }
        if (!closed) return true;
        i = k + 2;
        continue;
      }
      i += n;
    }
    return false;
  }

  readCodeSpan(pos, n) {
    let k = pos + n;
    while (k < this.len) {
      if (this.s[k] === '`') {
        let m = 0;
        while (this.s[k + m] === '`') m++;
        if (m === n) {
          let c = this.s.slice(pos + n, k);
          c = c.replace(/\n/g, ' ');
          if (c.length >= 2 && c[0] === ' ' && c[c.length - 1] === ' ' && !/^[ ]+$/.test(c)) {
            c = c.slice(1, -1);
          }
          return { text: c, end: k + m };
        }
        k += m;
      } else {
        k++;
      }
    }
    return null;
  }

  scanNewline() {
    // Hard break when the current text run ends in 2+ spaces (no tabs).
    const buf = this.text;
    let n = 0;
    for (let j = buf.length - 1; j >= 0 && buf[j] === ' '; j--) n++;
    if (n >= 2) {
      this.text = buf.slice(0, buf.length - n);
      this.flushText();
      this.toks.push({ k: 'br' });
      this.i++;
      // A hard break swallows the next line's leading whitespace.
      while (this.i < this.len && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
      return;
    }
    this.text += '\n';
    this.i++;
  }

  scanEntity() {
    const src = this.s;
    if (src[this.i + 1] === '#') {
      let j = this.i + 2;
      let isHex = false;
      if (src[j] === 'x' || src[j] === 'X') { isHex = true; j++; }
      const start = j;
      // A numeric reference is at most 7 decimal or 6 hex digits; longer
      // runs are not references at all.
      const maxDigits = isHex ? 6 : 7;
      let digits = 0;
      if (isHex) {
        while (digits < maxDigits + 1 && isHexDigit(src[j])) { j++; digits++; }
      } else {
        while (digits < maxDigits + 1 && src[j] >= '0' && src[j] <= '9') { j++; digits++; }
      }
      if (digits >= 1 && digits <= maxDigits && src[j] === ';') {
        const body = src.slice(start, j);
        const decoded = decodeNumeric(isHex ? 'x' + body : body);
        if (decoded !== null) {
          // A decoded & is a literal &, escaped in the output.
          this.text += decoded === '&' ? '&amp;' : decoded;
          this.i = j + 1;
          return;
        }
      }
    }
    // Named entities pass through unchanged (marked does not decode them);
    // a bare '&' is escaped by escapeText at render time.
    this.text += '&';
    this.i++;
  }

  scanDelim(c) {
    const pos = this.i;
    let n = 0;
    while (this.s[pos + n] === c) n++;
    // A run of 3+ tildes is not a strikethrough delimiter at all (it is
    // literal text); only runs of 1 or 2 tildes can open/close <del>.
    if (c === '~' && n >= 3) {
      this.text += c.repeat(n);
      this.i += n;
      return;
    }
    const before = pos > 0 ? this.s[pos - 1] : '';
    const after = this.s[pos + n] || '';
    const beforeWs = before === '' || isUniWs(before);
    const afterWs = after === '' || isUniWs(after);
    const beforePunct = before !== '' && isPunctCh(before);
    const afterPunct = after !== '' && isPunctCh(after);
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
    let canOpen;
    let canClose;
    if (c === '_') {
      canOpen = leftFlanking && (!rightFlanking || beforePunct);
      canClose = rightFlanking && (!leftFlanking || afterPunct);
    } else {
      canOpen = leftFlanking;
      canClose = rightFlanking;
    }
    this.flushText();
    const tok = { k: 'delim', ch: c, n, canOpen, canClose, used: 0, openTags: [], closeTags: [], pos, leftoverInside: false, inLink: this.openLinks.length > 0 };
    this.toks.push(tok);
    if (canOpen || canClose) this.stack.push(tok);
    // A closer resolves emphasis against the openers seen so far, so the
    // innermost pair is settled before an outer closer can steal a delimiter.
    // Inside a link's text, only openers above the link's '[' may match.
    if (canClose) {
      const bottom = this.openLinks.length ? this.openLinks[this.openLinks.length - 1].delimBottom : null;
      this.resolveEmphasis(bottom, false);
    }
    this.i += n;
  }

  // True when an em (single-mark) match between `opener` and `closer` is
  // blocked by marked's rule: a strong of the same mark already formed
  // strictly inside the pair, its opening run is preceded by a
  // non-alphanumeric character (a space, punctuation, or another delimiter
  // — when it follows a word character directly, as in `*foo**bar**baz*`,
  // the outer em forms), and its closing run is immediately followed by a
  // word character (`*a **b**c*` leaves the outer `*` literal, while
  // `*a **b** c*` forms the em).
  m1Blocked(opener, closer) {
    for (const f of this.formed) {
      if (f.tag !== 'strong' || f.ch !== closer.ch) continue;
      if (f.openPos <= opener.pos) continue;
      if (f.closeEnd > closer.pos) continue;
      const before = f.openPos > 0 ? this.s[f.openPos - 1] : '';
      if (before !== '' && isAlnumCh(before)) continue;
      if (f.closeEnd >= closer.pos) continue;
      // The character after the strong: skip any leftover delimiters of
      // the same run (a '___' closer that gave 2 to the strong leaves a
      // '_' behind — it is a delimiter, not a word character following
      // the strong; without this skip '_a _b __c___ d_' loses its outer
      // em because '_' counts as a word char).
      let j = f.closeEnd;
      while (this.s[j] === f.ch) j++;
      if (!isWordCh(this.s[j])) continue;
      return true;
    }
    return false;
  }

  // Does the source between opener (exclusive) and closer (exclusive)
  // hold a code span whose content contains a backtick?
  emphasisContentHasBadSpan(opener, closer) {
    const text = this.s.slice(opener.pos + opener.n, closer.pos);
    let i = 0;
    while (i < text.length) {
      if (text[i] === '\\' && i + 1 < text.length && asciiPunct(text[i + 1])) { i += 2; continue; }
      if (text[i] !== '`') { i++; continue; }
      let n = 0;
      while (text[i + n] === '`') n++;
      let k = i + n;
      let found = -1;
      while (k < text.length) {
        if (text[k] === '\\' && k + 1 < text.length && asciiPunct(text[k + 1])) { k += 2; continue; }
        if (text[k] === '`') {
          let m = 0;
          while (text[k + m] === '`') m++;
          if (m === n) { found = k; break; }
          k += m;
        } else {
          k++;
        }
      }
      if (found < 0) return false;
      const content = text.slice(i + n, found);
      if (content.indexOf('`') >= 0) return true;
      i = found + n;
    }
    return false;
  }

  // Is there a later run of the same delimiter character, of length >= 2,
  // that could close a strong with the opener `current` is stealing from?
  // Scans the source ahead of the current closer, skipping backslash
  // escapes and code spans (a run inside a code span is not a delimiter).
  // A run counts only when it can close: preceded by a non-whitespace
  // character (right-flanking for '*'/'_'; the '_' extra conditions are
  // approximated by the same test, which is enough for the strong case).
  hasLaterDoubleCloser(current) {
    const ch = current.ch;
    let i = current.pos + current.n;
    while (i < this.len) {
      const c = this.s[i];
      if (c === '\\' && i + 1 < this.len) { i += 2; continue; }
      if (c === '`') {
        let n = 0;
        while (this.s[i + n] === '`') n++;
        const res = this.readCodeSpan(i, n);
        if (res) { i = res.end; continue; }
        i += n;
        continue;
      }
      if (c === ch) {
        let n = 0;
        while (this.s[i + n] === ch) n++;
        if (n >= 2) {
          const before = i > 0 ? this.s[i - 1] : '';
          if (before !== '' && !isUniWs(before)) return true;
        }
        i += n;
        continue;
      }
      i++;
    }
    return false;
  }

  // Resolve emphasis for the delimiters above `bottom` (exclusive; null
  // means the whole stack). Walks from the top down, matching each closer
  // with the nearest compatible opener below it.
  //
  // A closer that can also open defers when its nearest opener has a
  // different remaining count: it may yet match a same-count opener (a clean
  // strong/em pair) instead of stealing one delimiter from this one
  // (cm-411, cm-429). A deferred opener is skipped by later closers unless
  // they can match it cleanly. Delimiters between a matched opener and
  // closer are inside the emphasis and can no longer match anything outside
  // it (cm-469). On the final pass (isFinal) every closer matches the
  // nearest compatible opener.
  resolveEmphasis(bottom, isFinal) {
    let current = this.stack.length ? this.stack[this.stack.length - 1] : null;
    while (current && current !== bottom) {
      if (current.canClose && current.used < current.n) {
        const ci = this.stack.indexOf(current);
        const cl = current.n - current.used;
        let opener = null;
        for (let j = ci - 1; j >= 0; j--) {
          const op = this.stack[j];
          if (op === bottom) break;
          if (op.ch !== current.ch || !op.canOpen || op.used >= op.n) continue;
          const ol = op.n - op.used;
          // Rule of 3: when one delimiter can both open and close, the pair
          // cannot match if the sum of the runs is a multiple of 3 UNLESS
          // both runs are multiples of 3.
          const odd = (current.canOpen || op.canClose) &&
            ((ol + cl) % 3 === 0) && !(ol % 3 === 0 && cl % 3 === 0);
          if (odd) continue;
          if (op.deferred && !isFinal) {
            const clean = ol === cl || (ol >= 2 && cl >= 2);
            if (!clean) continue;
          }
          // M1: a single-mark em is blocked by a strong of the same mark
          // that already formed strictly inside the pair.
          if (!(ol >= 2 && cl >= 2) && this.m1Blocked(op, current)) continue;
          // An emphasis opener scanned inside a link text ('[' open)
          // whose content holds a code span with a backtick in it does
          // not form ('[at _node `` a ` b ``_](url)' leaves the '_'
          // literal). In a plain paragraph such an em DOES form, so the
          // 'inLink' flag recorded on the opener at scan time is what
          // gates it — the flag survives to the final emphasis pass,
          // when the brackets are already closed.
          if (op.inLink && this.emphasisContentHasBadSpan(op, current)) continue;
          // A single closer must not steal one delimiter from a double
          // opener when a later double closer can form the strong with
          // it instead ('**a *b*c* d**' is a strong, not nested ems).
          // But only when the inner em's closer is immediately followed
          // by a word character ('*b*c*': the '*' after 'b' can open);
          // with a space there ('*b* c*') the nested ems stand.
          if (cl === 1 && ol >= 2) {
            let innerEmWord = false;
            for (const f of this.formed) {
              if (f.tag !== 'em' || f.ch !== current.ch) continue;
              if (f.openPos <= op.pos) continue;
              if (f.closeEnd > current.pos) continue;
              if (isWordCh(this.s[f.closeEnd])) { innerEmWord = true; break; }
            }
            if (innerEmWord && this.hasLaterDoubleCloser(current)) continue;
          }
          opener = op;
          break;
        }
        if (opener) {
          const ol = opener.n - opener.used;
          if (!isFinal && current.canOpen && ol !== cl && !(ol >= 2 && cl >= 2)) {
            current.deferred = true;
            const ci2 = this.stack.indexOf(current);
            current = ci2 > 0 ? this.stack[ci2 - 1] : null;
            continue;
          }
          const use = (ol >= 2 && cl >= 2) ? 2 : 1;
          const tag = current.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
          opener.openTags.unshift('<' + tag + '>');
          current.closeTags.push('</' + tag + '>');
          opener.used += use;
          current.used += use;
          // Remember the formed span for the M1/R rules.
          this.formed.push({ tag, ch: current.ch, openPos: opener.pos, closeEnd: current.pos + use });
          // R: when a strong closes with a leftover delimiter, the leftover
          // renders INSIDE the strong (before </strong>) iff a closed inner
          // em's closing delimiter is immediately followed by a word char
          // (`**foo *bar*baz***`); otherwise it renders outside, as usual.
          if (use === 2 && current.n - current.used > 0) {
            for (const f of this.formed) {
              if (f.tag !== 'em' || f.ch !== current.ch) continue;
              if (f.openPos <= opener.pos) continue;
              if (f.closeEnd > current.pos) continue;
              if (f.closeEnd < current.pos && isWordCh(this.s[f.closeEnd])) {
                current.leftoverInside = true;
                break;
              }
            }
          }
          // Scope: delimiters between the opener and closer are inside the
          // emphasis; drop them from the stack so they cannot match outside.
          let oi = this.stack.indexOf(opener);
          let ci2 = this.stack.indexOf(current);
          if (oi >= 0 && ci2 >= 0 && ci2 > oi + 1) {
            this.stack.splice(oi + 1, ci2 - oi - 1);
            oi = this.stack.indexOf(opener);
            ci2 = this.stack.indexOf(current);
          }
          if (opener.used >= opener.n && oi >= 0) {
            this.stack.splice(oi, 1);
            ci2 = this.stack.indexOf(current);
          }
          if (current.used >= current.n && ci2 >= 0) {
            this.stack.splice(ci2, 1);
            current = ci2 > 0 ? this.stack[ci2 - 1] : null;
            continue;
          }
          continue; // closer still has delimiters: try to match it again
        }
        if (!isFinal && current.canOpen && cl >= 2) {
          current.deferred = true;
        }
      }
      const ci = this.stack.indexOf(current);
      current = ci > 0 ? this.stack[ci - 1] : null;
    }
  }

  pushBracket(isImage) {
    this.flushText();
    // The delimiter stack's top when the '[' is pushed: emphasis inside the
    // link text may only match openers above it, and unmatched delimiters
    // inside the link are dropped when the link forms.
    const delimBottom = this.stack.length ? this.stack[this.stack.length - 1] : null;
    if (isImage) {
      const bangIdx = this.toks.length;
      this.toks.push({ k: 'text', s: '!' });
      const tokIdx = this.toks.length;
      this.toks.push({ k: 'text', s: '[' });
      this.openLinks.push({ tokenIdx: tokIdx, bangIdx, isImage: true, delimBottom, srcPos: this.i + 2 });
      this.i += 2;
    } else {
      const tokIdx = this.toks.length;
      this.toks.push({ k: 'text', s: '[' });
      this.openLinks.push({ tokenIdx: tokIdx, bangIdx: -1, isImage: false, delimBottom, srcPos: this.i + 1 });
      this.i += 1;
    }
  }

  closeBracket() {
    this.flushText();
    const link = this.openLinks.length ? this.openLinks[this.openLinks.length - 1] : null;
    if (!link) {
      this.text += ']';
      this.i++;
      return;
    }
    // Resolve emphasis inside the link text first.
    this.resolveEmphasis(link.delimBottom, false);
    const after = this.i + 1;
    let dest = null;
    let title = null;
    let endPos = after;
    let kind = null;
    if (this.s[after] === '(') {
      const res = this.readLinkDest(after);
      if (res) { dest = res.dest; title = res.title; endPos = res.end; kind = 'inline'; }
    }
    if (dest === null) {
      // A '[' after the ']' means a full or collapsed reference was
      // attempted. If it fails, the opener is dead: it does NOT fall back
      // to a shortcut reference (the '[label]' belongs to the attempt).
      const triedFullRef = this.s[after] === '[';
      if (this.s[after] === '[') {
        const lab = this.readLabel(after);
        if (lab) {
          // A collapsed reference (empty label) takes the link text as its
          // label, as raw source text: backslash escapes and emphasis
          // markers stay literal for matching (plainText would have
          // resolved the escapes and spent the delimiters).
          const label = lab.label === '' ? this.s.slice(link.srcPos, this.i) : lab.label;
          // A label cannot contain an unescaped '[' (the plain-text label
          // of a collapsed reference is checked the same way).
          if (label.length <= 999 && !hasUnescapedOpenBracket(label)) {
            const ref = this.refs.get(normalizeLabel(label));
            if (ref) { dest = ref.dest; title = ref.title; endPos = lab.end; kind = lab.label === '' ? 'collapsed' : 'full'; }
          }
        }
      }
      if (dest === null && !triedFullRef) {
        const label = this.s.slice(link.srcPos, this.i);
        if (label && label.length <= 999 && !hasUnescapedOpenBracket(label)) {
          const ref = this.refs.get(normalizeLabel(label));
          if (ref) { dest = ref.dest; title = ref.title; endPos = after; kind = 'shortcut'; }
        }
      }
    }
    // A link's text cannot contain another link. (Images may contain one:
    // it only feeds their alt text.)
    if (dest !== null && !link.isImage && this.linkTextHasLink(link.tokenIdx + 1)) dest = null;
    // C: an inline link or a full reference whose text holds an odd count
    // of bad code spans plus unclosed backtick runs is blocked in marked
    // (unless the last bad span ends at the end of the text). Collapsed and
    // shortcut references are exempt.
    if (dest !== null && (kind === 'inline' || kind === 'full')) {
      if (linkTextBlockedBySpans(this.s.slice(link.srcPos, this.i))) dest = null;
    }
    if (dest === null) {
      // Not a link: deactivate this opener, keep ']' as text.
      this.openLinks.pop();
      this.text += ']';
      this.i++;
      return;
    }
    this.formLink(link, dest, title, endPos);
  }

  // Does the token range [from, end) already hold a bracket link? A link's
  // text cannot contain another link; images and autolinks inside a link are
  // fine.
  linkTextHasLink(from) {
    for (let i = from; i < this.toks.length; i++) {
      if (this.toks[i].k === 'linkOpen') return true;
    }
    return false;
  }

  formLink(link, dest, title, endPos) {
    const href = encodeLink(dest);
    if (link.isImage) {
      const alt = this.plainText(link.tokenIdx + 1, this.toks.length);
      this.toks[link.bangIdx] = { k: 'img', src: href, title: title === null ? undefined : title, alt };
      this.toks.length = link.tokenIdx;
      const kept = new Set(this.toks);
      this.stack = this.stack.filter((d) => kept.has(d));
      this.openLinks = this.openLinks.filter((l) => l.tokenIdx < link.tokenIdx);
      this.i = endPos;
      return;
    }
    this.toks[link.tokenIdx] = { k: 'linkOpen', href, title: title === null ? undefined : title };
    // An extended autolink inside the link text is flattened to plain
    // text once the outer link forms (a bracket autolink <...> keeps its
    // own <a>). If the link had failed, the autolink would have stayed.
    for (let i = link.tokenIdx + 1; i < this.toks.length; i++) {
      const tok = this.toks[i];
      if (tok.k === 'autolink' && tok.ext) this.toks[i] = { k: 'text', s: tok.text };
    }
    this.toks.push({ k: 'linkClose' });
    this.openLinks = this.openLinks.filter((l) => l.tokenIdx < link.tokenIdx);
    // Drop unmatched delimiters that lived inside the link text: they must
    // not match anything outside the link.
    const bi = link.delimBottom ? this.stack.indexOf(link.delimBottom) : -1;
    this.stack.length = bi + 1;
    this.i = endPos;
  }

  // Plain text of the tokens in [from, to): the text a link label or an image
  // alt is made of. Emphasis tags contribute nothing; leftover delimiter
  // characters stay as text.
  plainText(from, to) {
    let s = '';
    for (let i = from; i < to; i++) {
      const tok = this.toks[i];
      switch (tok.k) {
        case 'text': s += tok.s; break;
        case 'delim': {
          const rem = tok.n - tok.used;
          if (rem > 0) s += tok.ch.repeat(rem);
          break;
        }
        case 'code': s += tok.s; break;
        case 'html': s += tok.s; break;
        case 'img': s += tok.alt; break;
        case 'autolink': s += tok.text; break;
        case 'br': s += '\n'; break;
        default: break;
      }
    }
    return s;
  }

  readLabel(pos) {
    const src = this.s;
    let i = pos + 1;
    let label = '';
    while (i < this.len) {
      const c = src[i];
      if (c === '\\' && i + 1 < this.len) {
        label += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') {
        if (label.length > 999) return null;
        return { label, end: i + 1 };
      }
      if (c === '\n') {
        if (src[i + 1] === '\n') return null;
        label += ' ';
        i++;
        continue;
      }
      label += c;
      i++;
    }
    return null;
  }

  skipWs(i) {
    let nl = 0;
    while (i < this.len) {
      const c = this.s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\n') {
        nl++;
        if (nl > 1) return -1;
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  readLinkDest(openParenPos) {
    const src = this.s;
    let i = this.skipWs(openParenPos + 1);
    if (i < 0) return null;
    if (src[i] === ')') return { dest: '', title: null, end: i + 1 };
    if (src[i] === '<') {
      let j = i + 1;
      while (j < this.len && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < this.len) { j += 2; continue; }
        if (src[j] === '>') {
          const fin = this.finishLinkDest(j + 1);
          if (fin) return { dest: stripBackslashes(src.slice(i + 1, j)), title: fin.title, end: fin.end };
        }
        j++;
      }
      return null;
    }
    let j = i;
    let depth = 0;
    let dest = '';
    while (j < this.len) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < this.len && asciiPunct(src[j + 1])) {
        dest += src[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      dest += c;
      j++;
    }
    if (dest.length === 0 || depth !== 0) return null;
    const fin = this.finishLinkDest(j);
    if (!fin) return null;
    return { dest, title: fin.title, end: fin.end };
  }

  finishLinkDest(i) {
    let j = this.skipWs(i);
    if (j < 0) return null;
    let title = null;
    if (this.s[j] === '"' || this.s[j] === "'" || this.s[j] === '(') {
      const t = parseTitle(this.s, j);
      if (!t) return null;
      title = t.title;
      j = this.skipWs(t.end);
      if (j < 0) return null;
    }
    if (this.s[j] !== ')') return null;
    return { title, end: j + 1 };
  }

  scanAngle() {
    const pos = this.i;
    const src = this.s;
    if (src.startsWith('<!--', pos)) {
      // '<!-->' and '<!--->' are complete (empty) comments on their own;
      // a later '-->' is stray text, not the end of this comment.
      let end = -1;
      let e = -1;
      if (src[pos + 4] === '>') { end = pos + 4; e = pos + 5; }
      else if (src[pos + 4] === '-' && src[pos + 5] === '>') { end = pos + 5; e = pos + 6; }
      else { end = src.indexOf('-->', pos + 4); e = end + 3; }
      if (end >= 0) {
        this.flushText();
        this.toks.push({ k: 'html', s: src.slice(pos, e) });
        this.i = e;
        return;
      }
      this.text += '<';
      this.i++;
      return;
    }
    if (src.startsWith('<?', pos)) {
      const end = src.indexOf('?>', pos + 2);
      if (end >= 0) {
        this.flushText();
        this.toks.push({ k: 'html', s: src.slice(pos, end + 2) });
        this.i = end + 2;
        return;
      }
      this.text += '<';
      this.i++;
      return;
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos + 9);
      if (end >= 0) {
        this.flushText();
        this.toks.push({ k: 'html', s: src.slice(pos, end + 3) });
        this.i = end + 3;
        return;
      }
      this.text += '<';
      this.i++;
      return;
    }
    if (/^<![A-Za-z]/.test(src.slice(pos, pos + 3))) {
      const end = src.indexOf('>', pos + 2);
      if (end >= 0) {
        this.flushText();
        this.toks.push({ k: 'html', s: src.slice(pos, end + 1) });
        this.i = end + 1;
        return;
      }
      this.text += '<';
      this.i++;
      return;
    }
    // Bracket autolink: <scheme:...> or <email> (no spaces, no newlines).
    const gt = src.indexOf('>', pos + 1);
    if (gt >= 0) {
      const inner = src.slice(pos + 1, gt);
      if (inner.length > 0 && inner.indexOf('\n') < 0 && inner.indexOf(' ') < 0 && inner.indexOf('<') < 0) {
        const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.+)$/.exec(inner);
        if (m) {
          this.flushText();
          this.toks.push({ k: 'autolink', href: encodeLink(inner), text: inner });
          this.i = gt + 1;
          return;
        }
        if (isValidEmail(inner)) {
          this.flushText();
          this.toks.push({ k: 'autolink', href: 'mailto:' + inner, text: inner });
          this.i = gt + 1;
          return;
        }
      }
    }
    const tag = this.readHtmlTag(pos);
    if (tag) {
      this.flushText();
      this.toks.push({ k: 'html', s: tag.text });
      // Mode 8: an inline `<a ` tag (literal space after <a) opens the
      // in-link state; an inline `</a>` exactly closes it. The state
      // persists across blocks until cleared, and while set, bare-URL and
      // email extended autolinks are plain text.
      const lower = tag.text.toLowerCase();
      if (lower.startsWith('<a ')) this.linkState.inLink = true;
      else if (lower === '</a>') this.linkState.inLink = false;
      this.i = tag.end;
      return;
    }
    this.text += '<';
    this.i++;
  }

  // Parse an inline HTML tag at pos. Returns {text, end} or null.
  readHtmlTag(pos) {
    const end = parseTagAt(this.s, pos, this.len);
    if (end < 0) return null;
    return { text: this.s.slice(pos, end), end };
  }

  scanEmail() {
    // The local part is the maximal run of email-local characters ending
    // just before the '@'. It can span the current text run and earlier
    // text/delimiter tokens: a '_' (or '*') inside the address was already
    // emitted as a delimiter, but it carries no emphasis role there, so it
    // belongs to the address, not to an emphasis run.
    let local = '';
    let bufCut = 0;
    {
      let i = this.text.length;
      while (i > 0 && isEmailLocalChar(this.text[i - 1]) && !this.textEsc.has(i - 1)) { i--; bufCut++; }
      local = this.text.slice(this.text.length - bufCut);
    }
    if (this.text.length > 0 && bufCut === 0) return false;
    // The walk back through earlier tokens only runs when the whole buffer
    // was consumed into the local part: if the buffer walk stopped at a
    // space, the address starts inside the buffer and no earlier token
    // belongs to it ('x86_64 render@...' links 'render@...', not
    // 'x86_render@...').
    const walkTokens = bufCut === this.text.length;
    let tokCut = 0; // whole tokens (from the end) that are in the local part
    let partialTok = -1; // a text token whose suffix is in the local part
    let partialKeep = 0;
    const removed = new Set();
    let ti = walkTokens ? this.toks.length - 1 : -1;
    while (ti >= 0) {
      const tok = this.toks[ti];
      if (tok.k === 'text') {
        let j = tok.s.length;
        let piece = '';
        while (j > 0 && isEmailLocalChar(tok.s[j - 1]) && !(tok.esc && tok.esc.has(j - 1))) { piece = tok.s[j - 1] + piece; j--; }
        if (piece.length === 0) break;
        local = piece + local;
        if (j > 0) { partialTok = ti; partialKeep = j; break; }
        removed.add(tok);
        tokCut++;
        ti--;
        continue;
      }
      if (tok.k === 'delim' && tok.ch === '_' && tok.n === 1 && tok.used === 0 && tok.openTags.length === 0 && tok.closeTags.length === 0 && isEmailLocalChar(tok.ch)) {
        // Only a single '_' delimiter belongs to the address: a '__'
        // strong delimiter is an emphasis opener, never an email
        // character ('__table@nimbus.example.com__' links
        // 'table@nimbus.example.com' inside the strong).
        local = tok.ch.repeat(tok.n) + local;
        removed.add(tok);
        tokCut++;
        ti--;
        continue;
      }
      break;
    }
    if (!local) return false;
    let k = this.i + 1;
    while (k < this.len && isDomainChar(this.s[k])) k++;
    if (k === this.i + 1) return false;
    // A '_' immediately after the domain is part of the would-be address
    // (not a valid domain character), so the whole thing is not an email —
    // unless it is the first '_' of a '__' strong delimiter, or it closes
    // an open '_' emphasis span (there is an unmatched '_' opener on the
    // stack): '_warning when@atlas.example.com_' links the email inside
    // the emphasis.
    if (this.s[k] === '_') {
      let closesEm = this.s[k + 1] === '_';
      if (!closesEm) {
        for (const d of this.stack) {
          if (d.ch === '_' && d.canOpen && d.used < d.n) { closesEm = true; break; }
        }
      }
      if (!closesEm) return false;
    }
    let domain = this.s.slice(this.i + 1, k);
    // A domain ending in '-' is not an email at all (no link). A trailing
    // '.' is trimmed and the link still forms. A trailing '_' is trimmed
    // ONLY when it closes an emphasis ('__foo because@mark.example.com__'
    // links 'because@mark.example.com' inside the strong); a '_' with no
    // opener to close is part of the would-be address and the whole thing
    // is not an email ('a.b-c_d@a.b_' does not link, gfm-632).
    if (domain.endsWith('-')) return false;
    {
      let t = domain;
      while (t.length && (t[t.length - 1] === '.' || t[t.length - 1] === '_')) t = t.slice(0, -1);
      if (t.length < domain.length) {
        const trimAt = this.i + 1 + t.length;
        if (this.s[trimAt] === '_') {
          let closesEm = this.s[trimAt + 1] === '_';
          if (!closesEm) {
            for (const d of this.stack) {
              if (d.ch === '_' && d.canOpen && d.used < d.n) { closesEm = true; break; }
            }
          }
          if (!closesEm) return false;
        }
      }
      domain = t;
    }
    if (!domain || !validDomainLabels(domain, 2, EMAIL_LABEL_RE)) return false;
    // Remove the local part from the buffer and the tokens (and from the
    // delimiter stack, so a swallowed delimiter is never matched).
    this.text = this.text.slice(0, this.text.length - bufCut);
    if (bufCut) {
      const kept = new Set();
      for (const idx of this.textEsc) if (idx < this.text.length) kept.add(idx);
      this.textEsc = kept;
    }
    if (partialTok >= 0) {
      this.toks[partialTok].s = this.toks[partialTok].s.slice(0, partialKeep);
      this.toks.length = partialTok + 1;
    } else {
      this.toks.length = this.toks.length - tokCut;
    }
    if (removed.size) this.stack = this.stack.filter((d) => !removed.has(d));
    this.flushText();
    const email = local + '@' + domain;
    this.toks.push({ k: 'autolink', ext: true, href: 'mailto:' + email, text: email });
    this.i = this.i + 1 + domain.length;
    return true;
  }

  scanAutolink() {
    const pos = this.i;
    const c = this.s[pos];
    if (c === 'w' && this.s.startsWith('www.', pos)) {
      const prev = pos > 0 ? this.s[pos - 1] : '';
      if (prev === '' || isUniWs(prev) || prev === '(' || prev === '[' || prev === '*' || prev === '_' || prev === '~') {
        const res = this.scanWww(pos);
        if (res) {
          this.flushText();
          this.toks.push({ k: 'autolink', ext: true, href: encodeLink('http://' + res.url), text: res.url });
          this.i = res.end;
          return true;
        }
      }
      return false;
    }
    const prev = pos > 0 ? this.s[pos - 1] : '';
    if (prev !== '' && isSchemeChar(prev)) return false;
    const res = this.scanScheme(pos);
    if (res) {
      this.flushText();
      this.toks.push({ k: 'autolink', ext: true, href: encodeLink(res.url), text: res.url });
      this.i = res.end;
      return true;
    }
    return false;
  }

  // Does the innermost open link's text contain a link that already formed?
  // When it does, a ']' inside the URL scan does not end the URL (the outer
  // link cannot form, so the autolink swallows the bracket); when it does
  // not, ']' ends the URL so the bracket can close the link.
  linkTextHasFormedLink() {
    if (!this.openLinks.length) return false;
    const link = this.openLinks[this.openLinks.length - 1];
    for (let i = link.tokenIdx + 1; i < this.toks.length; i++) {
      if (this.toks[i].k === 'linkOpen') return true;
    }
    return false;
  }

  scanWww(pos) {
    let j = pos + 4;
    while (j < this.len && isDomainChar(this.s[j])) j++;
    let k = j;
    while (k < this.len) {
      const c = this.s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c.charCodeAt(0) < 32) break;
      if (c === '&' && looksLikeEntity(this.s, k)) break;
      // A ']' ends the URL only when the innermost open link's text holds
      // no formed link (so the bracket can close it).
      if (c === ']' && this.openLinks.length && !this.linkTextHasFormedLink()) break;
      k++;
    }
    if (k === pos + 4) return null;
    const url = trimAutolink(this.s.slice(pos, k));
    if (!url) return null;
    let dEnd = url.length;
    // A backslash also ends the domain (it is a path separator, so a
    // trailing '\' stays in the URL but is not part of the domain:
    // 'www.flux.com\' autolinks with href 'http://www.flux.com%5C').
    for (const sep of ['/', '?', '#', '\\']) {
      const idx = url.indexOf(sep, 4);
      if (idx >= 0 && idx < dEnd) dEnd = idx;
    }
    const domain = url.slice(0, dEnd);
    if (!domain.startsWith('www.')) return null;
    if (!validDomainLabels(domain.slice(4), 1)) return null;
    return { url, end: pos + url.length };
  }

  scanScheme(pos) {
    let i = pos;
    if (!isAsciiLetter(this.s[i])) return null;
    i++;
    let n = 1;
    while (i < this.len && n < 32 && isSchemeChar(this.s[i])) { i++; n++; }
    if (n < 2) return null;
    if (this.s[i] !== ':') return null;
    const colonIdx = i;
    // Extended autolinks only recognise http/https/ftp (which need '//'
    // after the scheme) and mailto/xmpp (which carry an email address).
    // Any other scheme ('server:', 'ssh://', 'custom://', 'Warning:') is
    // plain text, not a link.
    const scheme0 = this.s.slice(pos, colonIdx).toLowerCase();
    if (scheme0 !== 'http' && scheme0 !== 'https' && scheme0 !== 'ftp' && scheme0 !== 'mailto' && scheme0 !== 'xmpp') return null;
    if ((scheme0 === 'http' || scheme0 === 'https' || scheme0 === 'ftp') &&
        !(this.s[colonIdx + 1] === '/' && this.s[colonIdx + 2] === '/')) return null;
    i++;
    let j = i;
    while (j < this.len) {
      const c = this.s[j];
      // A backslash is not part of a scheme autolink's URL only when it is
      // the first character after the scheme's ':' (the URL would be just
      // the scheme: 'removes:\' + newline is a hard break, not a link).
      // Later in the URL a backslash is an ordinary character, so
      // 'http://sub.domain.example.io..\' autolinks with href '%5C'.
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || (c === '\\' && j === i) || c.charCodeAt(0) < 32) break;
      if (c === '&' && looksLikeEntity(this.s, j)) break;
      // A ']' ends the URL only when the innermost open link's text holds
      // no formed link (so the bracket can close it).
      if (c === ']' && this.openLinks.length && !this.linkTextHasFormedLink()) break;
      j++;
    }
    if (j === i) return null;
    let url = trimAutolink(this.s.slice(pos, j));
    if (!url) return null;
    // The part after the scheme's ':' must survive trimming: otherwise the
    // "URL" is just the scheme itself ('**Warning:**' is emphasis, not a
    // link to 'Warning').
    if (url.length <= colonIdx - pos + 1) return null;
    // mailto: and xmpp: carry an email address, not a generic URL path.
    // mailto: takes no path at all ('mailto:foo@bar.baz/txt' links only the
    // email); xmpp: takes one resource segment ('xmpp:foo@bar.baz/txt' links
    // the email plus '/txt', but '/bin' after it is outside). The email's
    // domain may not end in '-' or '_' (then there is no link at all).
    // Validate against the RAW scanned text: trimAutolink would already
    // have stripped a trailing '_' that invalidates the address.
    const scheme = this.s.slice(pos, colonIdx).toLowerCase();
    if ((scheme === 'mailto' || scheme === 'xmpp') && url.indexOf('@', colonIdx - pos + 1) >= 0) {
      const raw = this.s.slice(pos, j);
      const cRel = colonIdx - pos; // raw-relative index of ':'
      const at = raw.indexOf('@', cRel + 1);
      const slash = raw.indexOf('/', at);
      const emailPart = slash < 0 ? raw.slice(cRel + 1) : raw.slice(cRel + 1, slash);
      const atInEmail = emailPart.indexOf('@');
      if (atInEmail <= 0) return null;
      const local = emailPart.slice(0, atInEmail);
      let domain = emailPart.slice(atInEmail + 1);
      for (let k = 0; k < local.length; k++) {
        if (!isEmailLocalChar(local[k])) return null;
      }
      if (domain.endsWith('-')) return null;
      {
        let t = domain;
        while (t.length && (t[t.length - 1] === '.' || t[t.length - 1] === '_')) t = t.slice(0, -1);
        if (t.length < domain.length) {
          // A trailing '_' is trimmed only when it closes an emphasis
          // (same rule as scanEmail, gfm-632/633).
          const domStart = pos + cRel + 1 + atInEmail + 1;
          const trimAt = domStart + t.length;
          if (this.s[trimAt] === '_') {
            let closesEm = this.s[trimAt + 1] === '_';
            if (!closesEm) {
              for (const d of this.stack) {
                if (d.ch === '_' && d.canOpen && d.used < d.n) { closesEm = true; break; }
              }
            }
            if (!closesEm) return null;
          }
        }
        domain = t;
      }
      if (!domain || !validDomainLabels(domain, 2, EMAIL_LABEL_RE)) return null;
      if (scheme === 'mailto') {
        url = url.slice(0, colonIdx - pos + 1) + local + '@' + domain;
      } else if (slash >= 0) {
        const segEnd = raw.indexOf('/', slash + 1);
        const seg = segEnd < 0 ? raw.slice(slash) : raw.slice(slash, segEnd);
        url = url.slice(0, colonIdx - pos + 1) + local + '@' + domain + seg;
      } else {
        url = url.slice(0, colonIdx - pos + 1) + local + '@' + domain;
      }
    }
    return { url, end: pos + url.length };
  }

  render() {
    let out = '';
    for (const tok of this.toks) {
      switch (tok.k) {
        case 'text': out += escapeText(tok.s); break;
        case 'delim': {
          const rem = tok.n - tok.used;
          if (tok.leftoverInside) {
            // R: the leftover delimiter renders inside the emphasis.
            if (rem > 0) out += tok.ch.repeat(rem);
            for (const tag of tok.closeTags) out += tag;
          } else {
            for (const tag of tok.closeTags) out += tag;
            if (rem > 0) out += tok.ch.repeat(rem);
          }
          for (const tag of tok.openTags) out += tag;
          break;
        }
        case 'br': out += '<br>'; break;
        case 'code': out += '<code>' + escapeCode(tok.s) + '</code>'; break;
        case 'html': out += tok.s; break;
        case 'linkOpen': {
          out += '<a href="' + escapeAttr(tok.href) + '"';
          if (tok.title !== undefined) out += ' title="' + escapeAttr(tok.title) + '"';
          out += '>';
          break;
        }
        case 'linkClose': out += '</a>'; break;
        case 'autolink': out += '<a href="' + escapeAttr(tok.href) + '">' + escapeText(tok.text) + '</a>'; break;
        case 'img': {
          out += '<img src="' + escapeAttr(tok.src) + '" alt="' + escapeAttr(tok.alt) + '"';
          if (tok.title !== undefined) out += ' title="' + escapeAttr(tok.title) + '"';
          out += '>';
          break;
        }
      }
    }
    return out;
  }
}

function parseSpans(src, refs, linkState) {
  return new SpanParser(src, refs, linkState).run();
}

// ---------- block rendering ----------

function renderTree(root, refs, linkState) {
  let out = '';
  for (const child of root.children) out += renderNode(child, refs, linkState);
  return out;
}

function renderNode(blk, refs, linkState) {
  switch (blk.t) {
    case 'para':
      return '<p>' + parseSpans(blk.text, refs, linkState) + '</p>\n';
    case 'heading':
      return '<h' + blk.level + '>' + parseSpans(blk.text, refs, linkState) + '</h' + blk.level + '>\n';
    case 'code': {
      let s = '<pre><code';
      if (blk.info) s += ' class="language-' + escapeText(blk.info) + '"';
      s += '>' + escapeCode(blk.text) + '</code></pre>\n';
      return s;
    }
    case 'html':
      return blk.text;
    case 'hr':
      return '<hr>\n';
    case 'blockquote': {
      let inner = '';
      for (const child of blk.children) inner += renderNode(child, refs, linkState);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      const tag = blk.ordered ? 'ol' : 'ul';
      let s = '<' + tag;
      if (blk.ordered && blk.start !== 1) s += ' start="' + blk.start + '"';
      s += '>\n';
      for (const item of blk.children) s += renderItem(item, refs, blk.loose, linkState);
      s += '</' + tag + '>\n';
      return s;
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < blk.header.length; i++) {
        s += '<th';
        const a = blk.aligns[i];
        if (a) s += ' align="' + a + '"';
        s += '>' + parseSpans(blk.header[i], refs, linkState) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (blk.rows.length) {
        s += '<tbody>';
        for (const row of blk.rows) {
          s += '<tr>\n';
          for (let i = 0; i < blk.header.length; i++) {
            const cell = i < row.length ? row[i] : '';
            s += '<td';
            const a = blk.aligns[i];
            if (a) s += ' align="' + a + '"';
            s += '>' + parseSpans(cell, refs, linkState) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody></table>\n';
      } else {
        s += '</table>\n';
      }
      return s;
    }
    default:
      return '';
  }
}

function renderItem(item, refs, loose, linkState) {
  let s = '<li>';
  const checkbox = item.task
    ? (item.task === 'checked'
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ')
    : '';
  const first = item.children[0];
  if (checkbox && loose && first && first.t === 'para') {
    // A loose task item's checkbox lives inside its first paragraph.
    s += '<p>' + checkbox + parseSpans(first.text, refs, linkState) + '</p>\n';
    for (let i = 1; i < item.children.length; i++) s += renderNode(item.children[i], refs, linkState);
  } else {
    if (checkbox) s += checkbox;
    for (const child of item.children) {
      if (!loose && child.t === 'para') s += parseSpans(child.text, refs, linkState);
      else s += renderNode(child, refs, linkState);
    }
  }
  s += '</li>\n';
  return s;
}

// F4: marked strips trailing spaces/tabs from the last paragraph of the
// LAST item of each list, recursing through nested lists and blockquotes.
// Top-level paragraphs and blockquote paragraphs keep theirs. This runs
// once over the finished block tree, before rendering.
function stripListTrailing(node) {
  if (node.t === 'list' && node.children.length) {
    let cur = node.children[node.children.length - 1];
    while (cur) {
      if (cur.t === 'para') {
        cur.text = cur.text.replace(/[ \t]+$/, '');
        break;
      }
      const kids = cur.children;
      if (kids && kids.length) cur = kids[kids.length - 1];
      else break;
    }
  }
  if (node.children) {
    for (const child of node.children) stripListTrailing(child);
  }
}

// ---------- entry point ----------

export function parse(markdown) {
  const builder = new DocBuilder(markdown);
  const { root, refs } = builder.parse();
  stripListTrailing(root);
  const linkState = { inLink: false };
  return renderTree(root, refs, linkState);
}
