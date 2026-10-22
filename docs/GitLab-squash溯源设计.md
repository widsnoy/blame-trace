# GitLab squash 原始提交追溯设计

状态：首版已实现，按本次要求未运行测试，尚未做真实 GitLab 验证。本文细化 [总体方案](方案.md) 的第二阶段。

分支：`feat/gitlab-squash-trace`，基于拉取后的 `origin/main`（`b73ede3`）。远端默认分支名为 `main`，不存在 `master`。

## 要解决的问题

MR 中张三提交 A、李四提交 B，合并时压成提交 S。目标分支的普通 blame 只能看到 S。希望既能查看该 MR 中的 A、B，也能在证据充分时，把当前行显示为实际修改它的 A 或 B。

这两种能力分开提供：查到 MR 就可以看提交列表；只有原始版本、文件和行的对应关系都通过检查，才替换当前行的作者。列表中的提交不等于都修改过当前行。

## 首版范围与交互

1. 默认关闭网络追溯，用户配置 GitLab 实例、项目和令牌后开启。支持 GitLab.com 和使用 HTTPS 的自建实例。
2. 先立即展示现有本地 blame，停留约 300 ms 后查询 GitLab；网络请求不阻塞本地标注。
3. 找到唯一的已合并 squash MR 后，悬停增加 MR 链接和“查看 squash 内提交”。命令使用 QuickPick 展示 SHA、作者和摘要，选中后打开对应 GitLab 提交页面；不增加侧栏。
4. 当前行追溯成功时，行末显示 `张三 · 3 天前 · 修复校验 · squash !42`；悬停同时显示原始 SHA、squash SHA 和 MR。
5. 只能找到 MR、无法确定具体行时，仍显示本地 S，悬停说明原因，并保留提交列表入口。普通提交无匹配 MR 时保持普通显示。
6. “查看当前提交”跟随当前显示的归属：普通结果继续本地 `git show`；远端原始提交打开 GitLab 页面。悬停另有查看 squash 提交的入口。

首版自动行追溯仅处理**同项目、历史路径相同、S 与 H 的文件字节完全一致**的情况。后续提交导致的行号移动及改名，由普通 blame 的历史坐标解决。S 与 H 之间有文件内容差异、MR 内复杂改名、跨项目 MR 时，先支持查看列表并说明自动行追溯暂不支持。

这是对总体方案的分步落地：差异区块行映射留到第二轮，避免首版把 diff 的任意对齐当作可靠归属。

## 处理流程

```text
本地 blame → 历史坐标 (S, pathS, nS) → 立即展示普通结果
                         ↓
              GitLab 关联 MR → 唯一 squash MR
                         ├→ 完整 MR 提交列表 → 可供查看
                         ↓
              锁定源 head H 与提交集合 C
                         ↓
              文件相同 → H 的第 nS 行 blame → O
                         ↓
              O 属于 C → 展示原始提交并保留 S
```

### 1. 保留本地历史路径

`Attribution` 在已有 `sourceLine` 上增加 `sourcePath`，由 `parseBlame` 和 `parseIncrementalBlame` 保留 `filename`。含义是该行在归属提交中的路径，不是编辑器当前路径。

incremental 的路径属于每个 hunk，不能按 SHA 共享，否则同一提交涉及多文件时会混淆。需要解码 Git 引号路径和八进制转义，覆盖中文、空格、引号、反斜杠。全零 SHA 的未提交行不走 GitLab。

### 2. 从 S 定位 MR

调用 `GET /projects/:id/repository/commits/:sha/merge_requests` 并遍历分页；对候选读取 MR 详情，只接受目标项目正确、`state=merged` 且 `squash_commit_sha === S` 的结果。零个匹配不算错误；多个匹配不自动选一个。首版不根据提交标题、MR 编号文本或 `merge_commit_sha` 猜测。

