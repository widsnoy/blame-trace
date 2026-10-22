import { TextDecoder } from 'node:util';
import { type Attribution } from './git';
import { GitLabClient, isSha, object, positiveId, type Budget } from './gitlab';
import { SquashCache } from './squashCache';

export interface Commit { sha: string; author: string; authorTime: number; summary: string; url?: string }
export interface MergeRequest { iid: number; url: string; sourceProject?: number; targetProject: number; head?: string; sha?: string }
export type SquashResolution =
  | { kind: 'not-squash' }
  | { kind: 'mr-only'; mr: MergeRequest; commits: Commit[]; reason: string }
  | { kind: 'resolved'; mr: MergeRequest; commits: Commit[]; original: Commit; sourceHead: string }
  | { kind: 'unavailable'; reason: string };

function commit(value: unknown): Commit {
  const data = object(value);
  if (!isSha(data.id) || typeof data.author_name !== 'string' || typeof data.title !== 'string' || typeof data.authored_date !== 'string') throw new Error('Incomplete GitLab commit');
  const time = Date.parse(data.authored_date) / 1000;
  if (!Number.isFinite(time)) throw new Error('Invalid GitLab author date');
  return { sha: data.id, author: data.author_name, summary: data.title, authorTime: time };
}

interface Context { mr: MergeRequest; commits: Commit[]; head?: string; reason?: string }

