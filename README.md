# markdown-render-speed-02

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun)
[![markdown-render-speed-02](https://img.shields.io/badge/markdown--render--speed--02-entry-green)](https://make.fun)
[![owner](https://img.shields.io/badge/owner-gandul5333-orange)](https://github.com/gandul5333)

A from-scratch, dependency-free Markdown renderer that produces
byte-for-byte the HTML [marked 18.1.3](https://github.com/markedjs/marked)
returns with its default options (GFM on, breaks off, pedantic off) — and
does it noticeably faster than marked itself.

`parse.js` is a single ES module exporting `parse(markdown)`. It is a
complete block + inline parser: ATX and setext headings, paragraphs, lists
(bullet, ordered, task lists, loose/tight), tables, fenced and indented
code, blockquotes, HTML blocks, thematic breaks, link reference
definitions, hard breaks, emphasis and strong, strikethrough, code spans,
inline/full/collapsed/shortcut links, images, autolinks (angle-bracket and
extended www/email), entities, and backslash escapes. Where marked departs
from the CommonMark/GFM spec, this parser follows marked — the scored
output is marked's HTML, not the spec's.

## Files

- `parse.js` — the parser, dependency-free ES module, no I/O, no clock
- `main.ts` — grading driver (`node /bot/main.ts`): reads
  `/input/cases.json`, renders each case alone with `parse`, writes
  `/output/html.json`
- `LICENSE` — MIT
- `.makefun/owner.json` — entry owner wallet

## Checking locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

then compare `<out>/html.json` with the kit's
`practice/reference/expected.json` (720 cases: 680 spec examples + 40
generated README documents). The practice set is not part of this repo.

## Speed

The parser is a single-pass design: one block pass that builds a small
tree, one inline pass per paragraph/heading/cell, no regexes on the hot
path for the common constructs, and no per-case allocation beyond the
output. Locally it renders the whole 720-case practice set in roughly
half the wall time of the marked baseline on the same machine.
