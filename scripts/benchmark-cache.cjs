const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const { DocumentBlameCache } = require('../out/src/documentCache');
const { blameLine, locateRepository } = require('../out/src/git');

async function main() {
  const file = path.resolve(process.argv[2]);
  const contents = fs.readFileSync(file, 'utf8');
  const repo = await locateRepository(file);
  if (!repo) throw new Error('No Git repository found');
  const lineCount = contents.trimEnd().split(/\r?\n/).length;
  const lines = Array.from({ length: 10 }, (_, index) => Math.max(1, Math.floor((index + 1) * lineCount / 11)));
  const cache = new DocumentBlameCache();
  try {
    let start = performance.now();
    const rows = await cache.load(repo, file, 1, contents);
    const firstWholeMs = performance.now() - start;
    if (!rows) throw new Error('Whole file blame unavailable');
    start = performance.now();
    for (const line of lines) cache.get(repo, file, 1, contents)[line - 1];
    const tenCachedMs = performance.now() - start;
    start = performance.now();
    for (const line of lines) await blameLine(repo, file, line, contents);
    const tenSingleMs = performance.now() - start;
    console.log(JSON.stringify({ file, lineCount, firstWholeMs, tenCachedMs, tenSingleMs }, null, 2));
  } finally {
    cache.dispose();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