export class SquashResolver {
  private readonly cache: SquashCache;
  private readonly controller = new AbortController();
  constructor(readonly client: GitLabClient) { this.cache = client.cache; }
  dispose(): void { this.controller.abort(); this.cache.clear(); this.client.dispose(); }
  private budget(): Budget { return { remaining: 100, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]) }; }

  private context(projectPath: string, sha: string, budget: Budget): Promise<Context | undefined> {
    return this.cache.get(`mr:${projectPath}:${sha}`, async () => {
      const project = object(await this.client.json(this.client.projectPath(projectPath), budget));
      const target = positiveId(project.id);
      const api = this.client.projectPath(target);
      const candidates = await this.client.list(`${api}/repository/commits/${sha}/merge_requests`, budget);
      const matches = new Map<number, Record<string, unknown>>();
      for (const candidate of candidates) {
        const item = object(candidate);
        if (item.target_project_id !== target || item.state !== 'merged') continue;
        const iid = positiveId(item.iid);
        const detail = object(await this.client.json(`${api}/merge_requests/${iid}`, budget));
        if (detail.target_project_id === target && detail.state === 'merged' && detail.squash_commit_sha === sha) matches.set(iid, detail);
      }
      if (!matches.size) return undefined;
      if (matches.size !== 1) throw new Error('Multiple squash merge requests match this commit');
      const [iid, data] = [...matches.entries()][0];
      const mr: MergeRequest = {
        iid, targetProject: target,
        sourceProject: typeof data.source_project_id === 'number' ? positiveId(data.source_project_id) : undefined,
        url: this.client.webUrl(projectPath, `merge_requests/${iid}`),
        head: data.diff_refs && isSha(object(data.diff_refs).head_sha) ? object(data.diff_refs).head_sha as string : undefined,
        sha: isSha(data.sha) ? data.sha : undefined
      };
      let commits: Commit[];
      try { commits = (await this.client.list(`${api}/merge_requests/${iid}/commits`, budget)).map(commit); }
      catch { return { mr, commits: [], reason: 'The complete MR commit list could not be loaded; open the MR to inspect it.' }; }
      let sourcePath: string | undefined = mr.sourceProject === target ? projectPath : undefined;
      if (mr.sourceProject && !sourcePath) {
        try {
          const source = object(await this.client.json(this.client.projectPath(mr.sourceProject), budget));
          if (typeof source.path_with_namespace === 'string') sourcePath = source.path_with_namespace;
        } catch { /* Deleted or inaccessible fork: retain list and MR link. */ }
      }
      if (sourcePath) for (const entry of commits) entry.url = this.client.webUrl(sourcePath, `commit/${entry.sha}`);
      if (mr.sourceProject !== target) return { mr, commits, reason: 'Automatic line tracing across projects is not supported yet.' };
      if (!mr.head || mr.head !== mr.sha || !commits.some(entry => entry.sha === mr.head)) {
        return { mr, commits, reason: 'The saved source head does not agree with the MR commit list.' };
      }
      try {
        const versions = await this.client.list(`${api}/merge_requests/${iid}/versions`, budget);
        const version = versions.map(object).find(item => item.head_commit_sha === mr.head && item.state === 'collected');
        if (!version) return { mr, commits, reason: 'No collected diff version matches the saved source head.' };
        const detail = object(await this.client.json(`${api}/merge_requests/${iid}/versions/${positiveId(version.id)}`, budget));
        if (detail.head_commit_sha !== mr.head || !Array.isArray(detail.commits)) throw new Error('Inconsistent diff version');
        const ids = new Set(detail.commits.map(item => object(item).id));
        if (ids.size !== commits.length || !commits.every(entry => ids.has(entry.sha))) throw new Error('Inconsistent diff commits');
        return { mr, commits, head: mr.head };
      } catch { return { mr, commits, reason: 'The saved MR diff version could not be verified.' }; }
    }, value => value ? (value.reason ? 30_000 : 600_000) : 60_000);
  }

  resolve(project: string, local: Extract<Attribution, { kind: 'committed' }>): Promise<SquashResolution> {
    return this.cache.get(`line:${JSON.stringify([project, local.sha, local.sourcePath, local.sourceLine])}`, async (): Promise<SquashResolution> => {
      const budget = this.budget();
      let context: Context | undefined;
      try {
        context = await this.context(project, local.sha, budget);
        if (!context) return { kind: 'not-squash' };
        const { mr, commits, head, reason } = context;
        const fallback = (reason: string): SquashResolution => ({ kind: 'mr-only', mr, commits, reason });
        if (!head || reason) return fallback(reason ?? 'Source head is unavailable.');
        if (!local.sourcePath || !Number.isSafeInteger(local.sourceLine) || local.sourceLine < 1) return fallback('Historical file coordinates are unavailable.');
        const files = `${this.client.projectPath(mr.targetProject)}/repository/files/${encodeURIComponent(local.sourcePath)}`;
        // The tree endpoint verifies the historical path and excludes symlinks.
        const parent = local.sourcePath.includes('/') ? local.sourcePath.slice(0, local.sourcePath.lastIndexOf('/')) : '';
        for (const ref of [head, local.sha]) {
          const tree = await this.client.list(`${this.client.projectPath(mr.targetProject)}/repository/tree?ref=${ref}&path=${encodeURIComponent(parent)}`, budget);
          const item = tree.map(object).find(entry => entry.path === local.sourcePath);
          if (!item || !['100644', '100755'].includes(String(item.mode))) return fallback('Only regular text files can be traced.');
        }
        const squash = await this.client.raw(`${files}/raw?ref=${local.sha}`, budget);
        const source = await this.client.raw(`${files}/raw?ref=${head}`, budget);
        if (!squash.equals(source)) return fallback('Squash and source files differ; automatic line mapping is not yet supported.');
        if (source.includes(0)) return fallback('Binary files cannot be traced.');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
        const lines = text.split('\n');
        if (text.endsWith('\n')) lines.pop();
        if (local.sourceLine > lines.length) return fallback('The historical line is outside the source file.');
        const response = await this.client.json(`${files}/blame?ref=${head}&range[start]=${local.sourceLine}&range[end]=${local.sourceLine}`, budget);
        if (!Array.isArray(response) || response.length !== 1) return fallback('Unexpected source blame range.');
        const range = object(response[0]);
        const expected = lines[local.sourceLine - 1].replace(/\r$/, '');
        if (!Array.isArray(range.lines) || range.lines.length !== 1 || typeof range.lines[0] !== 'string' || range.lines[0].replace(/\r$/, '') !== expected) return fallback('Source blame content does not match the historical line.');
        const blamed = object(range.commit);
        const original = commits.find(entry => entry.sha === blamed.id);
        if (!original) return fallback('This line belongs to history before this MR.');
        return { kind: 'resolved', mr, commits, original, sourceHead: head };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'GitLab trace unavailable';
        return context ? { kind: 'mr-only', mr: context.mr, commits: context.commits, reason } : { kind: 'unavailable', reason };
      }
    }, value => value.kind === 'resolved' ? 600_000 : value.kind === 'not-squash' ? 60_000 : 30_000);
  }
}
