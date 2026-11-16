// Grading driver for the markdown-render-speed-02 entry.
//
// The grader runs `node /bot/main.ts` under Node 22. It reads the case
// list from cases.json in the input directory (a JSON array of objects
// shaped { id, markdown }), renders every markdown string on its own
// through parse() from ./parse.js, and writes the HTML strings — one per
// case, in the same order — as a JSON array to html.json in the output
// directory.
//
// The input/output directories default to /input and /output; outside the
// grading container they can be pointed elsewhere with the
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR environment variables, which
// is how the practice set is checked locally. No other environment, file,
// or clock is consulted: the output depends only on the cases given.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface CaseInput {
  id: string;
  markdown: string;
}

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const caseList = JSON.parse(raw) as CaseInput[];

// One output slot per case, filled in order so the result lines up
// exactly with the input list.
const htmlOut: string[] = new Array(caseList.length);
for (let k = 0; k < caseList.length; k++) {
  htmlOut[k] = parse(caseList[k].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(htmlOut));
