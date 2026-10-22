import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocumentBlameCache } from '../src/documentCache';
import { blameDocument, blameLine, locateRepository, parseIncrementalBlame, runGit, type Attribution } from '../src/git';

const fakeRepo = { root: 'repo', head: 'a'.repeat(40) };
const fakeRows: readonly Attribution[] = [{ kind: 'uncommitted' }];

test('version hits avoid reading text; misses fingerprint once; close checks reused versions', async () => {
  const cache = new DocumentBlameCache({ blame: async () => fakeRows });
  await cache.load(fakeRepo, 'file', 1, 'one');
  let reads = 0;
  assert.equal(cache.get(fakeRepo, 'file', 1, () => { reads++; return 'one'; }), fakeRows);
  assert.equal(reads, 0);
  cache.noteChange('file');
  for (let i = 0; i < 20; i++) {
    assert.equal(cache.get(fakeRepo, 'file', 2, () => { reads++; return 'two'; }), undefined);
  }
  assert.equal(reads, 1);
  cache.noteChange('file');
  assert.equal(cache.get(fakeRepo, 'file', 1, 'changed after reopen'), undefined);
  cache.noteChange('file');
  assert.equal(cache.get(fakeRepo, 'file', 1, 'one'), fakeRows);
  cache.dispose();
});

test('transient failures are coalesced for one second and then retried', async () => {
  let now = 0;
  let calls = 0;
  const cache = new DocumentBlameCache({
    now: () => now,
    blame: async () => ++calls === 1 ? undefined : fakeRows
  });
  assert.equal(await cache.load(fakeRepo, 'file', 1, 'one'), undefined);
  now = 999;
  assert.equal(await cache.load(fakeRepo, 'file', 1, 'one'), undefined);
  assert.equal(calls, 1);
  now = 1000;
  assert.equal(await cache.load(fakeRepo, 'file', 1, 'one'), fakeRows);
  assert.equal(calls, 2);
  cache.dispose();
});

for (const invalidation of ['edit', 'head', 'dispose', 'evict', 'replace'] as const) {
  test(`all coalesced callers discard late results after ${invalidation}`, async () => {
    let resolve!: (rows: readonly Attribution[]) => void;
    let calls = 0;
    let signal: AbortSignal | undefined;
    const cache = new DocumentBlameCache({ blame: async (_repo, file, _contents, abort) => {
      calls++;
      if (file !== 'file' || calls > 1) return fakeRows;
      signal = abort;
      return new Promise(done => { resolve = done; });
    } });
    const first = cache.load(fakeRepo, 'file', 1, 'one');
    const second = cache.load(fakeRepo, 'file', 1, 'one');
    assert.equal(calls, 1);
    if (invalidation === 'edit') cache.noteChange('file');
    if (invalidation === 'head') cache.invalidateRepository(fakeRepo.root);
    if (invalidation === 'dispose') cache.dispose();
    if (invalidation === 'evict') {
      for (let i = 0; i < 8; i++) await cache.load(fakeRepo, `other${i}`, 1, 'other');
    }
    if (invalidation === 'replace') await cache.load(fakeRepo, 'file', 2, 'two');
    assert.equal(signal?.aborted, true);
    resolve(fakeRows);
    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    assert.equal(cache.get(fakeRepo, 'file', 1, 'one'), undefined);
    cache.dispose();
  });
}

test('successful coalesced requests publish one snapshot and HEAD keys stay isolated', async () => {
  let calls = 0;
  const cache = new DocumentBlameCache({ blame: async () => { calls++; return fakeRows; } });
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.load(fakeRepo, 'file', 1, 'one')));
  assert.equal(calls, 1);
  assert.ok(results.every(rows => rows === fakeRows));
  assert.equal(cache.get({ ...fakeRepo, head: 'b'.repeat(40) }, 'file', 1, 'one'), undefined);
  cache.dispose();
});

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
