// A fast, dependency-free Markdown renderer matching marked 18.1.3 byte
// for byte under its default options (gfm on, breaks off, pedantic off,
// async off). Where marked disagrees with the CommonMark / GFM spec, this
// follows marked: the scored output is marked's HTML, not the spec's.
//
// Shape of the program: one pass over the source lines builds a small
// block tree, then an inline scanner renders the inline content of each
// leaf. Nothing is recognised, nothing is cached between calls, and the
// result is a pure function of the markdown passed in.
//
// Marked quirks reproduced here, each checked against the vendored marked
// as an oracle:
//  * tilde fences keep content indentation; backtick fences strip up to
//    the fence indent.
//  * a fenced code block in a list item does not swallow an
//    under-indented line: the line ends the block (and the item).
//  * a backtick fence whose info string holds a backtick cannot interrupt
//    a paragraph.
//  * HTML blocks of kinds 1-5 keep their trailing newline when the next
//    line is whitespace-only but non-empty.
//  * a table ends when the next line starts any block (heading, fence,
//    list, hr, html, blockquote) or is indented code.
//  * trailing spaces are stripped from the last paragraph of the last item
//    of every list, recursing through nested lists and blockquotes.
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

// Tag names that open an HTML block of kind 6 (and count as block tags
// for kind 7 checks).
const BLOCK_ELEMENTS = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '),
);

// ---------- single-character tests ----------

function isAsciiPunct(c) {
  return c !== undefined && c.length === 1 &&
    ((c >= '!' && c <= '/') || (c >= ':' && c <= '@') ||
     (c >= '[' && c <= '`') || (c >= '{' && c <= '~'));
}

function isPunct(c) {
  if (c === undefined || c === '') return false;
  return /[\p{P}\p{S}]/u.test(c);
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
    c === '\f' || c === '\u00A0' || c === '\u1680' ||
    (c >= '\u2000' && c <= '\u200A') || c === '\u2028' || c === '\u2029' ||
    c === '\u202F' || c === '\u205F' || c === '\u3000' || c === '\uFEFF';
}

function isWord(c) {
  if (c === undefined || c === '') return false;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') || c === '_') return true;
  return /[\p{L}\p{N}]/u.test(c);
}

// Letter or digit, but not '_': used by the M1 rule to tell whether a
// strong's opener follows a word character directly.
function isAlnum(c) {
  if (c === undefined || c === '') return false;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9')) return true;
  return /[\p{L}\p{N}]/u.test(c);
}

function isLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isAlnumAscii(c) {
  return isLetter(c) || (c >= '0' && c <= '9');
}

function isHex(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
    (c >= 'A' && c <= 'F');
}

function isSchemeCh(c) {
  return isAlnumAscii(c) || c === '+' || c === '-' || c === '.';
}

function isEmailCh(c) {
  return isAlnumAscii(c) ||
    ".!#$%&'*+/=?^_`{|}~-".indexOf(c) >= 0;
}

function isDomainCh(c) {
  return isAlnumAscii(c) || c === '-' || c === '.' || c === '_';
}

// ---------- escaping / encoding ----------

const ENTITY_RE = /&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)/y;

function looksEntity(src, i) {
  ENTITY_RE.lastIndex = i;
  return ENTITY_RE.test(src);
}

function escText(s) {
  // Fast path: most text has no escapable character; return it untouched
  // instead of rebuilding it one character at a time.
  if (!/[<>"'&]/.test(s)) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else if (c === '&') {
      if (looksEntity(s, i)) {
        const semi = s.indexOf(';', i);
        out += s.slice(i, semi + 1);
        i = semi;
      } else out += '&amp;';
    } else out += c;
    i++;
  }
  return out;
}

function escCode(s) {
  // Fast path: most code has no escapable character.
  if (!/[<>"'&]/.test(s)) return s;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') buf += '&lt;';
    else if (ch === '>') buf += '&gt;';
    else if (ch === '"') buf += '&quot;';
    else if (ch === "'") buf += '&#39;';
    else if (ch === '&') buf += '&amp;';
    else buf += ch;
  }
  return buf;
}

function escAttr(s) {
  return escText(s);
}

function unslash(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// Numeric character reference: &#123; &#x1F600; &#X41;. Invalid (0,
// surrogates, > 0x10FFFF, empty) becomes U+FFFD. `ref` is the text after
// '&' up to ';', with an optional 'x'/'X' prefix for hex.
function numRef(ref) {
  let code;
  if (ref[0] === 'x' || ref[0] === 'X') {
    if (ref.length === 1) return null;
    code = parseInt(ref.slice(1), 16);
  } else {
    if (ref.length === 0) return null;
    code = parseInt(ref, 10);
  }
  if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(code);
}

// Encode a link destination the way marked does: encodeURI, then restore
// an already-valid %XX escape in the source (marked preserves it; plain
// encodeURI would turn %20 into %2520), and a bare % stays %.
// encodeURI leaves [ ] alone, so percent-encode those too.
function encHref(dest) {
  let s = encodeURI(dest);
  // The replacements are only needed when the characters are present;
  // most URLs have none of them, so skip the regex passes entirely.
  if (s.indexOf('%') >= 0) s = s.replace(/%25([0-9A-Fa-f]{2})?/g, (m, hex) => (hex ? '%' + hex : '%'));
  if (s.indexOf('[') >= 0) s = s.replace(/\[/g, '%5B');
  if (s.indexOf(']') >= 0) s = s.replace(/\]/g, '%5D');
  return s;
}

// Normalise a link label for reference lookup: collapse whitespace, trim,
// lowercase, and fold ß to ss.
function normLabel(label) {
  return label.replace(/[\s]+/g, ' ').trim().toLowerCase()
    .replace(/\u00DF/g, 'ss');
}

function hasOpenBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
    if (s[i] === '[') return true;
  }
  return false;
}

// ---------- line cursor ----------

// A cursor over one source line. `p` is the byte index, `c` the column
// (tabs expanded to the next multiple of 4). `part` holds the spaces a
// tab was split into when a column advance stopped mid-tab. `item`
// accumulates the list-item indentation stripped for this line, so tab
// expansion in fenced code can use the column relative to the item content
// (marked counts the blockquote marker but not the list indent).
class Line {
  constructor(s, nl) {
    this.s = s;
    this.nl = nl;
    this.p = 0;
    this.c = 0;
    this.part = 0;
    this.item = 0;
  }
  at() {
    if (this.part > 0) return ' ';
    if (this.p < this.s.length) return this.s[this.p];
    return this.nl ? '\n' : '';
  }
  atOff(k) {
    const idx = this.p + k;
    if (idx < this.s.length) return this.s[idx];
    if (idx === this.s.length) return this.nl ? '\n' : '';
    return '';
  }
  tail() {
    if (this.part > 0) {
      return ' '.repeat(this.part) + this.s.slice(this.p + 1);
    }
    return this.s.slice(this.p);
  }
  tailFrom(k) {
    if (this.part > 0) {
      if (k < this.part) return ' '.repeat(this.part - k) + this.s.slice(this.p + 1);
      k -= this.part;
      const idx = this.p + 1 + k;
      return idx < this.s.length ? this.s.slice(idx) : '';
    }
    const idx = this.p + k;
    return idx < this.s.length ? this.s.slice(idx) : '';
  }
  // Advance by n columns. `base` is subtracted from the column when a
  // tab's width is measured, so a caller can measure the advance relative
  // to a list item's content instead of the absolute line start.
  adv(n, base = 0) {
    while (n > 0) {
      if (this.part > 0) {
        const k = this.part < n ? this.part : n;
        this.part -= k;
        this.c += k;
        n -= k;
        if (this.part === 0) this.p++;
      } else if (this.p < this.s.length) {
        const ch = this.s[this.p];
        if (ch === '\t') {
          const w = 4 - ((this.c - base) % 4);
          if (w <= n) { this.c += w; this.p++; n -= w; }
          else { this.part = w - n; this.c += n; n = 0; }
        } else {
          this.p++;
          this.c++;
          n--;
        }
      } else {
        this.c += n;
        n = 0;
      }
    }
  }
  advCh(n) {
    while (n > 0 && this.p < this.s.length) {
      const ch = this.s[this.p];
      if (ch === '\t') this.c += 4 - (this.c % 4);
      else this.c++;
      this.p++;
      n--;
    }
    if (this.part > 0) { this.part = 0; this.p++; }
  }
  skipWs(maxCols) {
    let n = 0;
    while (n < maxCols) {
      const ch = this.at();
      if (ch !== ' ' && ch !== '\t') break;
      this.adv(1);
      n++;
    }
    return n;
  }
  blank() {
    for (let k = 0; ; k++) {
      const ch = this.atOff(k);
      // End of the line (with or without a newline) after only spaces/tabs
      // is blank; a line with no trailing newline ends in '' instead.
      if (ch === '\n' || ch === '') return true;
      if (ch !== ' ' && ch !== '\t') return false;
    }
  }
  // Columns of indentation at the cursor. `base` is subtracted from the
  // starting column, so a caller can measure the indent relative to a
  // list item's content instead of the absolute line start.
  indent(base = 0) {
    let n = 0;
    let col = this.c - base;
    let i = this.p;
    let part = this.part;
    while (true) {
      let ch;
      if (part > 0) ch = ' ';
      else if (i < this.s.length) ch = this.s[i];
      else break;
      if (ch === ' ') {
        n++;
        col++;
        if (part > 0) { part--; if (part === 0) i++; }
        else i++;
      } else if (ch === '\t') {
        const w = 4 - (col % 4);
        n += w;
        col += w;
        i++;
        part = 0;
      } else break;
    }
    return n;
  }
  // True when the line, from the cursor on, holds only spaces/tabs.
  wsOnly() {
    for (let k = 0; ; k++) {
      const ch = this.atOff(k);
      if (ch === '\n' || ch === '') return true;
      if (ch !== ' ' && ch !== '\t') return false;
    }
  }
}

// ---------- block nodes ----------

function node(kind) {
  return { k: kind, kids: [] };
}

// ---------- block builder ----------

class BlockBuilder {
  constructor(src) {
    src = src.replace(/\r\n?/g, '\n');
    this.src = src;
    const raw = src.split('\n');
    if (raw.length && raw[raw.length - 1] === '' && src.endsWith('\n')) raw.pop();
    if (src === '') raw.length = 0;
    this.lines = raw.map((text, i) => new Line(text, i < raw.length - 1 || src.endsWith('\n')));
    this.root = node('doc');
    this.stack = [this.root];
    this.refs = new Map();
    this.blank = false;
    this.ln = 0;
  }

  top() { return this.stack[this.stack.length - 1]; }

  mark(line) { return [line.p, line.c, line.part, line.item]; }
  back(line, s) {
    line.p = s[0];
    line.c = s[1];
    line.part = s[2];
    line.item = s[3];
  }

  seal(blk) {
    if (blk.k === 'code') {
      if (!blk.fenced) {
        while (blk.raw.length && blk.raw[blk.raw.length - 1] === '') blk.raw.pop();
      }
      blk.txt = blk.raw.join('\n');
      if (blk.raw.length && blk.raw[blk.raw.length - 1] !== '') blk.txt += '\n';
      delete blk.raw;
    }
    if (blk.k === 'html') {
      blk.txt = blk.raw.join('\n');
      if (blk.trailNl === undefined) {
        blk.trailNl = blk.top && blk.lastLn === this.lines.length - 1 && blk.lastNl;
      }
      if (blk.trailNl) blk.txt += '\n';
      delete blk.raw;
      delete blk.trailNl;
      delete blk.top;
      delete blk.lastLn;
      delete blk.lastNl;
    }
    if (blk.k === 'p' || blk.k === 'h') {
      blk.txt = blk.raw.join('\n');
      delete blk.raw;
    }
  }

  closeTo(depth) {
    while (this.stack.length > depth) {
      const blk = this.stack.pop();
      // A blank line seen inside a blockquote does not loosen an outer
      // list: once the quote closes, that blank line separates nothing at
      // the list level (cm-320).
      if (blk.k === 'quote') this.blank = false;
      this.seal(blk);
    }
  }

  // Strip the container prefixes of the open stack from the line. Returns
  // the stack depth of the last matched container, or -1 when a container
  // failed (then _fail holds the failing index and nothing was popped).
  // A blank line matches a list item but NOT a blockquote.
  matchStack(line) {
    let depth = 0;
    for (let k = 1; k < this.stack.length; k++) {
      const blk = this.stack[k];
      if (blk.k === 'quote') {
        const save = this.mark(line);
        line.skipWs(3);
        if (line.at() !== '>') {
          this.back(line, save);
          this._fail = k;
          return -1;
        }
        line.advCh(1);
        // The whitespace after '>' is expanded in the frame that starts
        // at the list-item content (marked's list J strips the item indent
        // before the blockquote J runs), so the tab width is measured from
        // item, not from the absolute column: a tab at absolute col 8 in
        // an item of indent 7 is at frame col 1 (width 3), not col 8
        // (width 4). Passing item as the base reproduces that.
        if (line.at() === ' ') line.adv(1, line.item);
        else if (line.at() === '\t') line.adv(1, line.item);
        depth = k;
      } else if (blk.k === 'list') {
        depth = k;
      } else if (blk.k === 'item') {
        if (line.blank()) {
          if (blk.kids.length === 0) {
            this._fail = k;
            return -1;
          }
          // A blank line keeps the list item open, but containers nested
          // inside the item (a blockquote, a fenced code block) do NOT
          // match a blank line: keep scanning so a deeper blockquote can
          // fail and pop, instead of breaking here and leaving a fenced
          // code block open to swallow the blank line as content.
          depth = k;
          continue;
        }
        const ind = line.indent();
        if (ind >= blk.ind) {
          line.adv(blk.ind);
          line.item += blk.ind;
          depth = k;
        } else {
          this._fail = k;
          return -1;
        }
      } else {
        break;
      }
    }
    return depth;
  }

