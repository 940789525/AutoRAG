# AutoRAG 本地二次开发

本目录保存本机 Docker 开发配置、操作记录、无敏感测试文档和验证证据。当前默认不传递任何主机模型凭据。

已完成 FastEmbed 日常部署：`autorag-xsy-dev-dev-1` 使用 `autorag-xsy-dev:2.11.1-fastembed`，复用原有五个数据卷。完整模型问答使用 TUI 中已有的登录和模型选择；部署验证不调用远程对话模型。

本机开发配置已关闭可选远程 rerank；embedding 保持本地。可选 fsearch-cli 尚未安装，文件名搜索使用文件系统遍历。主机原有 Node 和 AutoRAG home 保持原状。

## 启动和进入

以下命令在 WSL Ubuntu 执行：

```bash
cd /home/xsy/projects/AutoRAG
bash myself_dev/dev.sh up -d --no-build --pull never
bash myself_dev/dev.sh ps
bash myself_dev/dev.sh exec dev bash
```

也可以直接从 WSL 打开 TUI：

```bash
bash myself_dev/dev.sh exec dev bun src/cli/index.ts tui
```

容器自动启动本地 CPU FastEmbed/Qwen 服务，并保持开发环境存活。服务以 `--offline` 复用本克隆 `/workspace/.autorag/embedding-models` 的已验证模型，不复制到 Docker 卷，也不在启动时下载。该目录必须保留；只有修改 Dockerfile 时才需要重新构建镜像。查看进度：

```bash
bash myself_dev/dev.sh logs --tail 50 dev
```

## 容器内运行

```bash
# 依赖或锁文件变化时执行；首次部署会由操作人员执行。
bun install --frozen-lockfile

# 构建后用 Node 运行
bun run build
node dist/cli/index.js lite status --json
node dist/cli/index.js lite retrieve "Who approves refund exceptions?" --json

# 使用当前 TS 源码进入交互界面
bun src/cli/index.ts tui
```

首次问答请在 TUI 中使用 `/login`，随后用 `/model` 选择已授权模型。凭据仅保存在专属 home 卷，请勿粘贴到聊天、Git、配置说明或操作日志。使用远程对话模型时文档片段可能进入模型请求；默认只检索本目录的无敏感测试文档。

## 修改代码

源码挂载在 `/workspace`，保存后立即可见。Bun 源码运行需重启程序；Node 运行 dist 则先 `bun run build`。解析 worker 等依赖构建产物的代码也需重新构建。普通源码修改无需重建镜像。

开发检查使用 `bun run check && bun run lint && bun run typecheck`，以及覆盖改动的测试。`check` 会修改文件，应在你有意整理代码时执行；首次部署的自动检查将放在容器临时副本中，以保留现有行尾差异。

复用首次部署的隔离检查：

```bash
bash myself_dev/dev.sh exec dev bash myself_dev/check-in-copy.sh
```

重新验证纯向量检索及原文来源：

```bash
bash myself_dev/dev.sh exec dev node myself_dev/verify-retrieval.mjs
```

## 路径与持久化

| 容器路径 | 用途 |
|---|---|
| `/workspace` | 当前仓库，可写挂载 |
| `/documents` | 本目录 fixtures，只读挂载 |
| `/workspace/node_modules` | Docker 依赖卷 |
| `/workspace/dist` | Docker 构建产物卷 |
| `/dev-home` | 专属用户状态卷；配置、Pi 登录、会话 |
| `/dev-home/.cache` | 专属模型/下载缓存卷 |
| `/data/workspace` | 解析镜像、AutoRAG 索引和任务状态卷 |
| `/workspace/.autorag/embedding-models` | 直接复用克隆内已有的 Qwen ONNX 与 Kiwi 缓存 |

`AUTORAG_HOME=/dev-home/.autorag`；`AUTORAG_CONFIG=/dev-home/.autorag/config.fastembed.json`。原 `config.json` 保留用于回退；`--workspace` 不能替代这两个变量的隔离。

使用非 root UID/GID 1000:1000，限制 4 CPU、8 GiB 内存。无需显卡、端口映射、Redis、MySQL；不挂载主机 HOME 或 Docker socket。

## 停止与恢复

```bash
# 停止本项目服务，保留全部数据卷
bash myself_dev/dev.sh stop

# 恢复
bash myself_dev/dev.sh up -d
```

普通重建容器保留数据卷。不要执行 `down -v`，它会删除本项目的数据、登录状态和模型缓存。

详细过程与当前验证结果见 `操作记录.md`，失败诊断保留在对应 `.log` 文件中。

日常容器的 FastEmbed 切换、存储复用及真实查询记录见 [2026-10-31 日常部署证据](../docs/qa/daily-deployment-2026-10-31.json)。
