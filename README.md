# Blame Trace

Blame Trace 是一个 VS Code 插件。把光标放在已提交文件的某一行，就会在该行末尾看到最近一次修改该行的提交作者、相对时间和摘要。悬停可查看完整 SHA、精确时间，并打开提交详情。未提交的新增或修改行显示 `Uncommitted changes`。

默认只使用本地 Git，不需要 GitLab 登录。可选开启 GitLab squash 追溯，查看 MR 原始提交列表，并在文件能可靠对应时显示当前行的原始提交。

## 本地运行

需要桌面版 VS Code、Node.js 和命令行可用的 Git。

1. 在本仓库运行 `npm install` 和 `npm run compile`。
2. 用 VS Code 打开本仓库，按 **F5** 启动 `Run Blame Trace`。
3. 在新开的 Extension Development Host 中打开一个已有提交的 Git 仓库，选择受 Git 追踪的文件，将光标放到任意一行。

可以运行 **Blame Trace: Toggle Current Line Blame** 来开关标注，或运行 **Blame Trace: Show Current Line Commit** 查看当前提交。诊断信息写入 **Output → Blame Trace**。

## GitLab squash 追溯

在受信任的工作区中配置（自建实例替换地址）：

```json
{
  "blameTrace.gitlab.enabled": true,
  "blameTrace.gitlab.instanceUrl": "https://gitlab.com",
  "blameTrace.gitlab.remoteName": "origin"
}
```

执行 **Blame Trace: Set GitLab Token**，输入具有 `read_api` 权限的令牌。令牌按实例保存在 VS Code SecretStorage；**Delete GitLab Token** 可删除它。公开项目可以不设令牌。SSH remote 只用于识别项目，API 请求仍通过 HTTPS 和令牌认证。

项目默认从指定 remote 解析，支持 subgroup、HTTPS 和 SSH 地址。SSH 别名等无法匹配实例时，可在仓库根目录作为 workspace folder 的设置中指定 `blameTrace.gitlab.projectPath` 为 `group/project`。这个覆盖只应用于该文件夹根仓库，嵌套仓库使用自己的 remote。自建实例 URL 可以包含安装子路径。

光标停留后先显示本地 blame，再尝试读取 GitLab。悬停可打开 MR、查看 squash 内提交列表或查看 squash 本身；也可执行 **Blame Trace: Show Squash Commits**，从列表打开原始提交页面。

首版自动行追溯支持同项目 MR、相同历史路径且 squash 与源版本文件字节完全一致的 UTF-8 普通文本文件。验证通过后，标注显示原作者并追加 `squash !编号`；“查看当前提交”打开该原始提交的 GitLab 页面。文件内容不同、fork MR、源对象不可读或版本无法确认时保留本地归属，并尽可能提供 MR 提交列表。不会自动 fetch 或修改 Git 仓库。

网络缓存仅驻留内存；关闭追溯、改配置或换令牌会清空。请求失败会降级，认证错误会暂停该实例请求，更新令牌或配置后恢复。单次响应上限 2 MiB，单次追溯预算 15 秒 / 100 次请求；大型 MR 超限时不推断行归属。实现设计见 [GitLab squash 溯源设计](docs/GitLab-squash溯源设计.md)。

## 验证

运行 `npm test`。测试会编译插件，并用临时 Git 仓库验证已提交行、未保存插入与修改，以及包含中文和空格的文件路径。