  // Content of lines[idx] after stripping the container prefixes of the
  // stack as it stands now. Returns a Line, or null when the line is blank
  // or does not continue the containers.
  peekLine(idx) {
    if (idx >= this.lines.length) return null;
    const line = new Line(this.lines[idx].s, this.lines[idx].nl);
    for (let k = 1; k < this.stack.length; k++) {
      const blk = this.stack[k];
      if (blk.k === 'quote') {
        if (line.blank()) return null;
        const save = this.mark(line);
        line.skipWs(3);
        if (line.at() !== '>') return null;
        line.advCh(1);
        if (line.at() === ' ') line.adv(1);
        else if (line.at() === '\t') line.adv(1);
      } else if (blk.k === 'list') {
        continue;
      } else if (blk.k === 'item') {
        if (line.blank()) return null;
        if (line.indent() < blk.ind) return null;
        line.adv(blk.ind);
      } else {
        break;
      }
    }
    return line;
  }

  build() {
    for (this.ln = 0; this.ln < this.lines.length; this.ln++) {
      this.feed(this.lines[this.ln]);
    }
    this.closeTo(0);
    return { root: this.root, refs: this.refs };
  }

  feed(line) {
    const wasBlank = this.blank;
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
    if (this.matchStack(line) === -1) {
      const top0 = this.top();
      if (top0.k === 'code' && top0.fenced && top0.raw.length > 0 && !line.blank() && !this.anyBlock(line) && this.stack[this._fail] && this.stack[this._fail].k === 'item') {
        this.pushCode(top0, line);
        this.blank = false;
        return;
      }
      if (top0.k === 'p' && !line.blank() && !this.anyBlock(line)) {
        // Lazy continuation. A lazy line's leading indent is stripped by
        // exactly one indented-code level (4 columns) when it has at least
        // that much, and kept otherwise (cm-238, cm-291). A leading tab is
        // expanded to spaces first, from the current column.
        let text;
        {
          const rest = line.tail();
          let col = line.c;
          let lead = '';
          let k = 0;
          while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
            if (rest[k] === ' ') { lead += ' '; col++; k++; }
            else { const w = 4 - (col % 4); lead += ' '.repeat(w); col += w; k++; }
          }
          const indentCols = col - line.c;
          if (indentCols >= 4) lead = lead.slice(4);
          text = lead + rest.slice(k);
        }
        if (this.inQuote()) {
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
        top0.raw.push(text);
        this.blank = false;
        return;
      }
      this.closeTo(this._fail);
    }

    // 2. Leaf blocks that consume the line wholesale.
    let tip = this.top();
    if (tip.k === 'code' && tip.fenced) {
      if (this.closingFence(line)) {
        this.closeTo(this.stack.length - 1);
        this.blank = false;
        return;
      }
      this.pushCode(tip, line);
      this.blank = false;
      return;
    }
    if (tip.k === 'code' && !tip.fenced) {
      // Indented code: blank lines and lines indented 4+ continue it. A
      // blank line inside the code is content, not a block separator.
      if (line.blank()) {
        const save = this.mark(line);
        line.adv(4);
        tip.raw.push(line.tail());
        this.back(line, save);
        this.blank = false;
        return;
      }
      if (line.indent() >= 4) {
        line.adv(4);
        tip.raw.push(line.tail());
        this.blank = false;
        return;
      }
      this.closeTo(this.stack.length - 1);
    } else if (tip.k === 'html') {
      if (this.htmlEnds(tip, line)) {
        // Kinds 1-5: the closing marker is on this line; the line belongs
        // to the block. Kinds 6-7: a blank line ends it and is not consumed.
        if (tip.htmlKind <= 5) {
          tip.raw.push(line.tail());
          tip.lastLn = this.ln;
          tip.lastNl = line.nl;
          tip.trailNl = this.htmlKeepsNl(tip, line);
          this.closeTo(this.stack.length - 1);
          this.blank = false;
          return;
        }
        this.closeTo(this.stack.length - 1);
      } else {
        tip.raw.push(line.tail());
        tip.lastLn = this.ln;
        tip.lastNl = line.nl;
        this.blank = false;
        return;
      }
    } else if (tip.k === 'table') {
      // A line of only spaces (or empty) ends the table, but a line holding
      // a tab is a row of empty cells: the tab counts as content here.
      const rest = line.tail();
      let tableBlank = true;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== ' ') { tableBlank = false; break; }
      }
      if (tableBlank) {
        this.closeTo(this.stack.length - 1);
      } else if (!line.blank() && (this.anyBlock(line) || line.indent() >= 4)) {
        // A line with content that starts any block (heading, fence, list,
        // hr, html, blockquote) or is indented code ends the table; it is
        // not a row. A whitespace-only line is not indented code: a line
        // holding a tab is a row of empty cells.
        this.closeTo(this.stack.length - 1);
      } else {
        const row = this.rowCells(rest);
        if (row === null) {
          this.closeTo(this.stack.length - 1);
        } else {
          tip.rows.push(row);
          this.blank = false;
          return;
        }
      }
    }

    // A line inside a blockquote whose content after the '>' marker is
    // non-empty (even if only spaces) is paragraph content, not a blank
    // line: '>  ' contributes a space line to the paragraph (cm-241).
    // Outside a blockquote, a whitespace-only line is blank. A truly
    // empty line has tail() == '\n' (the newline is part of the line),
    // so strip one trailing newline before testing emptiness.
    const inQuote = this.stack.some((b) => b.k === 'quote');
    const restNoNL = line.tail().replace(/\n$/, '');
    if (inQuote ? restNoNL.length === 0 : line.blank()) {
      this.blankLine();
      return;
    }

    // Paragraph continuation / conversion. A blank line ends the paragraph.
    const cur = this.top();
    if (cur.k === 'p') {
      if (wasBlank) {
        this.closeTo(this.stack.length - 1);
        this.openBlocks(line);
        this.blank = false;
        return;
      }
      if (this.setext(line)) { this.blank = false; return; }
      if (this.tableConvert(line)) { this.blank = false; return; }
      if (this.interruptBlock(line)) {
        this.closeTo(this.stack.length - 1);
        this.openBlocks(line);
        this.blank = false;
        return;
      }
      cur.raw.push(line.c > 0 ? this.expandTabs(line.tail(), line.c - line.item) : line.tail());
      this.blank = false;
      return;
    }
    this.openBlocks(line);
    this.blank = false;
  }

  blankLine() {
    const cur = this.top();
    if (cur.k === 'p') this.closeTo(this.stack.length - 1);
    this.blank = true;
  }

  closingFence(line) {
    const tip = this.top();
    const save = this.mark(line);
    line.skipWs(3);
    const c = line.at();
    if (c !== tip.fenceCh) { this.back(line, save); return false; }
    let n = 0;
    while (line.atOff(n) === tip.fenceCh) n++;
    if (n < tip.fenceN) { this.back(line, save); return false; }
    // A closing fence holds only spaces/tabs after the run.
    let j = n;
    while (line.atOff(j) === ' ' || line.atOff(j) === '\t') j++;
    const ok = line.atOff(j) === '\n' || line.atOff(j) === '';
    this.back(line, save);
    return ok;
  }

  pushCode(tip, line) {
    // Marked expands a tab in fenced-code content while stripping the
    // containers (blockquote: J over the whitespace after '>', starting
    // at the marker length; list: J over the line's leading whitespace
    // from column 0, then the item indent is sliced off), and only then
    // strips the fence indent by CHARACTER count (Dt). So expand the
    // leading tabs first, using the column frame marked uses, and strip
    // the fence indent (backtick only) from the expanded spaces.
    // - innermost container is a blockquote: the tab column is measured
    //   on the list-stripped line, i.e. line.c minus item.
    // - innermost container is a list item: the tab column is the
    //   absolute column (list J starts at column 0 on the whole line).
    // - top level: the tab stays literal.
    let text = line.tail();
    const outer = this.stack[this.stack.length - 2];
    if (this.stack.length > 2 && outer && text.length) {
      let cc = -1;
      // The innermost container's J frame starts fresh on the line after
      // the outer containers were stripped. For a blockquote that is the
      // content start in that frame: the absolute column, minus the list
      // indent, minus 2 for each blockquote above the innermost one
      // (each outer '> ' is stripped before the inner J runs). A list
      // item's J starts at column 0 on the whole line, so the tab column
      // is the absolute column.
      if (outer.k === 'quote') {
        let quotes = 0;
        for (let q = 1; q < this.stack.length - 1; q++) if (this.stack[q].k === 'quote') quotes++;
        cc = line.c - line.item - 2 * Math.max(0, quotes - 1);
      } else if (outer.k === 'item') cc = line.c;
      if (cc >= 0) {
        let m = 0;
        let out = '';
        while (m < text.length && (text[m] === ' ' || text[m] === '\t')) {
          if (text[m] === ' ') { out += ' '; cc++; m++; }
          else {
            const w = 4 - (cc % 4);
            out += ' '.repeat(w);
            cc += w;
            m++;
          }
        }
        text = out + text.slice(m);
      }
    }
    // Tilde fences never strip content indentation; backtick fences strip
    // up to the fence indent by CHARACTER count from the raw leading
    // whitespace (marked's Dt slices min(leadingWhitespace.length,
    // fenceIndent.length) chars: a tab counts as one character, so an
    // indented fence strips a leading tab outright). After container tab
    // expansion the leading whitespace is all spaces, so this also
    // covers that case.
    if (tip.fenceCh === '`') {
      let cut = 0;
      while (cut < text.length && cut < tip.fenceInd && (text[cut] === ' ' || text[cut] === '\t')) cut++;
      text = text.slice(cut);
    }
    tip.raw.push(text);
  }

  // Whether this line ends an open HTML block of kinds 1-7.
  htmlEnds(tip, line) {
    if (tip.htmlKind >= 6) return line.blank();
    const rest = line.tail();
    if (tip.htmlKind === 1) {
      return new RegExp('</' + tip.htmlTag + '\\s*>', 'i').test(rest);
    }
    if (tip.htmlKind === 2) return rest.indexOf('-->') >= 0;
    if (tip.htmlKind === 3) return rest.indexOf('?>') >= 0;
    if (tip.htmlKind === 4) return rest.indexOf('>') >= 0;
    if (tip.htmlKind === 5) return rest.indexOf(']]>') >= 0;
    return line.blank();
  }

  // Whether the HTML block's text keeps the trailing newline of its last
  // line. Kinds 1-5 keep it when the following line is whitespace-only
  // but non-empty (spaces/tabs); a truly empty next line, or non-blank
  // content, drops it.
  htmlKeepsNl(html, line) {
    const next = this.lines[this.ln + 1];
    if (next) {
      if (next.blank()) {
        // Whitespace-only but non-empty: the line holds at least one
        // space or tab before its newline.
        return next.s.length > 0;
      }
      const peek = this.peekLine(this.ln + 1);
      return peek !== null;
    }
    return html.top && line.nl;
  }

  // --- setext heading / table conversion (tip is a paragraph) ---
  setext(line) {
    const save = this.mark(line);
    line.skipWs(3);
    const c = line.at();
    if (c !== '=' && c !== '-') { this.back(line, save); return false; }
    let i = 0;
    while (line.atOff(i) === c) i++;
    let j = i;
    while (line.atOff(j) === ' ' || line.atOff(j) === '\t') j++;
    if (line.atOff(j) !== '\n') { this.back(line, save); return false; }
    const para = this.top();
    const h = node('h');
    h.lvl = c === '=' ? 1 : 2;
    // A setext heading's content drops the first line's leading whitespace
    // and the last line's trailing whitespace.
    const lines = para.raw.slice();
    lines[0] = lines[0].replace(/^[ \t]+/, '');
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
    h.raw = lines;
    const parent = this.stack[this.stack.length - 2];
    parent.kids[parent.kids.length - 1] = h;
    this.stack.pop();
    this.seal(h);
    this.blank = false;
    return true;
  }

  // A one-line paragraph followed by a delimiter row becomes a table.
  tableConvert(line) {
    const para = this.top();
    if (para.raw.length !== 1) return false;
    const header = this.rowCells(para.raw[0]);
    if (header === null) return false;
    const save = this.mark(line);
    const delim = this.delimRow(line.tail());
    if (!delim) { this.back(line, save); return false; }
    if (delim.length !== header.length) { this.back(line, save); return false; }
    const table = node('table');
    table.head = header;
    table.align = delim;
    table.rows = [];
    const parent = this.stack[this.stack.length - 2];
    parent.kids[parent.kids.length - 1] = table;
    this.stack.pop();
    this.stack.push(table);
    this.blank = false;
    return true;
  }

  rowCells(s) {
    let lo = 0;
    let hi = s.length;
    while (lo < hi && (s[lo] === ' ' || s[lo] === '\t')) lo++;
    while (hi > lo && (s[hi - 1] === ' ' || s[hi - 1] === '\t')) hi--;
    s = s.slice(lo, hi);
    const cells = [];
    let cell = '';
    let i = 0;
    if (s[0] === '|') i = 1;
    let stop = s.length;
    if (stop > i && s[stop - 1] === '|' && s[stop - 2] !== '\\') stop--;
    for (; i < stop; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < stop && s[i + 1] === '|') {
        // An escaped pipe is a literal pipe in the cell. The backslash is
        // resolved here, not by the inline parser: a code span's content is
        // not escape-processed, so `\|` inside one must still come out as |.
        cell += '|';
        i++;
        continue;
      }
      if (c === '\\' && i + 1 < stop && s[i + 1] === '\\') {
        cell += s[i] + s[i + 1];
        i++;
        continue;
      }
      if (c === '|') {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += c;
    }
    cells.push(cell.trim());
    return cells;
  }

  delimRow(s) {
    if (s.indexOf('|') < 0) return null;
    const cells = this.rowCells(s);
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
  // Any list marker counts, and so does any HTML block kind. Indented code
  // does not: an indented lazy line stays paragraph text. A backtick fence
  // whose info string holds a backtick is not a fence at all.
  anyBlock(line) {
    const save = this.mark(line);
    line.skipWs(3);
    const c = line.at();
    if (c === '#') { this.back(line, save); return true; }
    if (c === '`' || c === '~') {
      let n = 0;
      while (line.atOff(n) === c) n++;
      if (n >= 3) {
        if (c === '`') {
          let j = n;
          let hasTick = false;
          while (line.atOff(j) !== '\n' && line.atOff(j) !== '') {
            if (line.atOff(j) === '`') { hasTick = true; break; }
            j++;
          }
          if (!hasTick) { this.back(line, save); return true; }
        } else {
          this.back(line, save);
          return true;
        }
      }
    }
    if (c === '<') {
      const ht = this.htmlKind(line);
      this.back(line, save);
      if (ht !== 0) return true;
    }
    if (c === '-' || c === '*' || c === '_') {
      const rest = line.tail();
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) { this.back(line, save); return true; }
    }
    if (c === '>') { this.back(line, save); return true; }
    this.back(line, save);
    const marker = this.listMarker(line, true);
    if (marker) { this.back(line, save); return true; }
    this.back(line, save);
    return false;
  }

  inQuote() {
    for (let k = this.stack.length - 1; k >= 1; k--) {
      if (this.stack[k].k === 'quote') return true;
    }
    return false;
  }

  // Can this line start a block that interrupts a paragraph? (ATX heading,
  // fenced code, HTML block kinds 1-6, thematic break, blockquote, or a list
  // that may interrupt.) A backtick fence whose info string holds a
  // backtick cannot interrupt: it is paragraph text (an inline code span).
  interruptBlock(line) {
    const save = this.mark(line);
    line.skipWs(3);
    let c = line.at();
    if (c === '#') { this.back(line, save); return true; }
    if (c === '`' || c === '~') {
      let n = 0;
      while (line.atOff(n) === c) n++;
      if (n >= 3) {
        if (c === '`') {
          let j = n;
          let hasTick = false;
          while (line.atOff(j) !== '\n' && line.atOff(j) !== '') {
            if (line.atOff(j) === '`') { hasTick = true; break; }
            j++;
          }
          if (!hasTick) { this.back(line, save); return true; }
        } else {
          this.back(line, save);
          return true;
        }
      }
    }
    if (c === '<') {
      const ht = this.htmlKind(line);
      this.back(line, save);
      if (ht !== 0 && ht !== 7) return true;
    }
    if (c === '-' || c === '*' || c === '_') {
      const rest = line.tail();
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) { this.back(line, save); return true; }
    }
    if (c === '>') { this.back(line, save); return true; }
    this.back(line, save);
    const marker = this.listMarker(line, true);
    if (marker) {
      if (!marker.ord) {
        if (!marker.empty) { this.back(line, save); return true; }
      } else if (marker.start === 1 || this.inItem()) {
        // An ordered list interrupts a top-level paragraph only when it
        // starts with 1; inside a list item the marker is a nested list,
        // so any start number interrupts the item's paragraph. An empty
        // item never interrupts (cm-285: '1.' stays paragraph text).
        if (!marker.empty) {
          this.back(line, save);
          return true;
        }
      }
    }
    this.back(line, save);
    return false;
  }

  inItem() {
    for (let k = 1; k < this.stack.length; k++) {
      if (this.stack[k].k === 'item') return true;
    }
    return false;
  }

  // --- block starts ---
  openBlocks(line) {
    // A blank line before a new block inside a list item makes the list
    // loose. (A blank line before a new item is handled by newItem.)
    // When the tip is a list AND the line is a list item for it, the new
    // item joins that list and newItem marks it loose; the walk below
    // would otherwise find the OUTER item (the old item was already popped)
    // and loosen the wrong list. When the line is not such an item, the new
    // block belongs to the item that contains the tip list, so the walk
    // runs (cm-325: 'baz' after a nested list loosens the outer list).
    let skipLoose = false;
    if (this.blank && this.top().k === 'list') {
      const save = this.mark(line);
      const item = this.listMarker(line, false);
      skipLoose = !!(item && this.sameList(this.top(), item));
      this.back(line, save);
    }
    if (this.blank && !skipLoose) {
      // Walk down to the innermost item (a nested list on top does not stop
      // the search: it belongs to the item below it, and a blank line before
      // a new block in that item makes the item's list loose, cm-325).
      for (let k = this.stack.length - 1; k >= 1; k--) {
        const blk = this.stack[k];
        if (blk.k === 'item') {
          if (blk.kids.length > 0) {
            const list = this.stack[k - 1];
            if (list && list.k === 'list') list.loose = true;
          }
          break;
        }
      }
    }
    while (true) {
      if (line.blank()) return;
      const tip = this.top();
      if (tip.k === 'list') {
        // A thematic break ends the list; it is not a list item.
        if (!this.hrLine(line)) {
          const save = this.mark(line);
          const item = this.listMarker(line, false);
          if (item && this.sameList(tip, item)) {
            this.newItem(tip, item, line);
            continue;
          }
          this.back(line, save);
        }
        this.closeTo(this.stack.length - 1);
        continue;
      }
      // Link reference definition.
      const defLines = this.linkDef(line);
      if (defLines > 0) {
        this.ln += defLines - 1;
        return;
      }
      // ATX heading.
      const atx = this.atx(line);
      if (atx) return;
      // Fenced code.
      const fence = this.fence(line);
      if (fence) return;
      // HTML block.
      const html = this.htmlBlock(line);
      if (html) return;
      // Thematic break.
      if (this.hr(line)) return;
      // Blockquote.
      if (this.quote(line)) continue;
      // List.
      const marker = this.listMarker(line, false);
      if (marker) {
        this.newList(marker, line);
        continue;
      }
      // Indented code. The indent is measured relative to the enclosing
      // list item's content (indent(item)): a tab after a blockquote
      // marker inside an item expands from the item-content column, so
      // '> \tindented' in an item of indent 2 is an indent of 2 — a
      // paragraph — not 4 (indented code).
      if (line.indent(line.item) >= 4) {
        const code = node('code');
        code.fenced = false;
        code.raw = [];
        line.adv(4);
        code.raw.push(line.tail());
        this.top().kids.push(code);
        this.stack.push(code);
        this.blank = false;
        return;
      }
      // Paragraph: the text starts where the containers left it (leading
      // spaces are kept, exactly as marked renders them). A leading tab
      // is expanded to spaces from the column relative to the list-item
      // content (c - item: '  > \tindented' inside an item of indent 2
      // puts the tab at relative column 2, so it becomes two spaces),
      // but only when a container was actually consumed (c > 0). At the
      // top level a leading tab is literal content.
      const para = node('p');
      const pcol = line.c - line.item;
      para.raw = [line.c > 0 ? this.expandTabs(line.tail(), pcol) : line.tail()];
      this.top().kids.push(para);
      this.stack.push(para);
      this.blank = false;
      return;
    }
  }

  // Expand leading tabs in `text` to spaces, measuring from column `col`
  // (a tab advances to the next multiple of 4). Leading spaces pass
  // through unchanged. Used for paragraph text after the containers have
  // been stripped, where a tab is content, not indentation.
  expandTabs(text, col) {
    let out = '';
    let k = 0;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) {
      if (text[k] === ' ') { out += ' '; col++; k++; }
      else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; k++; }
    }
    return out + text.slice(k);
  }

  atx(line) {
    const save = this.mark(line);
    line.skipWs(3);
    let level = 0;
    while (line.at() === '#' && level < 7) { line.advCh(1); level++; }
    if (level === 0 || level > 6) { this.back(line, save); return false; }
    const c = line.at();
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '') {
      this.back(line, save);
      return false;
    }
    // All spaces/tabs after the hashes are the separator.
    while (line.at() === ' ' || line.at() === '\t') line.adv(1);
    let text = line.tail();
    // Strip trailing whitespace, then a closing sequence of #s preceded by a
    // space (unless the whole content is just #s, which is then empty).
    text = text.replace(/[ \t]+$/, '');
    const m = /^(.*?)[ \t]+#+$/.exec(text);
    if (m) text = m[1];
    else if (/^#+$/.test(text)) text = '';
    const h = node('h');
    h.lvl = level;
    h.raw = [text];
    this.top().kids.push(h);
    this.stack.push(h);
    this.seal(h);
    this.stack.pop();
    this.blank = false;
    return true;
  }

  fence(line) {
    const save = this.mark(line);
    // The fence's indent is relative to the container content, not the
    // absolute column: a '>' marker must not count as indent, or code lines
    // inside a blockquote lose a leading space.
    const colBefore = line.c;
    line.skipWs(3);
    const fenceInd = line.c - colBefore;
    const c = line.at();
    if (c !== '`' && c !== '~') { this.back(line, save); return false; }
    let n = 0;
    while (line.at() === c) { line.advCh(1); n++; }
    if (n < 3) { this.back(line, save); return false; }
    let info = line.tail();
    if (c === '`' && info.indexOf('`') >= 0) { this.back(line, save); return false; }
    // The info string is the first word, after leading spaces, with
    // backslash escapes resolved.
    info = info.replace(/^[ \t]+/, '');
    const sp = info.search(/[ \t]/);
    if (sp >= 0) info = info.slice(0, sp);
    info = unslash(info);
    const code = node('code');
    code.fenced = true;
    code.fenceCh = c;
    code.fenceN = n;
    code.fenceInd = fenceInd;
    code.info = info;
    code.raw = [];
    this.top().kids.push(code);
    this.stack.push(code);
    this.blank = false;
    return true;
  }

  // HTML block start. Returns the kind (1-7) or 0 when the line does not start
  // one. The line cursor is left after any consumed indentation.
  htmlKind(line) {
    const save = this.mark(line);
    line.skipWs(3);
    const rest = line.tail();
    if (rest[0] !== '<') { this.back(line, save); return 0; }
    const m1 = /^<(script|pre|textarea|style)(?:[\s>]|\/>|$)/i.exec(rest);
    if (m1) return 1;
    if (rest.startsWith('<!--')) return 2;
    if (rest.startsWith('<?')) return 3;
    if (/^<![A-Za-z]/.test(rest)) return 4;
    if (rest.startsWith('<![CDATA[')) return 5;
    const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(rest);
    if (m6 && BLOCK_ELEMENTS.has(m6[1].toLowerCase())) return 6;
    // Kind 7: a complete open or closing tag alone on the line. The tag
    // must be a valid tag (well-formed attributes); a bare regex is too
    // permissive (<a h*#ref="hi"> is not a tag).
    const m7 = scanTag(rest, 0, rest.length);
    if (m7 >= 0 && rest.slice(m7).trim() === '') return 7;
    this.back(line, save);
    return 0;
  }

  htmlBlock(line) {
    const save = this.mark(line);
    const kind = this.htmlKind(line);
    if (kind === 0) { this.back(line, save); return false; }
    // The block's text keeps the line as it stands, leading spaces included.
    this.back(line, save);
    const html = node('html');
    html.htmlKind = kind;
    html.top = this.stack.length === 1;
    html.raw = [];
    html.lastLn = this.ln;
    html.lastNl = line.nl;
    if (kind === 1) {
      const m = /^<(script|pre|textarea|style)/i.exec(line.tail());
      html.htmlTag = m[1].toLowerCase();
    }
    html.raw.push(line.tail());
    // A kind 1-5 block may already end on this very line.
    if (kind <= 5 && this.htmlEnds(html, line)) {
      html.trailNl = this.htmlKeepsNl(html, line);
      this.top().kids.push(html);
      this.seal(html);
      this.blank = false;
      return true;
    }
    this.top().kids.push(html);
    this.stack.push(html);
    this.blank = false;
    return true;
  }

  hrLine(line) {
    const save = this.mark(line);
    line.skipWs(3);
    const c = line.at();
    if (c !== '-' && c !== '*' && c !== '_') { this.back(line, save); return false; }
    const rest = line.tail();
    const ok = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest);
    this.back(line, save);
    return ok;
  }

  hr(line) {
    if (!this.hrLine(line)) return false;
    const hr = node('hr');
    this.top().kids.push(hr);
    this.seal(hr);
    this.blank = false;
    return true;
  }

  quote(line) {
    const save = this.mark(line);
    line.skipWs(3);
    if (line.at() !== '>') { this.back(line, save); return false; }
    line.advCh(1);
    if (line.at() === ' ') line.adv(1);
    else if (line.at() === '\t') line.adv(1);
    const bq = node('quote');
    this.top().kids.push(bq);
    this.stack.push(bq);
    this.blank = false;
    return true;
  }

  // Parse a list item marker at the cursor. Returns null when there is none.
  // `probe` means: do not leave the cursor moved (used when testing whether
  // a line interrupts a paragraph).
  listMarker(line, probe) {
    const save = this.mark(line);
    const col0 = line.c;
    line.skipWs(3);
    const markCol = line.c;
    const c = line.at();
    let bullet = null;
    let ord = false;
    let start = 0;
    let delim = null;
    let markerLen = 0;
    if (c === '-' || c === '+' || c === '*') {
      bullet = c;
      markerLen = 1;
      line.advCh(1);
    } else if (c >= '0' && c <= '9') {
      let num = 0;
      let digits = 0;
      while (digits < 9 && line.at() >= '0' && line.at() <= '9') {
        num = num * 10 + (line.at().charCodeAt(0) - 48);
        line.advCh(1);
        digits++;
      }
      if (digits === 0) { this.back(line, save); return null; }
      // A 10th digit disqualifies the marker.
      if (line.at() >= '0' && line.at() <= '9') { this.back(line, save); return null; }
      const d = line.at();
      if (d !== '.' && d !== ')') { this.back(line, save); return null; }
      ord = true;
      start = num;
      delim = d;
      markerLen = digits + 1;
      line.advCh(1);
    } else {
      this.back(line, save);
      return null;
    }
    // The marker must be followed by 1+ spaces/tabs or the end of the line.
    const after = line.at();
    if (after !== ' ' && after !== '\t' && after !== '\n') {
      this.back(line, save);
      return null;
    }
    // Content indent: the whitespace after the marker, in columns. It is
    // measured relative to the position where the container's content starts
    // (col0), because continuation lines are measured from there too.
    let wsCols = 0;
    {
      let col = line.c;
      let i = line.p;
      let part = line.part;
      while (true) {
        let ch;
        if (part > 0) ch = ' ';
        else if (i < line.s.length) ch = line.s[i];
        else break;
        if (ch === ' ') {
          wsCols++;
          col++;
          if (part > 0) { part--; if (part === 0) i++; }
          else i++;
        } else if (ch === '\t') {
          const w = 4 - (col % 4);
          wsCols += w;
          col += w;
          i++;
          part = 0;
        } else break;
      }
    }
    let contentIndent;
    let empty = false;
    // An item with only whitespace after the marker is empty: its content
    // indent is marker + 1, not marker + all the trailing spaces (cm-279:
    // '-   ' has content indent 2, so the following '  foo' is its content).
    const restAfterMarker = line.tail();
    let onlyWs = true;
    for (let k = 0; k < restAfterMarker.length; k++) {
      const ch = restAfterMarker[k];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n') { onlyWs = false; break; }
    }
    if (onlyWs) {
      contentIndent = markCol + markerLen + 1;
      empty = true;
    } else if (wsCols >= 1 && wsCols <= 4) {
      contentIndent = markCol + markerLen + wsCols;
    } else {
      contentIndent = markCol + markerLen + 1;
    }
    // Move the cursor to the content position.
    line.adv(contentIndent - line.c);
    const info = { bullet, ord, start, delim, ind: contentIndent - col0, empty, col0 };
    if (probe) this.back(line, save);
    return info;
  }

  sameList(list, item) {
    if (list.ord !== item.ord) return false;
    if (item.ord) return list.delim === item.delim;
    return list.bullet === item.bullet;
  }

  newList(marker, line) {
    const list = node('list');
    list.ord = marker.ord;
    list.bullet = marker.bullet;
    list.delim = marker.delim;
    list.start = marker.start;
    list.loose = false;
    this.top().kids.push(list);
    this.stack.push(list);
    this.newItem(list, marker, line);
  }

  newItem(list, marker, line) {
    // A blank line before a new item (after the first) makes the list loose.
    if (this.blank && list.kids.length > 0) list.loose = true;
    const item = node('item');
    item.ind = marker.ind;
    item.task = null;
    // Task list checkbox: [ ], [x], [X] followed by a space/tab or EOL.
    if (!marker.empty) {
      const rest = line.tail();
      const m = /^\[([ xX])\]([ \t]|\n|$)/.exec(rest);
      if (m) {
        item.task = m[1] === ' ' ? 'unchecked' : 'checked';
        line.advCh(3);
        if (line.at() === ' ' || line.at() === '\t') line.adv(1);
      }
    }
    list.kids.push(item);
    this.stack.push(item);
    this.blank = false;
  }

  // --- link reference definitions ---
  // Parse a link reference definition starting at the cursor. Returns the
  // number of source lines consumed (1..4) or 0. The definition is parsed
  // from the current line plus up to 10 following lines (after container
  // stripping). The first definition for a label wins.
  linkDef(line) {
    // Fast reject: a definition starts with '[' after at most 3 spaces
    // of indent. Most paragraphs do not, so skip the 10-line lookahead
    // and full parse attempt entirely for them.
    let j = 0;
    while (j < 3 && (line.atOff(j) === ' ' || line.atOff(j) === '\t')) j++;
    if (line.atOff(j) !== '[') return 0;
    const parts = [line.tail()];
    for (let k = 1; k <= 10; k++) {
      const nxt = this.peekLine(this.ln + k);
      if (nxt === null) break;
      parts.push(nxt.tail());
    }
    const s = parts.join('\n');
    const res = this.defText(s);
    if (!res) return 0;
    const key = normLabel(res.label);
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
  defWs(s, p) {
    let lines = 0;
    while (p < s.length) {
      const c = s[p];
      if (c === ' ' || c === '\t') { p++; continue; }
      if (c === '\n') {
        lines++;
        if (lines > 1) return -1;
        p++;
        continue;
      }
      break;
    }
    return p;
  }

  // Parse the whole definition text (label ':' dest [title], then end of
  // line). Returns {label, dest, title, end} or null.
  defText(s) {
    let p = 0;
    let pad = 0;
    while (s[p] === ' ' && pad < 3) { p++; pad++; }
    if (s[p] !== '[') return null;
    p++;
    // Label: no unescaped '[' inside, newlines allowed (but no blank line).
    // Backslash escapes stay raw in the label (they are resolved when the
    // label is rendered as text, not when it is matched).
    let name = '';
    let done = false;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length) {
        name += c + s[p + 1];
        p += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') { done = true; p++; break; }
      if (c === '\n') {
        if (s[p + 1] === '\n') return null;
        name += ' ';
        p++;
        continue;
      }
      name += c;
      p++;
    }
    if (!done || name.length === 0) return null;
    if (s[p] !== ':') return null;
    p++;
    p = this.defWs(s, p);
    if (p < 0) return null;
    if (s[p] === '<') {
      // Angle destination: try each '>' on this line in turn (marked's
      // permissive rule) and keep the first one whose remainder completes.
      // An escaped \> is part of the destination, not the closer.
      let q = p + 1;
      while (q < s.length && s[q] !== '\n') {
        if (s[q] === '\\' && q + 1 < s.length) { q += 2; continue; }
        if (s[q] === '>') {
          const fin = this.defTail(s, q + 1);
          if (fin) return { label: name, dest: unslash(s.slice(p + 1, q)), title: fin.title, end: fin.end };
        }
        q++;
      }
      return null;
    }
    // Bare destination: non-space, non-control characters, balanced parens,
    // backslash escapes. It cannot span lines.
    let q = p;
    let lvl = 0;
    let url = '';
    while (q < s.length) {
      const c = s[q];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) {
        url += s[q + 1];
        q += 2;
        continue;
      }
      if (c === '(') lvl++;
      else if (c === ')') {
        if (lvl === 0) break;
        lvl--;
      }
      url += c;
      q++;
    }
    if (url.length === 0 || lvl !== 0) return null;
    const fin = this.defTail(s, q);
    if (!fin) return null;
    return { label: name, dest: url, title: fin.title, end: fin.end };
  }

  // After the destination at index i, finish the definition: an optional
  // title (same line or the next), then only whitespace to the end of a line.
  // Returns {end, title} or null.
  defTail(s, i) {
    let k = i;
    const ws0 = k;
    while (s[k] === ' ' || s[k] === '\t') k++;
    const spaced = k > ws0;
    let text = null;
    if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
      // A title must be separated from the destination by whitespace; a
      // quote/paren glued to the destination is trailing junk, not a title.
      if (!spaced) return null;
      const fin = this.defTitle(s, k);
      if (!fin) return null;
      text = fin.title;
      k = fin.end;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (s[k] === '\n' || k >= s.length) return { end: k, title: text };
      return null;
    }
    if (s[k] === '\n') {
      // Maybe the title is on the next line. If it is there but malformed
      // (or followed by junk), the definition still stands without a
      // title and the next line is not consumed.
      let m = k + 1;
      while (s[m] === ' ' || s[m] === '\t') m++;
      if (s[m] === '"' || s[m] === "'" || s[m] === '(') {
        const fin = this.defTitle(s, m);
        if (!fin) return { end: k, title: null };
        text = fin.title;
        m = fin.end;
        while (s[m] === ' ' || s[m] === '\t') m++;
        if (s[m] === '\n' || m >= s.length) return { end: m, title: text };
        return { end: k, title: null };
      }
      return { end: k, title: null };
    }
    if (k >= s.length) return { end: k, title: null };
    return null;
  }

  // Parse a link title at index i of s ('"' / "'" / '(' form). Returns
  // {title, end} or null. The title may span lines, but not a blank line.
  defTitle(s, i) {
    const mark = s[i];
    let p = i + 1;
    let text = '';
    if (mark === '"' || mark === "'") {
      while (p < s.length) {
        const c = s[p];
        if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) {
          text += s[p + 1];
          p += 2;
          continue;
        }
        if (c === mark) return { title: text, end: p + 1 };
        if (c === '\n') {
          if (s[p + 1] === '\n') return null;
          text += '\n';
          p++;
          continue;
        }
        text += c;
        p++;
      }
      return null;
    }
    // '(' form: no unescaped '(' inside; ends at the first unescaped ')'.
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) {
        text += s[p + 1];
        p += 2;
        continue;
      }
      if (c === '(') return null;
      if (c === ')') return { title: text, end: p + 1 };
      if (c === '\n') {
        if (s[p + 1] === '\n') return null;
        text += '\n';
        p++;
        continue;
      }
      text += c;
      p++;
    }
    return null;
  }
}

