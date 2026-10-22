import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CancellationToken } from 'vscode';

export type Attribution =
  | { kind: 'committed'; sha: string; sourceLine: number; author: string; authorTime: number; summary: string }
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
  options: { input?: string; token?: CancellationToken; maxBytes?: number } = {}
): Promise<string> {
  if (options.token?.isCancellationRequested) throw new GitError('Cancelled');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    let bytes = 0;
    let errorBytes = 0;
    let settled = false;
    let cancellation: { dispose(): void } | undefined;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      if (error) reject(error);
      else resolve(value ?? '');
    };
    cancellation = options.token?.onCancellationRequested(() => {
      child.kill();
      finish(new GitError('Cancelled'));
    });
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
  let root: string;
  try {
    root = (await runGit(cwd, ['rev-parse', '--show-toplevel'], { token })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GitError('Git executable was not found in PATH');
    return undefined;
  }
  try {
    const head = (await runGit(root, ['rev-parse', '--verify', 'HEAD'], { token })).trim();
    return { root, head };
  } catch {
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
    author: fields.get('author') || 'Unknown',
    authorTime: Number(fields.get('author-time') || 0),
    summary: fields.get('summary') || '(no summary)'
  };
}

export async function blameLine(
  repo: Repository,
  file: string,
  line: number,
  contents: string,
  token?: CancellationToken
): Promise<Attribution> {
  const relative = path.relative(repo.root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
