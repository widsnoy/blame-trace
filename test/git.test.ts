import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blameLine, locateRepository, parseBlame, runGit } from '../src/git';

test('parse Git porcelain output for committed and uncommitted lines', () => {
  const committed = parseBlame([
    'a'.repeat(40) + ' 7 12 1',
    'author 张三',
    'author-time 1730000000',
    'summary 修复问题',
    'filename file.ts',
    '\tconst a = 1;'
  ].join('\n'));
  assert.deepEqual(committed, {
    kind: 'committed', sha: 'a'.repeat(40), sourceLine: 7,
    author: '张三', authorTime: 1730000000, summary: '修复问题'
  });
  assert.deepEqual(parseBlame('0'.repeat(64) + ' 1 1 1\n\tnew line'), { kind: 'uncommitted' });
});

test('blame tracks existing lines across unsaved edits', async () => {
  const tempBase = path.resolve(os.tmpdir());
  const repoRoot = await mkdtemp(path.join(tempBase, 'blame-trace-test-'));
  const file = path.join(repoRoot, '含 空格.ts');
  try {
    await runGit(repoRoot, ['init', '-q']);
    await runGit(repoRoot, ['config', 'user.name', 'Test Author']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(file, 'first\nsecond\nthird\n', 'utf8');
    await runGit(repoRoot, ['add', '--', '含 空格.ts']);
    await runGit(repoRoot, ['commit', '-qm', 'Initial version']);

    const repo = await locateRepository(file);
    assert.ok(repo);
    const base = await blameLine(repo, file, 2, 'first\nsecond\nthird\n');
    assert.equal(base.kind, 'committed');
    if (base.kind === 'committed') {
      assert.equal(base.author, 'Test Author');
      assert.equal(base.summary, 'Initial version');
      assert.equal(base.sourceLine, 2);
    }

    const inserted = 'new line\nfirst\nsecond\nthird\n';
    assert.deepEqual(await blameLine(repo, file, 1, inserted), { kind: 'uncommitted' });
    const shifted = await blameLine(repo, file, 3, inserted);
    assert.equal(shifted.kind, 'committed');
    if (shifted.kind === 'committed') assert.equal(shifted.sourceLine, 2);

    assert.deepEqual(await blameLine(repo, file, 2, 'first\nchanged\nthird\n'), { kind: 'uncommitted' });
  } finally {
    if (!path.resolve(repoRoot).startsWith(`${tempBase}${path.sep}`)) throw new Error('Unsafe test cleanup path');
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SHA-256 repositories return a 64-character commit ID', async () => {
  const tempBase = path.resolve(os.tmpdir());
  const repoRoot = await mkdtemp(path.join(tempBase, 'blame-trace-sha256-'));
  const file = path.join(repoRoot, 'file.txt');
  try {
    await runGit(repoRoot, ['init', '-q', '--object-format=sha256']);
    await runGit(repoRoot, ['config', 'user.name', 'Test Author']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(file, 'line\n', 'utf8');
    await runGit(repoRoot, ['add', '--', 'file.txt']);
    await runGit(repoRoot, ['commit', '-qm', 'SHA-256 commit']);
    const repo = await locateRepository(file);
    assert.ok(repo);
    const result = await blameLine(repo, file, 1, 'line\n');
    assert.equal(result.kind, 'committed');
    if (result.kind === 'committed') assert.equal(result.sha.length, 64);
  } finally {
    if (!path.resolve(repoRoot).startsWith(`${tempBase}${path.sep}`)) throw new Error('Unsafe test cleanup path');
    await rm(repoRoot, { recursive: true, force: true });
  }
});