// ---------- shared tag / title / autolink helpers ----------
// A domain label for www/scheme autolinks: starts with alnum or '-'
// (never '_'), then alnum, '-' or '_' — marked links www.foo_bar.com
// and www.-foo.com but not www._foo.com.
// Email domains are more permissive (labels may start with '_'):
// see MAIL_LABEL_RE.
const DOM_LABEL_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]*$/;
const MAIL_LABEL_RE = /^[A-Za-z0-9_-]+$/;
function domainOk(domain, minLabels, re = DOM_LABEL_RE) {
  const labels = domain.split('.');
  if (labels.length < minLabels) return false;
  for (const lab of labels) {
    if (!re.test(lab)) return false;
  }
  return true;
}
function emailOk(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  for (let i = 0; i < local.length; i++) {
    if (!isEmailCh(local[i])) return false;
  }
  return domainOk(domain, 2, MAIL_LABEL_RE);
}

// Trim a GFM extended autolink: drop trailing ? ! . , : ; * _ ~, drop a
// trailing ')' only when that particular ')' is unmatched in a stack scan
// (repeat), then cut everything from the first unmatched '('. Cutting can
// expose trailing punctuation again, so strip a second time.
function trimLink(url) {
  const TAIL_CHARS = '?!.,:;*_~';
  // Run the whole trim until it stops changing anything: trimming a ')'
  // can expose a '.', trimming that can expose another ')', and so on
  // ('https://x/nova).)' -> 'https://x/nova').
  let last;
  do {
    last = url;
    let cut = url.length;
    while (cut > 0 && TAIL_CHARS.indexOf(url[cut - 1]) >= 0) cut--;
    url = url.slice(0, cut);
    // Drop a trailing ')' only when that specific ')' is unmatched.
    while (url.length > 0 && url[url.length - 1] === ')') {
      let lvl = 0;
      let paired = false;
      for (let i = 0; i < url.length; i++) {
        if (url[i] === '(') lvl++;
        else if (url[i] === ')') {
          if (lvl > 0) {
            lvl--;
            if (i === url.length - 1) paired = true;
          }
        }
      }
      if (!paired) url = url.slice(0, -1);
      else break;
    }
    // Truncate at the first unmatched '('.
    {
      const opens = [];
      for (let i = 0; i < url.length; i++) {
        if (url[i] === '(') opens.push(i);
        else if (url[i] === ')') opens.pop();
      }
      if (opens.length) url = url.slice(0, opens[0]);
    }
    cut = url.length;
    while (cut > 0 && TAIL_CHARS.indexOf(url[cut - 1]) >= 0) cut--;
    url = url.slice(0, cut);
  } while (url !== last);
  return url;
}

