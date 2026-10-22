import * as vscode from 'vscode';
import path from 'node:path';
import { blameLine, locateRepository, runGit, showCommit, type Attribution, type Repository } from './git';
import { DocumentBlameCache } from './documentCache';

interface SelectionResult {
  repo: Repository;
  attribution: Attribution;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly commit?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

function relativeDate(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown date';
  const elapsed = Math.max(0, Date.now() - unixSeconds * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  if (elapsed < minute) return 'just now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < month) return `${Math.floor(elapsed / day)}d ago`;
  if (elapsed < year) return `${Math.floor(elapsed / month)}mo ago`;
  return `${Math.floor(elapsed / year)}y ago`;
}

function annotation(attribution: Attribution): string {
  if (attribution.kind === 'uncommitted') return 'Uncommitted changes';
  if (attribution.kind === 'unavailable') return '';
  const text = `${attribution.author} · ${relativeDate(attribution.authorTime)} · ${attribution.summary}`;
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

function hover(attribution: Attribution): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  if (attribution.kind === 'uncommitted') {
    markdown.appendText('This line has uncommitted changes.');
    return markdown;
  }
  if (attribution.kind === 'unavailable') return markdown;
  markdown.appendText(`${attribution.summary}\n\n${attribution.author} · ${new Date(attribution.authorTime * 1000).toLocaleString()}\n\n${attribution.sha}`);
  markdown.appendMarkdown('\n\n[Show commit details](command:blameTrace.showCommit)');
  markdown.isTrusted = { enabledCommands: ['blameTrace.showCommit'] };
  return markdown;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Blame Trace');
  const decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 2em'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  context.subscriptions.push(output, decoration);

  const cache = new DocumentBlameCache();
  const editedAt = new Map<string, number>();
  const rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let gitApi: GitApi | undefined;
  let gitApiPromise: Promise<GitApi | undefined> | undefined;
  const watchedRepositories = new WeakSet<GitRepository>();
  let requestId = 0;
  let cancellation: vscode.CancellationTokenSource | undefined;
  let decoratedEditor: vscode.TextEditor | undefined;
  let current: SelectionResult | undefined;
  let scheduledEditor: vscode.TextEditor | undefined;
  let scheduledLine: number | undefined;

  function clearDecoration(): void {
    decoratedEditor?.setDecorations(decoration, []);
    decoratedEditor = undefined;
    current = undefined;
  }

  function watchRepository(gitRepo: GitRepository, api: GitApi): void {
    if (watchedRepositories.has(gitRepo)) return;
    watchedRepositories.add(gitRepo);
    let head = gitRepo.state.HEAD?.commit;
    context.subscriptions.push(gitRepo.state.onDidChange(() => {
      const nextHead = gitRepo.state.HEAD?.commit;
      if (nextHead === head) return;
      head = nextHead;
      cache.invalidateRepository(gitRepo.rootUri.fsPath);
      for (const [file, timer] of rebuildTimers) {
        const relative = path.relative(gitRepo.rootUri.fsPath, file);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        clearTimeout(timer);
        rebuildTimers.delete(file);
      }
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri && api.getRepository(activeUri) === gitRepo) schedule();
    }));
  }

  async function getGitApi(): Promise<GitApi | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension || (extension.isActive && !extension.exports.enabled)) {
      gitApi = undefined;
      return undefined;
    }
    if (gitApi) return gitApi;
    if (!gitApiPromise) {
      gitApiPromise = Promise.resolve(extension.activate())
        .then(exports => exports.getAPI(1))
        .then(api => { gitApi = api; return api; })
        .catch(() => undefined)
        .finally(() => { gitApiPromise = undefined; });
    }
    return gitApiPromise;
  }

  function schedule(): void {
    scheduledEditor = vscode.window.activeTextEditor;
    scheduledLine = scheduledEditor?.selection.active.line;
    requestId += 1;
    cancellation?.cancel();
    cancellation?.dispose();
    cancellation = undefined;
    clearDecoration();
    void update(requestId);
  }

  function queueRebuild(repo: Repository, document: vscode.TextDocument): void {
    const file = document.uri.fsPath;
    const previous = rebuildTimers.get(file);
    if (previous) clearTimeout(previous);
    const version = document.version;
    const timer = setTimeout(() => {
      rebuildTimers.delete(file);
      if (document.isClosed || document.version !== version) return;
      void cache.load(repo, file, version, document.getText()).then(rows => {
        if (rows && vscode.window.activeTextEditor?.document === document && document.version === version) schedule();
      });
    }, 250);
    rebuildTimers.set(file, timer);
  }

  function render(editor: vscode.TextEditor, line: number, result: SelectionResult): void {
    const text = annotation(result.attribution);
    if (!text) return;
    const length = editor.document.lineAt(line).text.length;
    const range = new vscode.Range(line, 0, line, length);
    editor.setDecorations(decoration, [{
      range,
      hoverMessage: hover(result.attribution),
      renderOptions: { after: { contentText: `  ${text}` } }
    }]);
    decoratedEditor = editor;
    current = result;
  }

  async function update(id: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !vscode.workspace.isTrusted ||
      !vscode.workspace.getConfiguration('blameTrace').get<boolean>('enabled', true)) return;

    const document = editor.document;
    const file = document.uri.fsPath;
    const line = editor.selection.active.line;
    const version = document.version;
    const tokenSource = new vscode.CancellationTokenSource();
    cancellation = tokenSource;
    const isCurrent = () => !tokenSource.token.isCancellationRequested && id === requestId &&
      vscode.window.activeTextEditor === editor && document.version === version &&
      editor.selection.active.line === line;
    const pause = async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return isCurrent();
    };
    try {
      const api = await getGitApi();
      if (!isCurrent()) return;
      const gitRepo = api?.getRepository(document.uri);
      const apiHead = gitRepo?.state.HEAD?.commit;
      if (gitRepo && apiHead && api) watchRepository(gitRepo, api);
      if (!apiHead && !await pause()) return;
      const repo = gitRepo && apiHead
        ? { root: gitRepo.rootUri.fsPath, head: apiHead }
        : await locateRepository(file, tokenSource.token);
      if (!repo || !isCurrent()) return;
      let contents: string | undefined;
      const getContents = () => contents ??= document.getText();
      let rows = cache.get(repo, file, version, getContents);
      let attribution = rows?.[line];
      if (!attribution) {
        if (apiHead && !await pause()) return;
        if (Date.now() - (editedAt.get(file) ?? 0) < 250) {
          attribution = await blameLine(repo, file, line + 1, getContents(), tokenSource.token);
          queueRebuild(repo, document);
        } else {
          rows = await cache.load(repo, file, version, getContents());
          attribution = rows?.[line] ?? await blameLine(repo, file, line + 1, getContents(), tokenSource.token);
        }
      }
      if (!isCurrent()) return;
      const latestHead = gitRepo && apiHead
        ? gitRepo.state.HEAD?.commit
        : (await runGit(repo.root, ['rev-parse', '--verify', 'HEAD'], { token: tokenSource.token })).trim();
      if (latestHead !== repo.head || id !== requestId || tokenSource.token.isCancellationRequested) return;
      if (attribution.kind === 'unavailable') {
        output.appendLine(`${file}:${line + 1}: ${attribution.reason}`);
        return;
      }
      render(editor, line, { repo, attribution });
    } catch (error) {
      if (!tokenSource.token.isCancellationRequested && id === requestId) {
        output.appendLine(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (cancellation === tokenSource) cancellation = undefined;
      tokenSource.dispose();
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('blameTrace.toggle', async () => {
    const config = vscode.workspace.getConfiguration('blameTrace');
    await config.update('enabled', !config.get<boolean>('enabled', true), vscode.ConfigurationTarget.Global);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('blameTrace.showCommit', async () => {
    if (!current || current.attribution.kind !== 'committed') {
      vscode.window.showInformationMessage('No committed line is selected.');
      return;
    }
    try {
      output.clear();
      output.append(await showCommit(current.repo, current.attribution.sha));
      output.show(true);
    } catch (error) {
      vscode.window.showErrorMessage(`Blame Trace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor !== vscode.window.activeTextEditor) return;
    const line = event.textEditor.selection.active.line;
    if (event.textEditor !== scheduledEditor || line !== scheduledLine) schedule();
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(schedule));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0 || event.document.uri.scheme !== 'file') return;
    const file = event.document.uri.fsPath;
    cache.noteChange(file);
    editedAt.set(file, Date.now());
    const timer = rebuildTimers.get(file);
    if (timer) clearTimeout(timer);
    rebuildTimers.delete(file);
    if (event.document === vscode.window.activeTextEditor?.document) schedule();
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    cache.noteChange(document.uri.fsPath);
    editedAt.delete(document.uri.fsPath);
    const timer = rebuildTimers.get(document.uri.fsPath);
    if (timer) clearTimeout(timer);
    rebuildTimers.delete(document.uri.fsPath);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('blameTrace.enabled')) schedule();
  }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState((event) => {
    if (event.focused) schedule();
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(schedule));
  context.subscriptions.push({ dispose: () => {
    cancellation?.cancel();
    cancellation?.dispose();
    for (const timer of rebuildTimers.values()) clearTimeout(timer);
    cache.dispose();
    clearDecoration();
  } });
  schedule();
}

export function deactivate(): void {}
