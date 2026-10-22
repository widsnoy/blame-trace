import * as vscode from 'vscode';
import { blameLine, locateRepository, runGit, showCommit, type Attribution, type Repository } from './git';

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

  const cache = new Map<string, Attribution>();
  let gitApi: GitApi | undefined;
  let gitApiPromise: Promise<GitApi | undefined> | undefined;
  const watchedRepositories = new WeakSet<GitRepository>();
  let requestId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
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

  function invalidate(): void {
    cache.clear();
    schedule();
  }

  function watchRepository(gitRepo: GitRepository, api: GitApi): void {
    if (watchedRepositories.has(gitRepo)) return;
    watchedRepositories.add(gitRepo);
    let head = gitRepo.state.HEAD?.commit;
    context.subscriptions.push(gitRepo.state.onDidChange(() => {
      const nextHead = gitRepo.state.HEAD?.commit;
      if (nextHead === head) return;
      head = nextHead;
      cache.clear();
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
    if (timer) clearTimeout(timer);
    cancellation?.cancel();
    cancellation?.dispose();
    cancellation = undefined;
    clearDecoration();
    timer = setTimeout(() => { void update(requestId); }, 150);
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
    try {
      const api = await getGitApi();
      if (tokenSource.token.isCancellationRequested) return;
      const gitRepo = api?.getRepository(document.uri);
      const apiHead = gitRepo?.state.HEAD?.commit;
      if (gitRepo && apiHead && api) watchRepository(gitRepo, api);
      const repo = gitRepo && apiHead
        ? { root: gitRepo.rootUri.fsPath, head: apiHead }
        : await locateRepository(file, tokenSource.token);
      if (!repo || tokenSource.token.isCancellationRequested) return;
      const key = `${repo.root}\0${repo.head}\0${file}\0${version}\0${line}`;
      let attribution = cache.get(key);
      if (!attribution) {
        attribution = await blameLine(repo, file, line + 1, document.getText(), tokenSource.token);
        if (attribution.kind !== 'unavailable') {
          cache.set(key, attribution);
          if (cache.size > 100) cache.delete(cache.keys().next().value!);
        }
      }
      if (tokenSource.token.isCancellationRequested || id !== requestId ||
        vscode.window.activeTextEditor !== editor || document.version !== version ||
        editor.selection.active.line !== line) return;
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
    if (event.document === vscode.window.activeTextEditor?.document) invalidate();
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(invalidate));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(invalidate));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('blameTrace.enabled')) schedule();
  }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState((event) => {
    if (event.focused) invalidate();
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(schedule));
  context.subscriptions.push({ dispose: () => {
    if (timer) clearTimeout(timer);
    cancellation?.cancel();
    cancellation?.dispose();
    clearDecoration();
  } });
  schedule();
}

export function deactivate(): void {}