// Parse an HTML tag starting at index i of s (s has length len). Returns
// the index just past the tag, or -1. Shared by block HTML (kind 7) and
// inline HTML: tag name, then attributes separated by whitespace, each an
// optional name = value (quoted or unquoted); a closing tag takes no
// attributes.
function scanTag(s, i, len) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (!isLetter(s[j])) return -1;
  j++;
  while (isAlnumAscii(s[j]) || s[j] === '-') j++;
  if (closing) {
    while (j < len && isSpace(s[j])) j++;
    if (s[j] === '>') return j + 1;
    return -1;
  }
  while (true) {
    const wsStart = j;
    while (j < len && isSpace(s[j])) j++;
    const hadWs = j > wsStart;
    if (j >= len) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') {
      if (s[j + 1] === '>') return j + 2;
      return -1;
    }
    if (!hadWs) return -1;
    if (!isLetter(s[j]) && s[j] !== '_' && s[j] !== ':') return -1;
    j++;
    while (isAlnumAscii(s[j]) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-') j++;
    // Whitespace before '=' is allowed, but only consume it when '=' really
    // follows: otherwise the space belongs to the next attribute (which
    // needs hadWs to be recognized, e.g. '_boolean zoop:33=...').
    const wsAfterName = j;
    while (j < len && isSpace(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < len && isSpace(s[j])) j++;
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
function readTitle(s, i) {
  const mark = s[i];
  let p = i + 1;
  let text = '';
  if (mark === '"' || mark === "'") {
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) {
        text += s[p + 1];
        p += 2;
        continue;
      }
      if (c === mark) return { title: text, end: p + 1 };
      if (c === '\n') {
        if (s[p + 1] === '\n') return null;
        text += '\n';
        p++;
        continue;
      }
      text += c;
      p++;
    }
    return null;
  }
  while (p < s.length) {
    const c = s[p];
    if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) {
      text += s[p + 1];
      p += 2;
      continue;
    }
    if (c === '(') return null;
    if (c === ')') return { title: text, end: p + 1 };
    if (c === '\n') {
      if (s[p + 1] === '\n') return null;
      text += '\n';
      p++;
      continue;
    }
    text += c;
    p++;
  }
  return null;
}

