# 在开发容器中体验论文研读收件箱

现在选择 **“AutoRAG：调试 TUI”并按 F5**，会同时启动论文研读服务和 TUI。TUI 会等待 API 和数据库就绪，再显示界面。两个调试进程使用独立终端，停止组合调试会一并停止它们；独立数据库保留数据。

## 当前环境直接使用

1. 在 VS Code **已连接开发容器、打开 `/workspace`** 的窗口中，选择“AutoRAG：调试 TUI”，按 F5。
2. 在 TUI 输入 **`/research`**，打开中文菜单。
3. 首次选择“首次建库（只登记现有论文）”。在“导入进度”查看，完成后资料库进入可研读状态；这一步不会调用研读模型。
4. 在“研究主题”中新增主题，输入具体研究问题、关注维度和排除内容。
5. 体验存量论文：进入“论文库与补读”，选择已就绪论文版本和研究主题。体验增量导入：把新 PDF 放入宿主机 `myself_dev/fixtures`（容器内为 `/documents`），服务会自动发现，也可选择“扫描新增论文”。
6. 在“研读任务”查看阶段、错误、取消或重新研读；完成后在“查看研读卡片”中阅读卡片及原文证据，并标为已读/稍后读，反馈有用性和相关性。

阅读器支持 ↑↓、PgUp/PgDn、Home/End；Esc 或 q 返回。卡片和证据使用只读组件显示，不写入聊天记录，也不会因打开卡片而发起模型请求。

状态栏显示 `/research` 和未读数量。没有卡片是正常的：首次建库不会对存量论文自动跑模型，新主题也不会自动回读全库。可以先手动补读一篇。

研读使用独立服务读取的 AutoRAG 配置及共享 Pi 账户/默认模型。当前开发配置 `.vscode/research-debug.config.json` 已明确设置 `allowModelProcessing: true`。用户选择研读、或在主题存在后导入新论文时，论文摘录会发送给该已配置模型。若尚未登录或没有可用模型，先在 TUI 中 `/login`、`/model`，再重试失败任务。不要把临时会话中的模型选择理解为向服务传递了模型或凭据。

## 已准备好的基础环境

本次已经运行宿主初始化脚本，启动独立 PostgreSQL 18 服务，并验证连接成功。没有重启原开发容器或已有 MinSync daemon。正式开发资料库仍为空，留给用户从菜单初始化。

数据库密码随机生成，保存在宿主机用户状态目录的私有文件，以及开发容器 `/dev-home/.autorag-research-dev/postgres-password` 中。配置中只有环境变量和文件引用，`launch.json` 不含密码。数据库不发布宿主端口。

以后迁移或重建环境时，在 **宿主 WSL**、仓库根目录运行一次：

```bash
node scripts/dev/setup-research.mjs
```

脚本复用已有密码和数据库卷，启动独立数据库，准备容器内密码文件，并复用现有的公开 tokenizer 缓存。它不挂载 Docker socket 到开发容器，不修改共享 `~/.autorag/config.json`。第一次启动新的开发容器仍需要先安装项目依赖。

## 调试项

| 名称 | 用途 |
|---|---|
| AutoRAG：调试 TUI | 日常使用：组合启动研读服务和带收件箱的 TUI |
| AutoRAG：调试论文研读服务 | 单独调试 API、索引和 DBOS 工作流 |
| AutoRAG：仅调试 TUI（无论文收件箱） | 保留原有独立 TUI 的使用方式 |
| AutoRAG：调试索引（逐条向量化） | 保留原有索引调试 |
| AutoRAG：索引测速（正常批处理） | 保留原有索引测速 |

组合启动的 TUI 内部配置使用 `--research-url http://127.0.0.1:8765`。也可以为已有服务运行：

```bash
node src/cli/index.ts tui \
  --config /workspace/.vscode/index-debug.config.json \
  --research-url http://127.0.0.1:8765
```

如果启动失败，先查看“论文研读服务”终端中的具体错误。数据库未准备时，在宿主机重新执行初始化脚本；8765 端口被已有研读进程占用时，停止自己之前的调试会话后再启动组合项。程序不会自行结束其他会话的进程。

## 实现及验收

- TUI 扩展：`src/agent/research-inbox.ts`；HTTP 客户端：`src/research/client.ts`。
- API 新增 `/research/v1/overview`，用于主题、未读计数、最近任务和导入进度；执行中的研读任务优先显示。
- 客户端只连接 HTTP loopback，拒绝外部地址及重定向；写操作携带幂等键。原始后端错误会显示出来。
- 定时状态刷新随 TUI 会话关闭而停止，旧会话的迟到响应不会更新新界面。
- 使用隔离账户和临时 workspace 的真实终端验收，已经打开 `/research` 中文菜单；未向模型发送真实论文进行质量验收。
- 自动验收覆盖菜单操作、只读证据视图、反馈、补读、取消/重试、真实 PostgreSQL/DBOS 及进程中断恢复。验收数据库与开发数据库分开，测试完成后删除。

在开发容器中重复运行相关验收：

```bash
AUTORAG_RESEARCH_DATABASE_URL=postgresql://research@research-db:5432/autorag_research \
AUTORAG_RESEARCH_DATABASE_PASSWORD_FILE=/dev-home/.autorag-research-dev/postgres-password \
node scripts/manual-qa/run-qa-research-tui.mjs
```

这里的连接串没有密码，脚本只读取私有密码文件。原有 HTTP API 与 MVP 边界仍见 `docs/research-inbox.md`；本次增加的是 TUI 接入，没有制作网页前端。

本次最终验收：10 个相关测试文件、107 项测试全部通过；`check`、`lint`、`typecheck`、`build` 均通过。原有七条 Biome 信息级建议保留。

## 首次建库时选论文后又回到菜单

论文名称会先登记，再完成解析和向量化；出现在列表中并不代表已经可研读。整批首次索引完成前，没有可用版本，因此不会提交研读任务。

现已改为在列表标明“索引未就绪”，点击后显示持续停留的说明，并提供“查看导入进度”。进度页显示解析数量、向量化批次大小、最近进展和批次耗时，不估算虚假的完成百分比。本页是快照，Esc 返回后重新打开刷新。研读任务成功提交后也会显示确认界面，可直接进入任务进度。

正在运行的调试进程不会自动加载这些源码修改。若已有首次建库在进行，可先让它完成，之后再重启调试项使用新的提示。本次回归共 110 项测试通过。
