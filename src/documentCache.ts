import { createHash } from 'node:crypto';
import { blameDocument, type Attribution, type Repository } from './git';

interface Snapshot {
  version: number;
  hash: string;
  rows: readonly Attribution[];
  bytes: number;
}

interface Entry {
  repo: Repository;
  file: string;
  snapshot?: Snapshot;
  previous?: Snapshot;
  pending?: { version: number; hash: string; controller: AbortController; promise: Promise<readonly Attribution[] | undefined> };
  failed?: { version: number; hash: string };
}

const MAX_DOCUMENTS = 8;
const MAX_BYTES = 16 * 1024 * 1024;

export class DocumentBlameCache {
  private readonly entries = new Map<string, Entry>();

  private key(repo: Repository, file: string): string {
    return `${repo.root}\0${repo.head}\0${file}`;
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private hash(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
  }

  private exact(entry: Entry, version: number, contents: string): readonly Attribution[] | undefined {
    for (const snapshot of [entry.snapshot, entry.previous]) {
      if (!snapshot) continue;
      if (snapshot.version !== version && snapshot.hash !== this.hash(contents)) continue;
      snapshot.version = version;
      if (snapshot === entry.previous) {
        entry.previous = entry.snapshot;
        entry.snapshot = snapshot;
      }
      return snapshot.rows;
    }
    return undefined;
  }

  get(repo: Repository, file: string, version: number, contents: string): readonly Attribution[] | undefined {
    const key = this.key(repo, file);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.touch(key, entry);
    return this.exact(entry, version, contents);
  }

  async load(repo: Repository, file: string, version: number, contents: string): Promise<readonly Attribution[] | undefined> {
    const key = this.key(repo, file);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { repo, file };
      this.entries.set(key, entry);
    }
    this.touch(key, entry);
    const exact = this.exact(entry, version, contents);
    if (exact) return exact;
    const hash = this.hash(contents);
    if (entry.failed?.hash === hash) return undefined;
    if (entry.pending?.hash === hash) return entry.pending.promise;
    entry.pending?.controller.abort();
    const controller = new AbortController();
    const pending = {
      version, hash, controller,
      promise: blameDocument(repo, file, contents, controller.signal)
    };
    entry.pending = pending;
    this.trim();
    const rows = await pending.promise;
    if (entry.pending !== pending) return undefined;
    entry.pending = undefined;
    if (rows) {
      entry.previous = entry.snapshot;
      entry.snapshot = { version, hash, rows, bytes: rows.length * 80 + Buffer.byteLength(contents, 'utf8') };
      entry.failed = undefined;
    } else if (!controller.signal.aborted) {
      entry.failed = { version, hash };
    }
    this.trim();
    return rows;
  }

  noteChange(file: string): void {
    for (const entry of this.entries.values()) {
      if (entry.file !== file) continue;
      entry.pending?.controller.abort();
      entry.pending = undefined;
      entry.failed = undefined;
      if (entry.snapshot) entry.snapshot.version = -1;
      if (entry.previous) entry.previous.version = -1;
      // Keep the immutable prior snapshot for an exact undo or redo match.
    }
  }

  invalidateRepository(root: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.repo.root === root) this.remove(key, entry);
    }
  }

  dispose(): void {
    for (const [key, entry] of this.entries) this.remove(key, entry);
  }

  private remove(key: string, entry: Entry): void {
    entry.pending?.controller.abort();
    this.entries.delete(key);
  }

  private trim(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += (entry.snapshot?.bytes ?? 0) + (entry.previous?.bytes ?? 0);
    while (this.entries.size > MAX_DOCUMENTS || bytes > MAX_BYTES) {
      const [key, entry] = this.entries.entries().next().value as [string, Entry];
      bytes -= (entry.snapshot?.bytes ?? 0) + (entry.previous?.bytes ?? 0);
      this.remove(key, entry);
    }
  }
}