// Scan a link's text (raw source) for code spans, for the rule that a link
// is blocked when its text holds an odd number of "bad" code spans (whose
// content contains a backtick) plus unclosed backtick runs, unless the last
// bad span ends exactly at the end of the text. Returns true when the link
// is blocked. Collapsed and shortcut references are exempt (callers decide).
function linkBlocked(text) {
  let badCount = 0;
  let openRuns = 0;
  let lastBad = -1;
  // Closed code spans (any length) and unclosed '``' runs: a text that
  // holds an unclosed '``' AND a closed code span is blocked ('[a
  // ``b`][c]: [`d`](url)' does not form the link), while a text with
  // only unclosed runs is judged by parity ('[issue read two
  // ``small`](url)' forms).
  let closed = 0;
  let openDouble = 0;
  let p = 0;
  while (p < text.length) {
    // A backslash escape is a literal character, not a code-span
    // delimiter: '\`' is a literal backtick, so it can neither open a
    // span nor count as unclosed ('[but \`promise](url)' forms the link).
    if (text[p] === '\\' && p + 1 < text.length && isAsciiPunct(text[p + 1])) { p += 2; continue; }
    if (text[p] !== '`') { p++; continue; }
    let len = 0;
    while (text[p + len] === '`') len++;
    // Search for a closing run of the same length (skipping escapes).
    let q = p + len;
    let closeAt = -1;
    while (q < text.length) {
      if (text[q] === '\\' && q + 1 < text.length && isAsciiPunct(text[q + 1])) { q += 2; continue; }
      if (text[q] === '`') {
        let run = 0;
        while (text[q + run] === '`') run++;
        if (run === len) { closeAt = q; break; }
        q += run;
      } else {
        q++;
      }
    }
    if (closeAt < 0) {
      openRuns++;
      if (len === 2) openDouble++;
      p += len;
      continue;
    }
    closed++;
    const inner = text.slice(p + len, closeAt);
    if (inner.indexOf('`') >= 0) {
      badCount++;
      lastBad = closeAt + len;
    }
    p = closeAt + len;
  }
  if (openDouble > 0 && closed > 0) return true;
  if (badCount === 0) return (openRuns % 2) === 1;
  const total = badCount + openRuns;
  return (total % 2) === 1 && lastBad !== text.length;
}

// ---------- inline parser (InlineParser) ----------
// Token model: the inline content is a flat list of tokens. Text tokens hold
// raw source text; delimiter tokens hold a run of *, _ or ~ plus the emphasis
// tags they earned (oTags prepended, cTags appended) and how many of the
// run were consumed (used). Emphasis is resolved by resolve, which only
// mutates delimiter tokens, so no token list restructuring is needed. A link
// is formed by replacing the '[' token with an aOpen token and appending an
// aClose token; an image replaces the '!' token and drops the tokens from
// '[' onward.
//
// `links` is a document-level object shared across every inline parse:
// an inline `<a ` tag sets links.inLink, an inline `</a>` clears it, and
// while it is set, bare-URL and email extended autolinks are plain text.
// (Angle-bracket autolinks and markdown links are unaffected.)
class InlineParser {
  constructor(src, refs, links) {
    this.s = src;
    this.refs = refs;
    this.links = links;
    this.len = src.length;
    this.p = 0;
    this.toks = [];
    this.stack = [];
    this.opens = [];
    this.buf = '';
    // Buffer indices that came from a backslash escape (the char is a
    // literal, not a structural character): an email autolink's local part
    // may not include such a character.
    this.bufEsc = new Set();
    // Emphasis spans that have already formed in this inline run, as
    // {tag, ch, open, close} (source positions). Used by the M1 and R
    // rules, which look at what formed inside a span before it closes.
    this.formed = [];
    // True once a link whose text holds an unclosed '``' run has formed
    // in this inline run. After such a link, marked does not form
    // emphasis when a code span follows later in the paragraph.
    this.afterBadLink = false;
  }

