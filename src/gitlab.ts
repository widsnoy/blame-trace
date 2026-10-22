import https from 'node:https';
import { SquashCache } from './squashCache';

export const isSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitLab response');
  return value as JsonObject;
}
export function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid GitLab ID');
  return value;
}

export function instanceUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Configure an HTTPS GitLab instance URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export function remoteProject(remote: string, instance: string): string {
  const base = new URL(instance);
  let host: string;
  let pathname: string;
  let httpRemote = false;
  if (/^[^/@:]+@[^/:]+:/.test(remote)) {
    const match = /^[^@]+@([^:]+):(.+)$/.exec(remote)!;
    host = match[1]; pathname = match[2];
  } else {
    const url = new URL(remote);
    if (!['https:', 'ssh:'].includes(url.protocol)) throw new Error('Unsupported Git remote');
    httpRemote = url.protocol === 'https:';
    if (httpRemote && url.port !== base.port) throw new Error('Remote port differs from GitLab instance; configure a repository project override');
    host = url.hostname; pathname = decodeURIComponent(url.pathname);
  }
  if (host.toLowerCase() !== base.hostname.toLowerCase()) throw new Error('Remote host differs from GitLab instance; configure a repository project override');
  pathname = pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
  if (httpRemote && prefix && pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length + 1);
  if (!pathname.includes('/') || pathname.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid GitLab project path');
  return pathname;
}

export interface Budget { signal: AbortSignal; remaining: number }
export class GitLabError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

// A service owns one client per configured instance/token generation. No token
// is ever part of a URL, cache key, diagnostic, or persisted configuration.
export class GitLabClient {
  readonly cache = new SquashCache();
  private readonly controller = new AbortController();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private retryAt = 0;
  constructor(readonly instance: string, private readonly token: string, private readonly transport: typeof https.get = https.get) {}

  dispose(): void { this.controller.abort(); this.cache.clear(); }

  private async request(endpoint: string, budget: Budget): Promise<{ body: Buffer; next: string }> {
    const signal = AbortSignal.any([this.controller.signal, budget.signal, AbortSignal.timeout(5000)]);
    if (this.active >= 2) await new Promise<void>((resolve, reject) => {
      const resume = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const i = this.waiting.indexOf(resume); if (i >= 0) this.waiting.splice(i, 1); reject(new Error('GitLab request cancelled')); };
      this.waiting.push(resume);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    else this.active++;
    try {
      signal.throwIfAborted();
      if (Date.now() < this.retryAt) throw new GitLabError('GitLab requests paused; check token permissions or retry later');
      if (--budget.remaining < 0) throw new GitLabError('GitLab request budget exceeded');
      const url = new URL(`${this.instance}/api/v4/${endpoint}`);
      return await new Promise((resolve, reject) => {
        const req = this.transport(url, { signal, headers: this.token ? { 'PRIVATE-TOKEN': this.token } : {} }, response => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.resume();
            if (status === 401 || status === 403) this.retryAt = Infinity;
            else if (status === 429) {
              const retry = response.headers['retry-after'];
              const seconds = Number(retry);
              this.retryAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(String(retry));
              if (!Number.isFinite(this.retryAt)) this.retryAt = Date.now() + 60_000;
            } else if (status >= 500) this.retryAt = Date.now() + 10_000;
            reject(new GitLabError(`GitLab HTTP ${status}${status === 401 || status === 403 ? ': set a token with read API permission' : ''}`, status));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) { response.destroy(); reject(new GitLabError('GitLab response exceeds 2 MiB')); }
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new GitLabError('GitLab response interrupted')));
          response.on('end', () => resolve({ body: Buffer.concat(chunks), next: String(response.headers['x-next-page'] ?? '') }));
        });
        req.on('error', () => { this.retryAt = Math.max(this.retryAt, Date.now() + 10_000); reject(new GitLabError('GitLab request cancelled, timed out or failed')); });
      });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  json(endpoint: string, budget: Budget): Promise<unknown> {
    return this.cache.get(`json:${endpoint}`, async () => JSON.parse((await this.request(endpoint, budget)).body.toString('utf8')) as unknown);
  }

  raw(endpoint: string, budget: Budget): Promise<Buffer> {
    return this.cache.get(`raw:${endpoint}`, async () => (await this.request(endpoint, budget)).body);
  }

  list(endpoint: string, budget: Budget): Promise<unknown[]> {
    return this.cache.get(`list:${endpoint}`, async () => {
      const results: unknown[] = [];
      let page = 1;
      let bytes = 0;
      while (true) {
        const response = await this.request(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, budget);
        bytes += response.body.length;
        if (bytes > 16 * 1024 * 1024) throw new GitLabError('GitLab list exceeds 16 MiB');
        const items: unknown = JSON.parse(response.body.toString('utf8'));
        if (!Array.isArray(items)) throw new GitLabError('Invalid GitLab list');
        results.push(...items);
        if (results.length > 10_000) throw new GitLabError('GitLab list exceeds limit');
        // Some proxies strip pagination headers; a full page needs another read.
        if (!response.next && items.length < 100) return results;
        const next = response.next ? Number(response.next) : page + 1;
        if (!Number.isSafeInteger(next) || next <= page) throw new GitLabError('Invalid GitLab pagination');
        page = next;
      }
    }, value => value.length ? 600_000 : 60_000);
  }

  projectPath(project: string | number): string { return `projects/${encodeURIComponent(String(project))}`; }
  webUrl(projectPath: string, suffix: string): string {
    return `${this.instance}/${projectPath.split('/').map(encodeURIComponent).join('/')}/-/${suffix}`;
  }
}
