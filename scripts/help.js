#!/usr/bin/env node
// Prints an annotated list of the npm commands (`npm run help`).
// Descriptions live in package.json under "scriptsHelp" — keep them in
// sync when adding/removing scripts. (Bare `npm run` only shows the raw
// commands; npm has no built-in per-script descriptions.)

const { scripts, scriptsHelp } = require('../package.json');

const width = Math.max(...Object.keys(scriptsHelp).map((k) => k.length));
console.log('\nnpm run <command>\n');
for (const [name, desc] of Object.entries(scriptsHelp)) {
  console.log(`  ${name.padEnd(width)}  ${desc}`);
}

// Flag drift between scripts and their descriptions.
const described = new Set(Object.keys(scriptsHelp).flatMap((k) => k.split(' | ')));
const undocumented = Object.keys(scripts).filter((k) => !described.has(k));
if (undocumented.length) {
  console.log(`\n  (no description yet: ${undocumented.join(', ')} — add to scriptsHelp in package.json)`);
}
console.log();
