// npm.cmd run compile; node scripts/test-unsaved-oiwiki.cjs ../OI-wiki
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DocumentBlameCache } = require('../out/src/documentCache');
const { blameDocument, locateRepository, parseBlame, runGit } = require('../out/src/git');

async function main() {
  assert.ok(process.argv[2], 'Expected OI-wiki repository path');
  const root = path.resolve(process.argv[2]);
  const report = { files: [] };
  for (const relative of ['docs/lang/index.md', 'docs/graph/mdst.md', 'docs/math/number-theory/basic.md', 'docs/math/number-theory/continued-fraction.md']) {
    const file = path.join(root, relative);
    const originalBytes = fs.readFileSync(file);
    const original = originalBytes.toString('utf8');
    const repo = await locateRepository(file);
    assert.ok(repo, 'Repository must be readable');
    const parts = original.split('\n');
    const middle = Math.floor((parts.length - 1) / 2);
    const replacement = [...parts];
    replacement[middle] = 'UNSAVED TEST: replace this line without writing to disk';
    const deletion = [...parts];
    deletion.splice(middle, 1);
    const multi = [...replacement];
    multi.splice(1, 0, 'UNSAVED TEST: another insertion');
    const inserted = `UNSAVED TEST: inserted first line\n${original}`;
    const scenarios = [
      { name: 'original', contents: original },
      { name: 'insert', contents: inserted, dirty: [0] },
      { name: 'undo', contents: original, hit: true },
      { name: 'redo', contents: inserted, hit: true, dirty: [0] },
      { name: 'replace-middle', contents: replacement.join('\n'), dirty: [middle] },
      { name: 'delete-middle', contents: deletion.join('\n') },
      { name: 'multiple-edits', contents: multi.join('\n'), dirty: [1, middle + 1] }
    ];
    let builds = 0;
    const cache = new DocumentBlameCache({ blame: (...args) => { builds++; return blameDocument(...args); } });
    const result = { file: relative, head: repo.head, diskSha256: createHash('sha256').update(originalBytes).digest('hex'), scenarios: [] };
    let version = 0;
    try {
      for (const scenario of scenarios) {
        version++;
        cache.noteChange(file);
        const before = builds;
        const start = performance.now();
        const cached = cache.get(repo, file, version, scenario.contents);
        if (scenario.hit) assert.ok(cached, `${relative}: ${scenario.name} should reuse snapshot`);
        const rows = cached ?? await cache.load(repo, file, version, scenario.contents);
        const cacheMs = performance.now() - start;
        assert.ok(rows);
        for (const index of scenario.dirty ?? []) assert.equal(rows[index].kind, 'uncommitted');
        // Independent porcelain parser checks every line, including shifted lines.
        const porcelain = await runGit(repo.root, [
          'blame', '--line-porcelain', '--encoding=UTF-8', '--contents', '-', repo.head, '--', relative
        ], { input: scenario.contents, maxBytes: 8 * 1024 * 1024 });
        const blocks = porcelain.split(/(?=^[0-9a-f]{40,64} \d+ \d+(?: \d+)?\r?$)/m).filter(Boolean);
        const expected = blocks.map(parseBlame);
        assert.ok(expected.length > 0);
        assert.ok(expected.every(row => row.kind !== 'unavailable'));
        assert.deepEqual(rows, expected, `${relative}: ${scenario.name}`);
        assert.equal(cache.get(repo, file, version, scenario.contents), rows);
        assert.deepEqual(fs.readFileSync(file), originalBytes, 'Disk contents must remain unchanged');
        result.scenarios.push({ name: scenario.name, linesChecked: rows.length, cacheMs, builds: builds - before, cacheHit: Boolean(cached) });
      }
      result.diskUnchanged = true;
      report.files.push(result);
    } finally { cache.dispose(); }
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
