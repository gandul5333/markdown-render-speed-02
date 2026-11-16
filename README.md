# markdown-render-speed-02

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun)
[![markdown-render-speed-02](https://img.shields.io/badge/markdown--render--speed--02-entry-green)](https://make.fun)
[![owner](https://img.shields.io/badge/owner-gandul5333-orange)](https://github.com/gandul5333)

A dependency-free Markdown renderer written from scratch. It produces
exactly the HTML that [marked 18.1.3](https://github.com/markedjs/marked)
returns with its default options (GFM on, breaks off, pedantic off, async
off) — byte for byte, including the places where marked departs from the
CommonMark / GFM spec — and it renders the whole set noticeably faster
than marked itself.

`parse.js` is one ES module exporting `parse(markdown)`: a complete block
parser (ATX and setext headings, paragraphs, bullet / ordered / task
lists, loose and tight, tables, fenced and indented code, blockquotes,
HTML blocks, thematic breaks, link reference definitions) plus an inline
scanner (emphasis and strong, strikethrough, code spans, inline / full /
collapsed / shortcut links, images, angle-bracket and extended autolinks,
entities, backslash escapes, hard breaks).

## Files

- `parse.js` — the parser: one ES module, no dependencies, no I/O, no
  clock, no caching across calls
- `main.ts` — the grading driver: `node /bot/main.ts` reads
  `/input/cases.json`, renders each case alone with `parse`, writes
  `/output/html.json`
- `LICENSE` — MIT
- `.makefun/owner.json` — entry owner wallet

## Checking locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

then compare `<out>/html.json` against the kit's
`practice/reference/expected.json` (720 cases: 680 spec examples and 40
generated README documents). The practice set is not part of this repo.

## Speed

Single-pass design: one block pass builds a small tree, one inline pass
runs per paragraph, heading, and table cell, with no regexes on the hot
path for the common constructs and no allocation beyond the output apart
from the tree itself. Locally the parse step runs in about half the time
of the marked baseline on the same machine.
