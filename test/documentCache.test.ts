import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocumentBlameCache } from '../src/documentCache';
import { blameDocument, blameLine, locateRepository, parseIncrementalBlame, runGit, type Attribution } from '../src/git';

test('incremental parser handles out of order hunks and reused metadata', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const rows = parseIncrementalBlame([
    `${sha} 8 3 1`, 'author Alice', 'author-time 42', 'summary first', 'filename file.txt',
    `${other} 1 1 1`, 'author Bob', 'author-time 7', 'summary second', 'filename file.txt',
    `${sha} 4 2 1`, 'filename file.txt',
    `${'0'.repeat(64)} 1 4 1`, 'filename file.txt'
  ].join('\n'));
  assert.deepEqual(rows, [
    { kind: 'committed', sha: other, sourceLine: 1, author: 'Bob', authorTime: 7, summary: 'second' },
    { kind: 'committed', sha, sourceLine: 4, author: 'Alice', authorTime: 42, summary: 'first' },
    { kind: 'committed', sha, sourceLine: 8, author: 'Alice', authorTime: 42, summary: 'first' },
    { kind: 'uncommitted' }
  ]);
});

test('whole document agrees with single line blame across unsaved edits and undo', async () => {
  const tempBase = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempBase, 'blame-trace-cache-'));
  const file = path.join(root, 'file.txt');
  const other = path.join(root, 'other.txt');
  const cache = new DocumentBlameCache();
  try {
    await runGit(root, ['init', '-q']);
    await runGit(root, ['config', 'user.name', 'Test Author']);
    await runGit(root, ['config', 'user.email', 'test@example.com']);
    await writeFile(file, 'same\nsecond\nsame\nlast\n');
    await writeFile(other, 'other\n');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '-qm', 'Initial']);
    const repo = await locateRepository(file);
    assert.ok(repo);
    const otherRows = await cache.load(repo, other, 1, 'other\n');
    assert.ok(otherRows);
    const original = 'same\nsecond\nsame\nlast\n';
    const base = await cache.load(repo, file, 1, original);
    assert.ok(base);
    assert.equal(cache.get(repo, file, 1, original), base);
    for (const [version, contents] of [
      [2, 'new\nsame\nsecond\nsame\nlast\n'],
      [3, original],
      [4, 'same\nchanged\nsame\nlast\n'],
      [5, 'same\nsame\nlast\n']
    ] as const) {
      cache.noteChange(file);
      assert.equal(cache.get(repo, other, 1, 'other\n'), otherRows);
      const rows: readonly Attribution[] | undefined = version === 3
        ? cache.get(repo, file, version, contents) : await cache.load(repo, file, version, contents);
      assert.ok(rows);
      const lineCount = contents.trimEnd().split('\n').length;
      for (let line = 1; line <= lineCount; line++) {
        assert.deepEqual(rows[line - 1], await blameLine(repo, file, line, contents));
      }
    }
    assert.deepEqual(await blameDocument(repo, file, original), base);
  } finally {
    cache.dispose();
    if (!path.resolve(root).startsWith(`${tempBase}${path.sep}`)) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
