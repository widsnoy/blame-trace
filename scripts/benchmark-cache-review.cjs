// Compile first. Usage: node scripts/benchmark-cache-review.cjs <OI-wiki-repo> [baseline-module-dir] [rounds]
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
let processes = 0, hashes = 0;
const spawn = cp.spawn, createHash = crypto.createHash;
cp.spawn = (...args) => { processes++; return spawn(...args); };
crypto.createHash = (...args) => { hashes++; return createHash(...args); };
const { blameLine, locateRepository } = require('../out/src/git');

async function measure(action) {
  const p = processes, h = hashes, start = performance.now();
  await action();
  return { ms: performance.now() - start, processes: processes - p, hashes: hashes - h };
}

async function sample(Cache, repo, file, contents, verify) {
  const cache = new Cache();
  const edited = `benchmark unsaved insertion\n${contents}`;
  const lineCount = contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
  const lines = [...new Set([1, Math.max(1, Math.floor(lineCount / 2)), lineCount])];
  const metrics = {};
  try {
    let rows;
    metrics.cold = await measure(async () => { rows = await cache.load(repo, file, 1, contents); });
    assert.ok(rows);
    if (verify) for (const line of lines) assert.deepEqual(rows[line - 1], await blameLine(repo, file, line, contents));
    metrics.hits10000 = await measure(() => {
      for (let i = 0; i < 10000; i++) assert.equal(cache.get(repo, file, 1, contents), rows);
    });
    cache.noteChange(file);
    metrics.edit = await measure(async () => { rows = await cache.load(repo, file, 2, edited); });
    assert.ok(rows);
    if (verify) for (const line of [1, ...lines.map(n => n + 1)]) assert.deepEqual(rows[line - 1], await blameLine(repo, file, line, edited));
    cache.noteChange(file);
    const missing = `another edit\n${edited}`;
    metrics.misses1000 = await measure(() => {
      for (let i = 0; i < 1000; i++) assert.equal(cache.get(repo, file, 3, missing), undefined);
    });
    cache.noteChange(file);
    metrics.undoRedo = await measure(() => {
      assert.ok(cache.get(repo, file, 4, contents));
      cache.noteChange(file);
      assert.equal(cache.get(repo, file, 5, edited), rows);
    });
    cache.noteChange(file);
    metrics.coalesced10 = await measure(async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => cache.load(repo, file, 6, missing)));
      assert.ok(results[0]);
      assert.ok(results.every(result => result === results[0]));
    });
    return metrics;
  } finally { cache.dispose(); }
}

async function main() {
  if (!process.argv[2]) throw new Error('Expected OI-wiki repository path');
  const target = path.resolve(process.argv[2]);
  const files = ['docs/lang/index.md', 'docs/graph/mdst.md', 'docs/math/number-theory/basic.md', 'docs/math/number-theory/continued-fraction.md'].map(file => path.join(target, file));
  const variants = { current: require('../out/src/documentCache').DocumentBlameCache };
  if (process.argv[3]) variants.baseline = require(path.join(path.resolve(process.argv[3]), 'documentCache.js')).DocumentBlameCache;
  const rounds = Number(process.argv[4] ?? 5);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive integer');
  const report = { node: process.version, git: cp.execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), rounds, warmups: 1, files: [] };
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    const repo = await locateRepository(file);
    if (!repo) throw new Error(`No repository: ${file}`);
    const result = { file: path.relative(repo.root, file), head: repo.head, bytes: Buffer.byteLength(contents), contentHash: createHash('sha256').update(contents).digest('hex'), variants: {} };
    for (const [name, Cache] of Object.entries(variants)) {
      await sample(Cache, repo, file, contents, true);
      result.variants[name] = { samples: [], summary: {} };
    }
    for (let round = 0; round < rounds; round++) {
      const entries = Object.entries(variants);
      if (round % 2) entries.reverse();
      for (const [name, Cache] of entries) result.variants[name].samples.push(await sample(Cache, repo, file, contents, false));
    }
    for (const variant of Object.values(result.variants)) {
      for (const scenario of Object.keys(variant.samples[0])) {
        const times = variant.samples.map(s => s[scenario].ms).sort((a, b) => a - b);
        variant.summary[scenario] = {
          medianMs: times[Math.floor(times.length / 2)], minMs: times[0], maxMs: times.at(-1),
          processes: variant.samples.map(s => s[scenario].processes), hashes: variant.samples.map(s => s[scenario].hashes)
        };
      }
    }
    report.files.push(result);
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
