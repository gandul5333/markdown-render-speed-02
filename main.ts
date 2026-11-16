// Driver for the markdown-render-speed-02 entry.
//
// The grader executes `node /bot/main.ts` with Node 22. It takes the case
// list from cases.json in the input directory (an array of { id, markdown }
// objects), renders each markdown string on its own through parse() from
// ./parse.js, and writes the resulting HTML strings — one per case, in
// input order — as a JSON array to html.json in the output directory.
//
// The input and output directories default to /input and /output. Outside
// the grading container they can be redirected with MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR, which is how the practice set is checked locally.
// Nothing else is consulted: no clock, no network, no other files, so the
// output is a pure function of the cases given.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as Case[];

// One output slot per case, filled in order so the result lines up
// exactly with the input list.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
