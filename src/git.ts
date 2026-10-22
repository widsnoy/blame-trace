import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CancellationToken } from 'vscode';

export type Attribution =
  | { kind: 'committed'; sha: string; sourceLine: number; sourcePath?: string; author: string; authorTime: number; summary: string }
  | { kind: 'uncommitted' }
  | { kind: 'unavailable'; reason: string };

export interface Repository {
  root: string;
  head: string;
}

export class GitError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
  }
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: { input?: string; token?: CancellationToken; signal?: AbortSignal; maxBytes?: number } = {}
): Promise<string> {
  if (options.token?.isCancellationRequested || options.signal?.aborted) throw new GitError('Cancelled');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    let bytes = 0;
    let errorBytes = 0;
    let settled = false;
    let cancellation: { dispose(): void } | undefined;
    const abort = () => { child.kill(); finish(new GitError('Cancelled')); };
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    cancellation = options.token?.onCancellationRequested(abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        finish(new GitError('Git output exceeded the size limit'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorBytes < 16 * 1024) {
        stderr.push(chunk);
        errorBytes += chunk.length;
      }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish(undefined, Buffer.concat(stdout).toString('utf8'));
      else finish(new GitError(Buffer.concat(stderr).toString('utf8').trim() || `git exited with code ${code}`, code ?? undefined));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.stdin.end(options.input);
  });
}

export async function locateRepository(file: string, token?: CancellationToken): Promise<Repository | undefined> {
  const cwd = path.dirname(file);
  try {
    const output = await runGit(cwd, ['rev-parse', '--show-toplevel', '--verify', 'HEAD'], { token });
    const [root, head] = output.trimEnd().split(/\r?\n/);
    if (!root || !head) return undefined;
    return { root, head };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GitError('Git executable was not found in PATH');
    return undefined;
  }
}

export function parseBlame(output: string): Attribution {
  const lines = output.split(/\r?\n/);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/.exec(lines[0] ?? '');
  if (!match) return { kind: 'unavailable', reason: 'Invalid Git blame output' };
  if (/^0+$/.test(match[1])) return { kind: 'uncommitted' };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith('\t')) break;
    const separator = line.indexOf(' ');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    kind: 'committed',
    sha: match[1],
    sourceLine: Number(match[2]),
    sourcePath: fields.has('filename') ? decodeGitPath(fields.get('filename')!) : undefined,
    author: fields.get('author') || 'Unknown',
    authorTime: Number(fields.get('author-time') || 0),
    summary: fields.get('summary') || '(no summary)'
  };
}

export function parseIncrementalBlame(output: string): readonly Attribution[] {
  const metadata = new Map<string, Map<string, string>>();
  const hunks: { sha: string; source: number; result: number; count: number; sourcePath?: string }[] = [];
  const lines = output.split(/\r?\n/);
  let current: typeof hunks[number] | undefined;
  for (const line of lines) {
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+) (\d+)$/.exec(line);
    if (header) {
      current = { sha: header[1], source: Number(header[2]), result: Number(header[3]), count: Number(header[4]) };
      if (!current.source || !current.result || !current.count) throw new GitError('Invalid incremental blame range');
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('filename ')) {
      current.sourcePath = decodeGitPath(line.slice(9));
      current = undefined;
      continue;
    }
    const separator = line.indexOf(' ');
    if (separator > 0) {
      const fields = metadata.get(current.sha) ?? new Map<string, string>();
      fields.set(line.slice(0, separator), line.slice(separator + 1));
      metadata.set(current.sha, fields);
    }
  }
  const rows: Attribution[] = [];
  for (const hunk of hunks) {
    const fields = metadata.get(hunk.sha);
    for (let offset = 0; offset < hunk.count; offset++) {
      const index = hunk.result - 1 + offset;
      if (rows[index]) throw new GitError('Overlapping incremental blame ranges');
      rows[index] = /^0+$/.test(hunk.sha)
        ? { kind: 'uncommitted' }
        : {
          kind: 'committed', sha: hunk.sha, sourceLine: hunk.source + offset,
          sourcePath: hunk.sourcePath,
          author: fields?.get('author') || 'Unknown',
          authorTime: Number(fields?.get('author-time') || 0),
          summary: fields?.get('summary') || '(no summary)'
        };
    }
  }
  if (!hunks.length || Array.from({ length: rows.length }, (_, index) => rows[index]).some(row => !row)) {
    throw new GitError('Incomplete incremental blame output');
  }
  return rows;
}

// Git quotes paths with C escapes, including octal UTF-8 bytes.
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new GitError('Invalid quoted Git path');
  const chunks: Buffer[] = [];
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' };
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length;) {
    if (inner[i] !== '\\') {
      const point = String.fromCodePoint(inner.codePointAt(i)!);
      chunks.push(Buffer.from(point));
      i += point.length;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) { chunks.push(Buffer.from([parseInt(octal[0], 8)])); i += 4; }
    else {
      const escaped = escapes[inner[i + 1]];
      if (escaped === undefined) throw new GitError('Invalid Git path escape');
      chunks.push(Buffer.from(escaped));
      i += 2;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function relativePath(repo: Repository, file: string): string | undefined {
  const relative = path.relative(repo.root, file);
  return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined : relative;
}

export async function blameDocument(
  repo: Repository, file: string, contents: string, signal?: AbortSignal
): Promise<readonly Attribution[] | undefined> {
  const relative = relativePath(repo, file);
  if (!relative || Buffer.byteLength(contents, 'utf8') > 8 * 1024 * 1024) return undefined;
  try {
    const output = await runGit(repo.root, [
      'blame', '--incremental', '--encoding=UTF-8', '--contents', '-', repo.head, '--', relative
    ], { input: contents, signal, maxBytes: 2 * 1024 * 1024 });
    return parseIncrementalBlame(output);
  } catch {
    return undefined;
  }
}

export async function blameLine(
  repo: Repository,
  file: string,
  line: number,
  contents: string,
  token?: CancellationToken
): Promise<Attribution> {
  const relative = relativePath(repo, file);
  if (!relative) {
    return { kind: 'unavailable', reason: 'File is outside the Git repository' };
  }
  if (Buffer.byteLength(contents, 'utf8') > 8 * 1024 * 1024) {
    return { kind: 'unavailable', reason: 'File is too large for current-line blame' };
  }
  try {
    const output = await runGit(repo.root, [
      'blame', '--line-porcelain', '--encoding=UTF-8', '-L', `${line},${line}`,
      '--contents', '-', repo.head, '--', relative
    ], { input: contents, token });
    return parseBlame(output);
  } catch (error) {
    if (token?.isCancellationRequested) throw error;
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function showCommit(repo: Repository, sha: string): Promise<string> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new GitError('Invalid commit SHA');
  return runGit(repo.root, ['show', '--format=fuller', '--stat', '--no-renames', sha], { maxBytes: 4 * 1024 * 1024 });
}
