# Blame Trace

Blame Trace 是一个 VS Code 插件。把光标放在已提交文件的某一行，就会在该行末尾看到最近一次修改该行的提交作者、相对时间和摘要。悬停可查看完整 SHA、精确时间，并打开提交详情。未提交的新增或修改行显示 `Uncommitted changes`。

第一阶段只使用本地 Git，不需要 GitLab 登录。GitLab squash 内原始提交的追溯方案见 [docs/方案.md](docs/方案.md)，尚未实现。

## 本地运行

需要桌面版 VS Code、Node.js 和命令行可用的 Git。

1. 在本仓库运行 `npm install` 和 `npm run compile`。
2. 用 VS Code 打开本仓库，按 **F5** 启动 `Run Blame Trace`。
3. 在新开的 Extension Development Host 中打开一个已有提交的 Git 仓库，选择受 Git 追踪的文件，将光标放到任意一行。

可以运行 **Blame Trace: Toggle Current Line Blame** 来开关标注，或运行 **Blame Trace: Show Current Line Commit** 查看当前提交。诊断信息写入 **Output → Blame Trace**。

## 验证

运行 `npm test`。测试会编译插件，并用临时 Git 仓库验证已提交行、未保存插入与修改，以及包含中文和空格的文件路径。