兼容较旧 GitLab 时不依赖该接口较新加入的 `state` 查询参数，在客户端过滤。[GitLab 提交关联 MR API](https://docs.gitlab.com/api/commits/#list-merge-requests-associated-with-a-commit)

### 3. 获取提交列表与 H

读取 MR 的 `/commits`，处理全部分页，保存集合 C 及列表元数据。H 使用 MR 保存的 `diff_refs.head_sha`，并读取 `/versions` 及对应版本详情，核对 `head_commit_sha`、MR SHA 和提交集合是否一致。不能读取当前同名源分支，也不能仅取列表第一项作为 H。

这些字段描述 MR 保存的 diff 状态，不构成所有合并方式下“合并瞬间源 head”的普遍保证。首版要求 H 非空、H 属于完整 C、存在一致的已收集 diff 版本；字段冲突或 rebase 后无法确定版本就停止行追溯。真实 GitLab 验证中需重点确认这项假设。[GitLab MR API 与 diff versions](https://docs.gitlab.com/api/merge_requests/)

删除源分支不直接判失败：继续按保存的 SHA 读取。对象已清理、无权限或不存在时，保留仍能取得的 MR 列表，不自动 fetch 远端对象。

### 4. 验证文件与行

首版统一通过 GitLab raw 文件接口读取 S 与 H 的 `pathS`，减少本地/远端两套历史读取逻辑；本地对象优先读取作为后续优化。先通过 [repository tree API](https://docs.gitlab.com/api/repositories/#list-repository-tree) 核对两侧路径及普通文件 mode，再按原始字节比较，不忽略空格、换行或 Unicode 差异；二进制、非 UTF-8 文本、非普通文件和超限文件不处理。

只有完全相同且 nS 在有效范围内，才有 `nH = nS`。调用 GitLab 文件 blame API，传 `ref=H` 和单行 `range[start/end]`。验证返回的行内容和提交 SHA，再检查 O 是否属于完整 C。O 属于基线历史而非 C 时不宣称找到 squash 内原始提交。[GitLab 文件读取与 blame API](https://docs.gitlab.com/api/repository_files/)

后续差异映射需要另行设计歧义判定与用例：普通 diff 给出一组相等区块，并不证明重复文本之间有唯一历史对应关系。冲突解决改写的行尤其不能硬套源分支行号。

## GitLab 配置与认证

拟新增 `blameTrace.gitlab.enabled`（默认 false）、`instanceUrl`、`projectPath` 和 `remoteName`（默认 origin）。项目映射按所属仓库处理；多仓库工作区按文件所属 workspace folder 取配置，嵌套仓库优先使用自身 remote。显式项目覆盖需绑定仓库，不能让父目录配置误套所有嵌套仓库。

支持 HTTPS、`ssh://` 和 `git@host:group/project.git` remote，去除 `.git` 并保留 subgroup。自建实例子路径、SSH 别名和端口无法可靠转换时要求显式配置 HTTPS 实例地址；不把任意 Git host 自动认作 GitLab。请求中对项目路径、文件路径及查询参数分别编码。

新增设置/删除 GitLab Token 的命令，用 VS Code `SecretStorage` 按实例存储；建议使用具备所需只读 API 权限的 token，具体 scope 在真实实例验证。令牌不进入 settings、缓存键或日志。仅向已配置实例发送令牌，拒绝跨 origin 重定向；不关闭 TLS 验证。未受信任工作区不访问 GitLab。

跨项目 MR 读取列表仍使用目标项目的 MR API；提交链接归属按源项目解析，源项目不可用时保留列表文本及 MR 链接，不能伪造可访问的提交链接。

## 模块与结果类型

| 文件 | 变化 |
| --- | --- |
| `src/git.ts` | 保留历史路径，并解析 Git 的引号及八进制路径转义。历史文件及源版本 blame 首版由 GitLab client 读取。 |
| `src/gitlab.ts`（新增） | remote 解析、项目解析、HTTP、分页、超时和响应验证；允许注入 transport 做测试。 |
| `src/squashResolver.ts`（新增） | MR 定位、H 验证、文件对应和提交集合核对，不依赖编辑器。 |
| `src/squashCache.ts`（新增） | 网络结果缓存、请求合并和失败退避。 |
| `src/extension.ts` | 两阶段渲染、列表命令、令牌命令、悬停入口及过期结果校验。 |
| `package.json` | 注册命令及配置。 |

本地 `Attribution` 保持原义，只补 `sourcePath`。网络层返回独立的结果：

```ts
type SquashResolution =
  | { kind: 'not-squash' }
  | { kind: 'mr-only'; mr: MergeRequest; commits: Commit[]; reason: string }
  | { kind: 'resolved'; mr: MergeRequest; original: Commit; sourceHead: string }
  | { kind: 'unavailable'; reason: string };
```

展示层始终保存 local attribution 和可选 squash resolution，不覆盖文档 blame 缓存。MR 和 Commit 类型需携带项目身份，不能仅以 SHA 拼远端链接。

## 缓存、取消与失败处理

- MR 关联键：`实例 + 目标项目 ID + S`；文件键：`实例 + 项目 ID + SHA + 历史路径`；行结果键再加历史行号。请求携带独立认证代次，换令牌后清空并拒绝旧请求回填。
- 成功结果 TTL 10 分钟，无 MR 结果 1 分钟，失败结果 30 秒；每实例共享 LRU 上限 128 条、估算总容量 16 MiB，单次响应最多 2 MiB。全部仅内存保存，与文档缓存独立。
- 同键请求共用 Promise，每实例最多两个网络请求；单请求含排队超时 5 秒，单次解析总预算 15 秒、最多 100 次 HTTP 请求。分页集合额外限制 10,000 条 / 16 MiB。超预算明确返回未完整取得数据，不把部分提交集合用于判断。
- 分页沿 API 返回的页信息读取，并校验下一页仍在指定实例；不能只读默认第一页。401/403 暂停该认证代次的自动请求并提示配置入口；404 与权限隐藏无法可靠区分，不记作永久不存在；429 尊重 Retry-After；超时和 5xx 短暂退避。光标移动不弹错误框。
- 渲染前再次核对 requestId、编辑器 URI、文档版本、光标行、HEAD、配置与认证代次。失效请求即使完成也不得修改当前装饰。
- 共用请求由缓存持有生命周期，单个光标离开只取消自己的更新；请求在预算内完成并缓存，首版不按订阅人数中止。配置或令牌变化、关闭功能或扩展销毁时取消相关请求并清缓存。每次网络查询及渲染前检查工作区信任；VS Code 切回 Restricted Mode 会重载窗口并销毁扩展。
- 本地 `update()` 在 finally 中释放 token；网络阶段独立校验请求序号和配置代次，不复用已经释放的 token。
- 悬停命令绑定生成时的结果标识，并校验仍有效，避免点旧悬停却打开新光标的提交。外部元数据以纯文本写入 Markdown，命令链接只信任插件注册的命令。

## 实施顺序与验收

1. 补历史路径和固定 SHA 查询（已实现）；后续用真实临时 Git 仓库测试 squash 后改名、插行和未保存编辑。
2. 实现 GitLab client、配置和认证；先打通唯一 MR 与完整提交列表，处理分页及错误。
3. 接入首版完全相同文件的行追溯、两阶段渲染与缓存。
4. 在真实 GitLab 测试项目验证后更新 README，再评估差异区块映射与跨项目自动归属。

以下是后续验收计划，尚未执行；GitLab client 已预留可注入 HTTP transport，不依赖个人 token：

| 场景 | 预期 |
| --- | --- |
| MR 内 A、B 分别修改两行，squash 为 S | 两行分别展示 A、B，列表包含完整 C，悬停保留 S。 |
| H 文件与 S 有目标分支同期改动或冲突改写 | 首版只展示 S 和提交列表。 |
| squash 后插行、改名、未保存编辑 | 使用历史路径和 sourceLine；新改动行保持未提交。 |
| MR 多页提交、关联 MR 多候选、数据截断 | 完整分页才判断；歧义和不完整数据不替换归属。 |
| 源分支删除、H 对象消失、跨项目 MR | 能读对象则继续；不能读则降级，保留可取得列表。 |
| 快速切行、切仓库、换 HEAD、换令牌 | 旧响应不覆盖当前标注，也不污染新认证缓存。 |
| 401/403/404/429/超时、非 GitLab 仓库 | 普通 blame 正常，网络按规则退避。 |
| 缓存命中后在同一行来回移动 | 无重复 HTTP，现有文档缓存仍有效。 |

真实验证必须包括同项目 squash、删除源分支、合并前 rebase、目标分支并行修改、fork MR，记录 GitLab 版本及脱敏响应。当前尚未连接 GitLab 实例，H 的保留情况和提交关联接口在各合并方式下的表现仍待验证；不能用 mock 测试替代这项验收。