  run() {
    while (this.p < this.len) {
      const c = this.s[this.p];
      // Letters are by far the most common character in prose: check
      // them first so a letter costs one comparison instead of failing
      // ten special-character tests. An extended autolink (www. or
      // scheme:) can only start where the previous character is not a
      // scheme character: autolink returns false for a letter preceded
      // by a letter/digit, so mid-word letters never start one. Skip
      // the scan entirely there instead of calling autolink (and scheme)
      // for every letter of every word.
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
        if (!this.links.inLink && (this.p === 0 || !isSchemeCh(this.s[this.p - 1])) && this.autolink()) continue;
        this.buf += c;
        this.p++;
        continue;
      }
      if (c === '\\') { this.backslash(); continue; }
      if (c === '`') { this.backtick(); continue; }
      if (c === '[') { this.openBracket(false); continue; }
      if (c === '!') {
        if (this.s[this.p + 1] === '[') { this.openBracket(true); continue; }
        this.buf += '!';
        this.p++;
        continue;
      }
      if (c === ']') { this.closeBracket(); continue; }
      if (c === '<') { this.angle(); continue; }
      if (c === '&') { this.entity(); continue; }
      if (c === '*' || c === '_' || c === '~') { this.delim(c); continue; }
      if (c === '\n') { this.newline(); continue; }
      if (c === '@') {
        if (!this.links.inLink && this.email()) continue;
        this.buf += '@';
        this.p++;
        continue;
      }
      this.buf += c;
      this.p++;
    }
    this.flush();
    this.resolve(null, true);
    return this.render();
  }

  flush() {
    if (this.buf.length) {
      this.toks.push({ k: 'text', s: this.buf, esc: this.bufEsc.size ? new Set(this.bufEsc) : undefined });
      this.buf = '';
      this.bufEsc = new Set();
    }
  }

  backslash() {
    const next = this.s[this.p + 1];
    if (next === '\n') {
      // Hard break (backslash + newline): the next line's leading
      // whitespace is swallowed with it.
      this.flush();
      this.toks.push({ k: 'br' });
      this.p += 2;
      while (this.p < this.len && (this.s[this.p] === ' ' || this.s[this.p] === '\t')) this.p++;
      return;
    }
    if (next !== undefined && isAsciiPunct(next)) {
      // An escaped & is a literal &, so it must be escaped in the output
      // (escText would otherwise leave &word; alone).
      this.buf += next === '&' ? '&amp;' : next;
      this.bufEsc.add(this.buf.length - 1);
      this.p += 2;
      return;
    }
    this.buf += '\\';
    this.p++;
  }

  backtick() {
    const start = this.p;
    let n = 0;
    while (this.s[start + n] === '`') n++;
    // A single backtick inside a link's text that already holds an
    // unclosed double-backtick run is literal, not a code-span opener:
    // '[docs each ``url`](...)' forms the link (the '`' after 'url'
    // must not pair with a '`' after the link and swallow the ']').
    // Without the unclosed '``' the single backtick pairs normally
    // (cm-342 '[not a `link](/foo`)' keeps its code span). This applies
    // when the link's ']' is followed by '(' (inline link), or by '['
    // whose label is a DEFINED reference ('[run ``response`][tool-91]'
    // forms when tool-91 is defined, so its '`' is literal; when the
    // label is undefined the '`' pairs across and forms a code span).
    if (n === 1 && this.opens.length > 0) {
      const open = this.opens[this.opens.length - 1];
      if (this.hasOpenDouble(open.src, start)) {
        let lvl = 0;
        let closeAt = -1;
        for (let j = start + 1; j < this.len; j++) {
          const c = this.s[j];
          if (c === '\\' && j + 1 < this.len) { j++; continue; }
          if (c === '[') lvl++;
          else if (c === ']') {
            if (lvl === 0) { closeAt = j; break; }
            lvl--;
          }
        }
        let forms = false;
        if (closeAt >= 0) {
          if (this.s[closeAt + 1] === '(') forms = true;
          else if (this.s[closeAt + 1] === '[') {
            const lbl = this.readLabel(closeAt + 1);
            if (lbl) {
              const name = lbl.label === '' ? this.s.slice(open.src, closeAt) : lbl.label;
              if (name.length <= 999 && !hasOpenBracket(name) && this.refs.has(normLabel(name))) forms = true;
            }
          }
        }
        if (forms) {
          this.buf += '`';
          this.p += 1;
          return;
        }
      }
    }
    // A multi-backtick run inside a link text cannot close past the
    // ']' that ends that link: '[docs each ``url`](...)' must not let
    // the '``' before 'url' pair with a later '``' and swallow the ']'.
    // Single backticks are left unbounded (a '`' code span may span a
    // ']' — cm-342, cm-525, cm-537 — but a '``' span may not).
    let limit = this.len;
    if (n >= 2 && this.opens.length > 0) {
      let lvl = 0;
      for (let j = start + n; j < this.len; j++) {
        const c = this.s[j];
        if (c === '\\' && j + 1 < this.len) { j++; continue; }
        if (c === '[') lvl++;
        else if (c === ']') {
          if (lvl === 0) { limit = j; break; }
          lvl--;
        }
      }
    }
    const res = this.codeSpan(start, n, limit);
    if (res) {
      this.flush();
      this.toks.push({ k: 'code', s: res.text });
      this.p = res.end;
      return;
    }
    this.buf += '`'.repeat(n);
    this.p += n;
  }

  // Is there a code span (a backtick run with a matching closing run)
  // starting at or after `from`?
  laterCode(from) {
    let i = from;
    while (i < this.len) {
      if (this.s[i] === '\\' && i + 1 < this.len && isAsciiPunct(this.s[i + 1])) { i += 2; continue; }
      if (this.s[i] !== '`') { i++; continue; }
      let n = 0;
      while (this.s[i + n] === '`') n++;
      if (this.codeSpan(i, n)) return true;
      i += n;
    }
    return false;
  }

  // Is there a '``' run in s[from, to) with no closing run of exactly 2
  // backticks in the same range? (Backslash-escaped backticks are skipped.)
  hasOpenDouble(from, to) {
    let p = from;
    while (p < to) {
      if (this.s[p] === '\\' && p + 1 < to && isAsciiPunct(this.s[p + 1])) { p += 2; continue; }
      if (this.s[p] !== '`') { p++; continue; }
      let run = 0;
      while (this.s[p + run] === '`') run++;
      if (run === 2) {
        let q = p + run;
        let done = false;
        while (q < to) {
          if (this.s[q] === '\\' && q + 1 < to && isAsciiPunct(this.s[q + 1])) { q += 2; continue; }
          if (this.s[q] === '`') {
            let m2 = 0;
            while (this.s[q + m2] === '`') m2++;
            if (m2 === 2) { done = true; break; }
            q += m2;
          } else {
            q++;
          }
        }
        if (!done) return true;
        p = q + 2;
        continue;
      }
      p += run;
    }
    return false;
  }

  codeSpan(pos, n, limit = this.len) {
    let j = pos + n;
    while (j < limit) {
      if (this.s[j] === '`') {
        let run = 0;
        while (this.s[j + run] === '`') run++;
        if (run === n) {
          let inner = this.s.slice(pos + n, j);
          inner = inner.replace(/\n/g, ' ');
          if (inner.length >= 2 && inner[0] === ' ' && inner[inner.length - 1] === ' ' && !/^[ ]+$/.test(inner)) {
            inner = inner.slice(1, -1);
          }
          return { text: inner, end: j + run };
        }
        j += run;
      } else {
        j++;
      }
    }
    return null;
  }

  newline() {
    // Hard break when the current text run ends in 2+ spaces (no tabs).
    const buf = this.buf;
    let n = 0;
    for (let j = buf.length - 1; j >= 0 && buf[j] === ' '; j--) n++;
    if (n >= 2) {
      this.buf = buf.slice(0, buf.length - n);
      this.flush();
      this.toks.push({ k: 'br' });
      this.p++;
      // A hard break swallows the next line's leading whitespace.
      while (this.p < this.len && (this.s[this.p] === ' ' || this.s[this.p] === '\t')) this.p++;
      return;
    }
    this.buf += '\n';
    this.p++;
  }

  entity() {
    const src = this.s;
    if (src[this.p + 1] === '#') {
      let j = this.p + 2;
      let hex = false;
      if (src[j] === 'x' || src[j] === 'X') { hex = true; j++; }
      const start = j;
      // A numeric reference is at most 7 decimal or 6 hex digits; longer
      // runs are not references at all.
      const maxDigits = hex ? 6 : 7;
      let digits = 0;
      if (hex) {
        while (digits < maxDigits + 1 && isHex(src[j])) { j++; digits++; }
      } else {
        while (digits < maxDigits + 1 && src[j] >= '0' && src[j] <= '9') { j++; digits++; }
      }
      if (digits >= 1 && digits <= maxDigits && src[j] === ';') {
        const body = src.slice(start, j);
        const decoded = numRef(hex ? 'x' + body : body);
        if (decoded !== null) {
          // A decoded & is a literal &, escaped in the output.
          this.buf += decoded === '&' ? '&amp;' : decoded;
          this.p = j + 1;
          return;
        }
      }
    }
    // Named entities pass through unchanged (marked does not decode them);
    // a bare '&' is escaped by escText at render time.
    this.buf += '&';
    this.p++;
  }

  delim(c) {
    const pos = this.p;
    let n = 0;
    while (this.s[pos + n] === c) n++;
    // A run of 3+ tildes is not a strikethrough delimiter at all (it is
    // literal text); only runs of 1 or 2 tildes can open/close <del>.
    if (c === '~' && n >= 3) {
      this.buf += c.repeat(n);
      this.p += n;
      return;
    }
    const before = pos > 0 ? this.s[pos - 1] : '';
    const after = this.s[pos + n] || '';
    const beforeWs = before === '' || isSpace(before);
    const afterWs = after === '' || isSpace(after);
    const beforePunct = before !== '' && isPunct(before);
    const afterPunct = after !== '' && isPunct(after);
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
    this.flush();
    const tok = { k: 'delim', ch: c, n, open: canOpen, close: canClose, used: 0, oTags: [], cTags: [], pos, leftIn: false, inLink: this.opens.length > 0 };
    this.toks.push(tok);
    if (canOpen || canClose) this.stack.push(tok);
    // A closer resolves emphasis against the openers seen so far, so the
    // innermost pair is settled before an outer closer can steal a delimiter.
    // Inside a link's text, only openers above the link's '[' may match.
    if (canClose) {
      const bottom = this.opens.length ? this.opens[this.opens.length - 1].floor : null;
      this.resolve(bottom, false);
    }
    this.p += n;
  }

  // True when an em (single-mark) match between `opener` and `closer` is
  // blocked by marked's rule: a strong of the same mark already formed
  // strictly inside the pair, its opening run is preceded by a
  // non-alphanumeric character (a space, punctuation, or another delimiter
  // — when it follows a word character directly, as in `*foo**bar**baz*`,
  // the outer em forms), and its closing run is immediately followed by a
  // word character (`*a **b**c*` leaves the outer `*` literal, while
  // `*a **b** c*` forms the em).
  m1Block(opener, closer) {
    for (const span of this.formed) {
      if (span.tag !== 'strong' || span.ch !== closer.ch) continue;
      if (span.open <= opener.pos) continue;
      if (span.close > closer.pos) continue;
      const prev = span.open > 0 ? this.s[span.open - 1] : '';
      if (prev !== '' && isAlnum(prev)) continue;
      if (span.close >= closer.pos) continue;
      // The character after the strong: skip any leftover delimiters of
      // the same run (a '___' closer that gave 2 to the strong leaves a
      // '_' behind — it is a delimiter, not a word character following
      // the strong; without this skip '_a _b __c___ d_' loses its outer
      // em because '_' counts as a word char).
      let k = span.close;
      while (this.s[k] === span.ch) k++;
      if (!isWord(this.s[k])) continue;
      return true;
    }
    return false;
  }

  // Does the source between opener (exclusive) and closer (exclusive)
  // hold a code span whose content contains a backtick?
  badSpanInside(opener, closer) {
    const seg = this.s.slice(opener.pos + opener.n, closer.pos);
    let p = 0;
    while (p < seg.length) {
      if (seg[p] === '\\' && p + 1 < seg.length && isAsciiPunct(seg[p + 1])) { p += 2; continue; }
      if (seg[p] !== '`') { p++; continue; }
      let run = 0;
      while (seg[p + run] === '`') run++;
      let q = p + run;
      let closeAt = -1;
      while (q < seg.length) {
        if (seg[q] === '\\' && q + 1 < seg.length && isAsciiPunct(seg[q + 1])) { q += 2; continue; }
        if (seg[q] === '`') {
          let m2 = 0;
          while (seg[q + m2] === '`') m2++;
          if (m2 === run) { closeAt = q; break; }
          q += m2;
        } else {
          q++;
        }
      }
      if (closeAt < 0) return false;
      const inner = seg.slice(p + run, closeAt);
      if (inner.indexOf('`') >= 0) return true;
      p = closeAt + run;
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
  laterDouble(current) {
    const ch = current.ch;
    let p = current.pos + current.n;
    while (p < this.len) {
      const c = this.s[p];
      if (c === '\\' && p + 1 < this.len) { p += 2; continue; }
      if (c === '`') {
        let run = 0;
        while (this.s[p + run] === '`') run++;
        const res = this.codeSpan(p, run);
        if (res) { p = res.end; continue; }
        p += run;
        continue;
      }
      if (c === ch) {
        let run = 0;
        while (this.s[p + run] === ch) run++;
        if (run >= 2) {
          const prev = p > 0 ? this.s[p - 1] : '';
          if (prev !== '' && !isSpace(prev)) return true;
        }
        p += run;
        continue;
      }
      p++;
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
  resolve(bottom, isFinal) {
    let closer = this.stack.length ? this.stack[this.stack.length - 1] : null;
    while (closer && closer !== bottom) {
      if (closer.close && closer.used < closer.n) {
        const ci = this.stack.indexOf(closer);
        const cLeft = closer.n - closer.used;
        let op = null;
        for (let j = ci - 1; j >= 0; j--) {
          const cand = this.stack[j];
          if (cand === bottom) break;
          if (cand.ch !== closer.ch || !cand.open || cand.used >= cand.n) continue;
          const oLeft = cand.n - cand.used;
          // Rule of 3: when one delimiter can both open and close, the pair
          // cannot match if the sum of the runs is a multiple of 3 UNLESS
          // both runs are multiples of 3.
          const odd = (closer.open || cand.close) &&
            ((oLeft + cLeft) % 3 === 0) && !(oLeft % 3 === 0 && cLeft % 3 === 0);
          if (odd) continue;
          if (cand.deferred && !isFinal) {
            const clean = oLeft === cLeft || (oLeft >= 2 && cLeft >= 2);
            if (!clean) continue;
          }
          // M1: a single-mark em is blocked by a strong of the same mark
          // that already formed strictly inside the pair.
          if (!(oLeft >= 2 && cLeft >= 2) && this.m1Block(cand, closer)) continue;
          // After a link whose text holds an unclosed '``' run, emphasis
          // does not form when a code span follows later in the
          // paragraph ('[a ``b`](url) __c__ `d`' leaves '__c__' literal,
          // but '[a ``b`](url) __c__' forms the strong). Both the flag
          // and a later code span are required.
          if (this.afterBadLink && this.laterCode(closer.pos + closer.n)) continue;
          // An emphasis opener scanned inside a link text ('[' open)
          // whose content holds a code span with a backtick in it does
          // not form ('[at _node `` a ` b ``_](url)' leaves the '_'
          // literal). In a plain paragraph such an em DOES form, so the
          // 'inLink' flag recorded on the opener at scan time is what
          // gates it — the flag survives to the final emphasis pass,
          // when the brackets are already closed.
          if (cand.inLink && this.badSpanInside(cand, closer)) continue;
          // A single closer must not steal one delimiter from a double
          // opener when a later double closer can form the strong with
          // it instead ('**a *b*c* d**' is a strong, not nested ems).
          // But only when the inner em's closer is immediately followed
          // by a word character ('*b*c*': the '*' after 'b' can open);
          // with a space there ('*b* c*') the nested ems stand.
          if (cLeft === 1 && oLeft >= 2) {
            let innerWord = false;
            for (const f of this.formed) {
              if (f.tag !== 'em' || f.ch !== closer.ch) continue;
              if (f.open <= cand.pos) continue;
              if (f.close > closer.pos) continue;
              if (isWord(this.s[f.close])) { innerWord = true; break; }
            }
            if (innerWord && this.laterDouble(closer)) continue;
          }
          op = cand;
          break;
        }
        if (op) {
          const oLeft = op.n - op.used;
          if (!isFinal && closer.open && oLeft !== cLeft && !(oLeft >= 2 && cLeft >= 2)) {
            closer.deferred = true;
            const ci2 = this.stack.indexOf(closer);
            closer = ci2 > 0 ? this.stack[ci2 - 1] : null;
            continue;
          }
          const take = (oLeft >= 2 && cLeft >= 2) ? 2 : 1;
          const tag = closer.ch === '~' ? 'del' : (take === 2 ? 'strong' : 'em');
          op.oTags.unshift('<' + tag + '>');
          closer.cTags.push('</' + tag + '>');
          op.used += take;
          closer.used += take;
          // Remember the formed span for the M1/R rules.
          this.formed.push({ tag, ch: closer.ch, open: op.pos, close: closer.pos + take });
          // R: when a strong closes with a leftover delimiter, the leftover
          // renders INSIDE the strong (before </strong>) iff a closed inner
          // em's closing delimiter is immediately followed by a word char
          // (`**foo *bar*baz***`); otherwise it renders outside, as usual.
          if (take === 2 && closer.n - closer.used > 0) {
            for (const f of this.formed) {
              if (f.tag !== 'em' || f.ch !== closer.ch) continue;
              if (f.open <= op.pos) continue;
              if (f.close > closer.pos) continue;
              if (f.close < closer.pos && isWord(this.s[f.close])) {
                closer.leftIn = true;
                break;
              }
            }
          }
          // Scope: delimiters between the opener and closer are inside the
          // emphasis; drop them from the stack so they cannot match outside.
          let oIdx = this.stack.indexOf(op);
          let cIdx = this.stack.indexOf(closer);
          if (oIdx >= 0 && cIdx >= 0 && cIdx > oIdx + 1) {
            this.stack.splice(oIdx + 1, cIdx - oIdx - 1);
            oIdx = this.stack.indexOf(op);
            cIdx = this.stack.indexOf(closer);
          }
          if (op.used >= op.n && oIdx >= 0) {
            this.stack.splice(oIdx, 1);
            cIdx = this.stack.indexOf(closer);
          }
          if (closer.used >= closer.n && cIdx >= 0) {
            this.stack.splice(cIdx, 1);
            closer = cIdx > 0 ? this.stack[cIdx - 1] : null;
            continue;
          }
          continue; // closer still has delimiters: try to match it again
        }
        if (!isFinal && closer.open && cLeft >= 2) {
          closer.deferred = true;
        }
      }
      const ci = this.stack.indexOf(closer);
      closer = ci > 0 ? this.stack[ci - 1] : null;
    }
  }

  openBracket(isImage) {
    this.flush();
    // The delimiter stack's top when the '[' is pushed: emphasis inside the
    // link text may only match openers above it, and unmatched delimiters
    // inside the link are dropped when the link forms.
    const base = this.stack.length ? this.stack[this.stack.length - 1] : null;
    if (isImage) {
      const bangTok = this.toks.length;
      this.toks.push({ k: 'text', s: '!' });
      const tok = this.toks.length;
      this.toks.push({ k: 'text', s: '[' });
      this.opens.push({ tok, bang: bangTok, img: true, floor: base, src: this.p + 2 });
      this.p += 2;
    } else {
      const tok = this.toks.length;
      this.toks.push({ k: 'text', s: '[' });
      this.opens.push({ tok, bang: -1, img: false, floor: base, src: this.p + 1 });
      this.p += 1;
    }
  }

  closeBracket() {
    this.flush();
    const open = this.opens.length ? this.opens[this.opens.length - 1] : null;
    if (!open) {
      this.buf += ']';
      this.p++;
      return;
    }
    // Resolve emphasis inside the link text first.
    this.resolve(open.floor, false);
    const nxt = this.p + 1;
    let url = null;
    let title = null;
    let end = nxt;
    let kind = null;
    if (this.s[nxt] === '(') {
      const res = this.linkDest(nxt);
      if (res) { url = res.dest; title = res.title; end = res.end; kind = 'inline'; }
    }
    if (url === null) {
      // A '[' after the ']' means a full or collapsed reference was
      // attempted. If it fails, the opener is dead: it does NOT fall back
      // to a shortcut reference (the '[label]' belongs to the attempt).
      const triedRef = this.s[nxt] === '[';
      if (this.s[nxt] === '[') {
        const lbl = this.readLabel(nxt);
        if (lbl) {
          // A collapsed reference (empty label) takes the link text as its
          // label, as raw source text: backslash escapes and emphasis
          // markers stay literal for matching (plainText would have
          // resolved the escapes and spent the delimiters).
          const name = lbl.label === '' ? this.s.slice(open.src, this.p) : lbl.label;
          // A label cannot contain an unescaped '[' (the plain-text label
          // of a collapsed reference is checked the same way).
          if (name.length <= 999 && !hasOpenBracket(name)) {
            const ref = this.refs.get(normLabel(name));
            if (ref) { url = ref.dest; title = ref.title; end = lbl.end; kind = lbl.label === '' ? 'collapsed' : 'full'; }
          }
        }
      }
      if (url === null && !triedRef) {
        const name = this.s.slice(open.src, this.p);
        if (name && name.length <= 999 && !hasOpenBracket(name)) {
          const ref = this.refs.get(normLabel(name));
          if (ref) { url = ref.dest; title = ref.title; end = nxt; kind = 'shortcut'; }
        }
      }
    }
    // A link's text cannot contain another link. (Images may contain one:
    // it only feeds their alt text.)
    if (url !== null && !open.img && this.hasLinkInside(open.tok + 1)) url = null;
    // C: an inline link or a full reference whose text holds an odd count
    // of bad code spans plus unclosed backtick runs is blocked in marked
    // (unless the last bad span ends at the end of the text). Collapsed and
    // shortcut references are exempt.
    if (url !== null && (kind === 'inline' || kind === 'full')) {
      if (linkBlocked(this.s.slice(open.src, this.p))) url = null;
    }
    if (url === null) {
      // Not a link: deactivate this opener, keep ']' as text.
      this.opens.pop();
      this.buf += ']';
      this.p++;
      return;
    }
    // A link whose text holds an unclosed '``' run suppresses emphasis
    // later in the paragraph when a code span follows (marked quirk).
    // Only INLINE links do this; a reference link ('[run
    // ``response`][tool-91]') leaves following emphasis alone.
    if (kind === 'inline' && this.hasOpenDouble(open.src, this.p)) this.afterBadLink = true;
    this.makeLink(open, url, title, end);
  }

  // Does the token range [from, end) already hold a bracket link? A link's
  // text cannot contain another link; images and autolinks inside a link are
  // fine.
  hasLinkInside(from) {
    for (let i = from; i < this.toks.length; i++) {
      if (this.toks[i].k === 'aOpen') return true;
    }
    return false;
  }

  makeLink(open, url, title, endPos) {
    const href = encHref(url);
    if (open.img) {
      const alt = this.plain(open.tok + 1, this.toks.length);
      this.toks[open.bang] = { k: 'img', src: href, title: title === null ? undefined : title, alt };
      this.toks.length = open.tok;
      const live = new Set(this.toks);
      this.stack = this.stack.filter((d) => live.has(d));
      this.opens = this.opens.filter((o) => o.tok < open.tok);
      this.p = endPos;
      return;
    }
    this.toks[open.tok] = { k: 'aOpen', href, title: title === null ? undefined : title };
    // An extended autolink inside the link text is flattened to plain
    // text once the outer link forms (a bracket autolink <...> keeps its
    // own <a>). If the link had failed, the autolink would have stayed.
    for (let k = open.tok + 1; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.k === 'auto' && t.ext) this.toks[k] = { k: 'text', s: t.txt };
    }
    this.toks.push({ k: 'aClose' });
    this.opens = this.opens.filter((o) => o.tok < open.tok);
    // Drop unmatched delimiters that lived inside the link text: they must
    // not match anything outside the link.
    const cut = open.floor ? this.stack.indexOf(open.floor) : -1;
    this.stack.length = cut + 1;
    this.p = endPos;
  }

  // Plain text of the tokens in [from, to): the text a link label or an image
  // alt is made of. Emphasis tags contribute nothing; leftover delimiter
  // characters stay as text.
  plain(from, to) {
    let out = '';
    for (let k = from; k < to; k++) {
      const t = this.toks[k];
      switch (t.k) {
        case 'text': out += t.s; break;
        case 'delim': {
          const left = t.n - t.used;
          if (left > 0) out += t.ch.repeat(left);
          break;
        }
        case 'code': out += t.s; break;
        case 'html': out += t.s; break;
        case 'img': out += t.alt; break;
        case 'auto': out += t.txt; break;
        case 'br': out += '\n'; break;
        default: break;
      }
    }
    return out;
  }

  readLabel(pos) {
    const src = this.s;
    let p = pos + 1;
    let name = '';
    while (p < this.len) {
      const c = src[p];
      if (c === '\\' && p + 1 < this.len) {
        name += c + src[p + 1];
        p += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') {
        if (name.length > 999) return null;
        return { label: name, end: p + 1 };
      }
      if (c === '\n') {
        if (src[p + 1] === '\n') return null;
        name += ' ';
        p++;
        continue;
      }
      name += c;
      p++;
    }
    return null;
  }

  skipWs(i) {
    let lines = 0;
    while (i < this.len) {
      const c = this.s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\n') {
        lines++;
        if (lines > 1) return -1;
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  linkDest(openParenPos) {
    const src = this.s;
    let i = this.skipWs(openParenPos + 1);
    if (i < 0) return null;
    if (src[i] === ')') return { dest: '', title: null, end: i + 1 };
    if (src[i] === '<') {
      let j = i + 1;
      while (j < this.len && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < this.len) { j += 2; continue; }
        if (src[j] === '>') {
          const fin = this.destTail(j + 1);
          if (fin) return { dest: unslash(src.slice(i + 1, j)), title: fin.title, end: fin.end };
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
      if (c === '\\' && j + 1 < this.len && isAsciiPunct(src[j + 1])) {
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
    const fin = this.destTail(j);
    if (!fin) return null;
    return { dest, title: fin.title, end: fin.end };
  }

  destTail(i) {
    let j = this.skipWs(i);
    if (j < 0) return null;
    let title = null;
    if (this.s[j] === '"' || this.s[j] === "'" || this.s[j] === '(') {
      const t = readTitle(this.s, j);
      if (!t) return null;
      title = t.title;
      j = this.skipWs(t.end);
      if (j < 0) return null;
    }
    if (this.s[j] !== ')') return null;
    return { title, end: j + 1 };
  }

  angle() {
    const start = this.p;
    const src = this.s;
    if (src.startsWith('<!--', start)) {
      // '<!-->' and '<!--->' are complete (empty) comments on their own;
      // a later '-->' is stray text, not the end of this comment.
      let stop = -1;
      let after = -1;
      if (src[start + 4] === '>') { stop = start + 4; after = start + 5; }
      else if (src[start + 4] === '-' && src[start + 5] === '>') { stop = start + 5; after = start + 6; }
      else { stop = src.indexOf('-->', start + 4); after = stop + 3; }
      if (stop >= 0) {
        this.flush();
        this.toks.push({ k: 'html', s: src.slice(start, after) });
        this.p = after;
        return;
      }
      this.buf += '<';
      this.p++;
      return;
    }
    if (src.startsWith('<?', start)) {
      const stop = src.indexOf('?>', start + 2);
      if (stop >= 0) {
        this.flush();
        this.toks.push({ k: 'html', s: src.slice(start, stop + 2) });
        this.p = stop + 2;
        return;
      }
      this.buf += '<';
      this.p++;
      return;
    }
    if (src.startsWith('<![CDATA[', start)) {
      const stop = src.indexOf(']]>', start + 9);
      if (stop >= 0) {
        this.flush();
        this.toks.push({ k: 'html', s: src.slice(start, stop + 3) });
        this.p = stop + 3;
        return;
      }
      this.buf += '<';
      this.p++;
      return;
    }
    if (/^<![A-Za-z]/.test(src.slice(start, start + 3))) {
      const stop = src.indexOf('>', start + 2);
      if (stop >= 0) {
        this.flush();
        this.toks.push({ k: 'html', s: src.slice(start, stop + 1) });
        this.p = stop + 1;
        return;
      }
      this.buf += '<';
      this.p++;
      return;
    }
    // Bracket autolink: <scheme:...> or <email> (no spaces, no newlines).
    const gt = src.indexOf('>', start + 1);
    if (gt >= 0) {
      const inner = src.slice(start + 1, gt);
      if (inner.length > 0 && inner.indexOf('\n') < 0 && inner.indexOf(' ') < 0 && inner.indexOf('<') < 0) {
        const match = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.+)$/.exec(inner);
        if (match) {
          this.flush();
          this.toks.push({ k: 'auto', href: encHref(inner), txt: inner });
          this.p = gt + 1;
          return;
        }
        if (emailOk(inner)) {
          this.flush();
          this.toks.push({ k: 'auto', href: 'mailto:' + inner, txt: inner });
          this.p = gt + 1;
          return;
        }
      }
    }
    const t = this.htmlTag(start);
    if (t) {
      this.flush();
      this.toks.push({ k: 'html', s: t.text });
      // Mode 8: an inline `<a ` tag (literal space after <a) opens the
      // in-link state; an inline `</a>` exactly closes it. The state
      // persists across blocks until cleared, and while set, bare-URL and
      // email extended autolinks are plain text.
      const lower = t.text.toLowerCase();
      if (lower.startsWith('<a ')) this.links.inLink = true;
      else if (lower === '</a>') this.links.inLink = false;
      this.p = t.end;
      return;
    }
    this.buf += '<';
    this.p++;
  }

  // Parse an inline HTML tag at pos. Returns {text, end} or null.
  htmlTag(pos) {
    const end = scanTag(this.s, pos, this.len);
    if (end < 0) return null;
    return { text: this.s.slice(pos, end), end };
  }

  email() {
    // The local part is the maximal run of email-local characters ending
    // just before the '@'. It can span the current text run and earlier
    // text/delimiter tokens: a '_' (or '*') inside the address was already
    // emitted as a delimiter, but it carries no emphasis role there, so it
    // belongs to the address, not to an emphasis run.
    let addr = '';
    let cut = 0;
    {
      let i = this.buf.length;
      while (i > 0 && isEmailCh(this.buf[i - 1]) && !this.bufEsc.has(i - 1)) { i--; cut++; }
      addr = this.buf.slice(this.buf.length - cut);
    }
    if (this.buf.length > 0 && cut === 0) return false;
    // The walk back through earlier tokens only runs when the whole buffer
    // was consumed into the local part: if the buffer walk stopped at a
    // space, the address starts inside the buffer and no earlier token
    // belongs to it ('x86_64 render@...' links 'render@...', not
    // 'x86_render@...').
    const walkBack = cut === this.buf.length;
    let gone = 0; // whole tokens (from the end) that are in the local part
    let partTok = -1; // a text token whose suffix is in the local part
    let partKeep = 0;
    const dropped = new Set();
    let t = walkBack ? this.toks.length - 1 : -1;
    while (t >= 0) {
      const tok = this.toks[t];
      if (tok.k === 'text') {
        let j = tok.s.length;
        let bit = '';
        while (j > 0 && isEmailCh(tok.s[j - 1]) && !(tok.esc && tok.esc.has(j - 1))) { bit = tok.s[j - 1] + bit; j--; }
        if (bit.length === 0) break;
        addr = bit + addr;
        if (j > 0) { partTok = t; partKeep = j; break; }
        dropped.add(tok);
        gone++;
        t--;
        continue;
      }
      if (tok.k === 'delim' && tok.ch === '_' && tok.n === 1 && tok.used === 0 && tok.oTags.length === 0 && tok.cTags.length === 0 && isEmailCh(tok.ch)) {
        // Only a single '_' delimiter belongs to the address: a '__'
        // strong delimiter is an emphasis opener, never an email
        // character ('__table@nimbus.example.com__' links
        // 'table@nimbus.example.com' inside the strong).
        addr = tok.ch.repeat(tok.n) + addr;
        dropped.add(tok);
        gone++;
        t--;
        continue;
      }
      break;
    }
    if (!addr) return false;
    let end = this.p + 1;
    while (end < this.len && isDomainCh(this.s[end])) end++;
    if (end === this.p + 1) return false;
    // A '_' immediately after the domain is part of the would-be address
    // (not a valid domain character), so the whole thing is not an email —
    // unless it is the first '_' of a '__' strong delimiter, or it closes
    // an open '_' emphasis span (there is an unmatched '_' opener on the
    // stack): '_warning when@atlas.example.com_' links the email inside
    // the emphasis.
    if (this.s[end] === '_') {
      let closes = this.s[end + 1] === '_';
      if (!closes) {
        for (const d of this.stack) {
          if (d.ch === '_' && d.open && d.used < d.n) { closes = true; break; }
        }
      }
      if (!closes) return false;
    }
    let dom = this.s.slice(this.p + 1, end);
    // A domain ending in '-' is not an email at all (no link). A trailing
    // '.' is trimmed and the link still forms. A trailing '_' is trimmed
    // ONLY when it closes an emphasis ('__foo because@mark.example.com__'
    // links 'because@mark.example.com' inside the strong); a '_' with no
    // opener to close is part of the would-be address and the whole thing
    // is not an email ('a.b-c_d@a.b_' does not link, gfm-632).
    if (dom.endsWith('-')) return false;
    {
      let trimmed = dom;
      while (trimmed.length && (trimmed[trimmed.length - 1] === '.' || trimmed[trimmed.length - 1] === '_')) trimmed = trimmed.slice(0, -1);
      if (trimmed.length < dom.length) {
        const cutAt = this.p + 1 + trimmed.length;
        if (this.s[cutAt] === '_') {
          let closes = this.s[cutAt + 1] === '_';
          if (!closes) {
            for (const d of this.stack) {
              if (d.ch === '_' && d.open && d.used < d.n) { closes = true; break; }
            }
          }
          if (!closes) return false;
        }
      }
      dom = trimmed;
    }
    if (!dom || !domainOk(dom, 2, MAIL_LABEL_RE)) return false;
    // Remove the local part from the buffer and the tokens (and from the
    // delimiter stack, so a swallowed delimiter is never matched).
    this.buf = this.buf.slice(0, this.buf.length - cut);
    if (cut) {
      const kept = new Set();
      for (const idx of this.bufEsc) if (idx < this.buf.length) kept.add(idx);
      this.bufEsc = kept;
    }
    if (partTok >= 0) {
      this.toks[partTok].s = this.toks[partTok].s.slice(0, partKeep);
      this.toks.length = partTok + 1;
    } else {
      this.toks.length = this.toks.length - gone;
    }
    if (dropped.size) this.stack = this.stack.filter((d) => !dropped.has(d));
    this.flush();
    const full = addr + '@' + dom;
    this.toks.push({ k: 'auto', ext: true, href: 'mailto:' + full, txt: full });
    this.p = this.p + 1 + dom.length;
    return true;
  }

  autolink() {
    const pos = this.p;
    const c = this.s[pos];
    if (c === 'w' && this.s.startsWith('www.', pos)) {
      const prev = pos > 0 ? this.s[pos - 1] : '';
      if (prev === '' || isSpace(prev) || prev === '(' || prev === '[' || prev === '*' || prev === '_' || prev === '~') {
        const res = this.www(pos);
        if (res) {
          this.flush();
          this.toks.push({ k: 'auto', ext: true, href: encHref('http://' + res.url), txt: res.url });
          this.p = res.end;
          return true;
        }
      }
      return false;
    }
    const prev = pos > 0 ? this.s[pos - 1] : '';
    if (prev !== '' && isSchemeCh(prev)) return false;
    const res = this.scheme(pos);
    if (res) {
      this.flush();
      this.toks.push({ k: 'auto', ext: true, href: encHref(res.url), txt: res.url });
      this.p = res.end;
      return true;
    }
    return false;
  }

  // Does the innermost open link's text contain a link that already formed?
  // When it does, a ']' inside the URL scan does not end the URL (the outer
  // link cannot form, so the autolink swallows the bracket); when it does
  // not, ']' ends the URL so the bracket can close the link.
  hasFormedLink() {
    if (!this.opens.length) return false;
    const link = this.opens[this.opens.length - 1];
    for (let i = link.tok + 1; i < this.toks.length; i++) {
      if (this.toks[i].k === 'aOpen') return true;
    }
    return false;
  }

  www(pos) {
    let j = pos + 4;
    while (j < this.len && isDomainCh(this.s[j])) j++;
    let k = j;
    while (k < this.len) {
      const c = this.s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c.charCodeAt(0) < 32) break;
      if (c === '&' && looksEntity(this.s, k)) break;
      // A ']' ends the URL only when the innermost open link's text holds
      // no formed link (so the bracket can close it).
      if (c === ']' && this.opens.length && !this.hasFormedLink()) break;
      k++;
    }
    if (k === pos + 4) return null;
    const url = trimLink(this.s.slice(pos, k));
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
    if (!domainOk(domain.slice(4), 1)) return null;
    return { url, end: pos + url.length };
  }

  scheme(pos) {
    // Fast reject: only http/https/ftp/mailto/xmpp are extended-autolink
    // schemes, so only these initials can start one. Look at the first
    // character before allocating a lowercased prefix slice.
    const first = this.s[pos];
    if (first !== 'h' && first !== 'H' && first !== 'f' && first !== 'F' && first !== 'm' && first !== 'M' && first !== 'x' && first !== 'X') return null;
    const head = this.s.slice(pos, pos + 7).toLowerCase();
    let n;
    if (head.startsWith('https:')) n = 5;
    else if (head.startsWith('mailto:')) n = 6;
    else if (head.startsWith('http:')) n = 4;
    else if (head.startsWith('xmpp:')) n = 4;
    else if (head.startsWith('ftp:')) n = 3;
    else return null;
    const colon = pos + n;
    const name = this.s.slice(pos, colon).toLowerCase();
    if (name !== 'http' && name !== 'https' && name !== 'ftp' && name !== 'mailto' && name !== 'xmpp') return null;
    if ((name === 'http' || name === 'https' || name === 'ftp') &&
        !(this.s[colon + 1] === '/' && this.s[colon + 2] === '/')) return null;
    let k = colon + 1;
    let j = k;
    while (j < this.len) {
      const c = this.s[j];
      // A backslash is not part of a scheme autolink's URL only when it is
      // the first character after the scheme's ':' (the URL would be just
      // the scheme: 'removes:\' + newline is a hard break, not a link).
      // Later in the URL a backslash is an ordinary character, so
      // 'http://sub.domain.example.io..\' autolinks with href '%5C'.
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || (c === '\\' && j === k) || c.charCodeAt(0) < 32) break;
      if (c === '&' && looksEntity(this.s, j)) break;
      // A ']' ends the URL only when the innermost open link's text holds
      // no formed link (so the bracket can close it).
      if (c === ']' && this.opens.length && !this.hasFormedLink()) break;
      j++;
    }
    if (j === k) return null;
    let url = trimLink(this.s.slice(pos, j));
    if (!url) return null;
    // The part after the scheme's ':' must survive trimming: otherwise the
    // "URL" is just the scheme itself ('**Warning:**' is emphasis, not a
    // link to 'Warning').
    if (url.length <= colon - pos + 1) return null;
    // mailto: and xmpp: carry an email address, not a generic URL path.
    // mailto: takes no path at all ('mailto:foo@bar.baz/txt' links only the
    // email); xmpp: takes one resource segment ('xmpp:foo@bar.baz/txt' links
    // the email plus '/txt', but '/bin' after it is outside). The email's
    // domain may not end in '-' or '_' (then there is no link at all).
    // Validate against the RAW scanned text: trimLink would already
    // have stripped a trailing '_' that invalidates the address.
    const scheme = this.s.slice(pos, colon).toLowerCase();
    if ((scheme === 'mailto' || scheme === 'xmpp') && url.indexOf('@', colon - pos + 1) >= 0) {
      const raw = this.s.slice(pos, j);
      const rel = colon - pos; // raw-relative index of ':'
      const at = raw.indexOf('@', rel + 1);
      const slash = raw.indexOf('/', at);
      const addr = slash < 0 ? raw.slice(rel + 1) : raw.slice(rel + 1, slash);
      const atPos = addr.indexOf('@');
      if (atPos <= 0) return null;
      const local = addr.slice(0, atPos);
      let domain = addr.slice(atPos + 1);
      for (let m = 0; m < local.length; m++) {
        if (!isEmailCh(local[m])) return null;
      }
      if (domain.endsWith('-')) return null;
      {
        let trimmed = domain;
        while (trimmed.length && (trimmed[trimmed.length - 1] === '.' || trimmed[trimmed.length - 1] === '_')) trimmed = trimmed.slice(0, -1);
        if (trimmed.length < domain.length) {
          // A trailing '_' is trimmed only when it closes an emphasis
          // (same rule as email, gfm-632/633).
          const dom0 = pos + rel + 1 + atPos + 1;
          const cutAt = dom0 + trimmed.length;
          if (this.s[cutAt] === '_') {
            let closesEm = this.s[cutAt + 1] === '_';
            if (!closesEm) {
              for (const d of this.stack) {
                if (d.ch === '_' && d.open && d.used < d.n) { closesEm = true; break; }
              }
            }
            if (!closesEm) return null;
          }
        }
        domain = trimmed;
      }
      if (!domain || !domainOk(domain, 2, MAIL_LABEL_RE)) return null;
      if (scheme === 'mailto') {
        url = url.slice(0, colon - pos + 1) + local + '@' + domain;
      } else if (slash >= 0) {
        const segStop = raw.indexOf('/', slash + 1);
        const seg = segStop < 0 ? raw.slice(slash) : raw.slice(slash, segStop);
        url = url.slice(0, colon - pos + 1) + local + '@' + domain + seg;
      } else {
        url = url.slice(0, colon - pos + 1) + local + '@' + domain;
      }
    }
    return { url, end: pos + url.length };
  }

  render() {
    let out = '';
    for (const tok of this.toks) {
      switch (tok.k) {
        case 'text': out += escText(tok.s); break;
        case 'delim': {
          const rem = tok.n - tok.used;
          if (tok.leftIn) {
            // R: the leftover delimiter renders inside the emphasis.
            if (rem > 0) out += tok.ch.repeat(rem);
            for (const tag of tok.cTags) out += tag;
          } else {
            for (const tag of tok.cTags) out += tag;
            if (rem > 0) out += tok.ch.repeat(rem);
          }
          for (const tag of tok.oTags) out += tag;
          break;
        }
        case 'br': out += '<br>'; break;
        case 'code': out += '<code>' + escCode(tok.s) + '</code>'; break;
        case 'html': out += tok.s; break;
        case 'aOpen': {
          out += '<a href="' + escAttr(tok.href) + '"';
          if (tok.title !== undefined) out += ' title="' + escAttr(tok.title) + '"';
          out += '>';
          break;
        }
        case 'aClose': out += '</a>'; break;
        case 'auto': out += '<a href="' + escAttr(tok.href) + '">' + escText(tok.txt) + '</a>'; break;
        case 'img': {
          out += '<img src="' + escAttr(tok.src) + '" alt="' + escAttr(tok.alt) + '"';
          if (tok.title !== undefined) out += ' title="' + escAttr(tok.title) + '"';
          out += '>';
          break;
        }
      }
    }
    return out;
  }
}

function inline(src, refs, links) {
  return new InlineParser(src, refs, links).run();
}

// ---------- block rendering ----------

function renderDoc(root, refs, links) {
  let out = '';
  for (const child of root.kids) out += renderBlock(child, refs, links);
  return out;
}

function renderBlock(blk, refs, links) {
  switch (blk.k) {
    case 'p':
      return '<p>' + inline(blk.txt, refs, links) + '</p>\n';
    case 'h':
      return '<h' + blk.lvl + '>' + inline(blk.txt, refs, links) + '</h' + blk.lvl + '>\n';
    case 'code': {
      let s = '<pre><code';
      if (blk.info) s += ' class="language-' + escText(blk.info) + '"';
      s += '>' + escCode(blk.txt) + '</code></pre>\n';
      return s;
    }
    case 'html':
      return blk.txt;
    case 'hr':
      return '<hr>\n';
    case 'quote': {
      let inner = '';
      for (const child of blk.kids) inner += renderBlock(child, refs, links);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      const tag = blk.ord ? 'ol' : 'ul';
      let s = '<' + tag;
      if (blk.ord && blk.start !== 1) s += ' start="' + blk.start + '"';
      s += '>\n';
      for (const item of blk.kids) s += renderLi(item, refs, blk.loose, links);
      s += '</' + tag + '>\n';
      return s;
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < blk.head.length; i++) {
        s += '<th';
        const a = blk.align[i];
        if (a) s += ' align="' + a + '"';
        s += '>' + inline(blk.head[i], refs, links) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (blk.rows.length) {
        s += '<tbody>';
        for (const row of blk.rows) {
          s += '<tr>\n';
          for (let i = 0; i < blk.head.length; i++) {
            const cell = i < row.length ? row[i] : '';
            s += '<td';
            const a = blk.align[i];
            if (a) s += ' align="' + a + '"';
            s += '>' + inline(cell, refs, links) + '</td>\n';
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

function renderLi(item, refs, loose, links) {
  let s = '<li>';
  const checkbox = item.task
    ? (item.task === 'checked'
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ')
    : '';
  const first = item.kids[0];
  if (checkbox && loose && first && first.k === 'p') {
    // A loose task item's checkbox lives inside its first paragraph.
    s += '<p>' + checkbox + inline(first.txt, refs, links) + '</p>\n';
    for (let i = 1; i < item.kids.length; i++) s += renderBlock(item.kids[i], refs, links);
  } else {
    if (checkbox) s += checkbox;
    for (const child of item.kids) {
      if (!loose && child.k === 'p') s += inline(child.txt, refs, links);
      else s += renderBlock(child, refs, links);
    }
  }
  s += '</li>\n';
  return s;
}

// F4: marked strips trailing spaces/tabs from the last paragraph of the
// LAST item of each list, recursing through nested lists and blockquotes.
// Top-level paragraphs and blockquote paragraphs keep theirs. This runs
// once over the finished block tree, before rendering.
function stripTrailing(node) {
  if (node.k === 'list' && node.kids.length) {
    let cur = node.kids[node.kids.length - 1];
    while (cur) {
      if (cur.k === 'p') {
        cur.txt = cur.txt.replace(/[ \t]+$/, '');
        break;
      }
      const kids = cur.kids;
      if (kids && kids.length) cur = kids[kids.length - 1];
      else break;
    }
  }
  if (node.kids) {
    for (const child of node.kids) stripTrailing(child);
  }
}

// ---------- entry point ----------

export function parse(markdown) {
  const builder = new BlockBuilder(markdown);
  const { root, refs } = builder.build();
  stripTrailing(root);
  const links = { inLink: false };
  return renderDoc(root, refs, links);
}
