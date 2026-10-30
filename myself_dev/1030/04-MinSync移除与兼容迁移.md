# MinSync 运行依赖移除与兼容迁移

当前工作区本地检索已经使用 AutoRAG 索引管线，移除重点是默认 embedding、生命周期、旧初始化路径及所有共享消费者。只改文档检索或删掉一个包，不能算完成。

## 代码影响范围

| 范围 | 当前入口 | 目标 |
|---|---|---|
| 默认 embedder | `src/embedding/index.ts`、`managed.ts`、`daemon.ts`、`in-process.ts` | 新配置工厂直连本地 FastEmbed/API；清除 MinSync 探测和 native 动态加载 |
| 配置转换 | `src/embedding/settings.ts`、`src/cli/config.ts`、`src/minsync/types.ts` | 新 schema + 旧配置迁移；普通 embedding 类型不再归属 MinSync |
| 索引方法注册 | `src/indexing/method.ts`、`src/agent/agent.ts` | 新 `local-vector` 名称；旧 `minsync` 别名映射相同实现且不重复注册执行 |
| 增量索引与状态 | `src/indexing/pipeline.ts`、`lease.ts`、`journal.ts`、`src/agent/refresh-progress.ts` | 保留算法与恢复能力，增加 profile 激活和任务编排 |
| TUI 与 setup | `src/agent/embedding-controls.ts`、CLI setup/status/doctor 路径 | 改服务归属、健康和安装指引；不再调用 MinSync 安装器或控制命令 |
| MCP | `src/mcp/server.ts`、`src/mcp/index.ts`、`src/agent/mcp-client.ts` | 统一任务工具；旧 refresh 方法名转换并明确失败 |
| 公共导出 | `src/index.ts`、`src/core.ts`、CLI 方法枚举 | 文档化弃用策略，不能保留可继续执行 MinSync 的导出 |
| 运行镜像与安装包 | `package.json`、`bun.lock`、`NOTICE`、`scripts/ci/qa.Dockerfile`、安装与发布脚本 | 移除相关运行依赖、下载和校验；增加批准的新依赖与模型锁定 |
| 开发部署 | `myself_dev/Dockerfile`、`compose.yaml`、`healthcheck.mjs`、`1027/compose.research.yaml` | 替换本克隆的启动/健康检查，保持卷与研究流程可用 |
| 技能与 QA 文档 | `skills/autorag*`、`docs/minsync-setup.md`、`scripts/live-e2e/`、`AGENTS.md` 中 MinSync QA | 替换当前流程和验收标准，历史材料显式标注 |

上表是已定位入口，不是删除文件清单。实施前用 `rg` 追踪导入和调用，确认同文件中的分块、source 映射或工具代码是否仍需保留。依赖变更、后端变更与新增依赖审批遵循仓库要求；本次说明文件不执行这些变更。

## 必须迁移的共享消费者

| 消费者 | 风险与要求 |
|---|---|
| 本地文档及混合检索 | 新查询向量与索引 profile 一致；BM25、vector、hybrid 仍可选；source 必须指回可读取原文 |
| 检索记忆 | 使用共享 Embedder；模型/语义指纹变化使旧向量不可用，保留文本和判断证据，显式重建或降级词法检索 |
| Telegram、WhatsApp、Slack、Kakao sidecar | 各自 SQLite 向量更新遵循身份失效规则；不能凭本地文档的 API 授权自动发送聊天内容 |
| Gist 语义索引 | 补语义指纹校验和重建；HTTP 失败透明呈现 |
| Obsidian | 已走 LocalDocumentIndex；清理 MinSync 类型/锁/目录命名依赖，保持 `/obsidian/...` 来源身份 |
| Research 工作流 | `src/research/runtime.ts` 目前按 `minsync` 找索引方法并刷新 parsed/minsync；迁移名称但保留 local-index 与证据读取能力 |
| discrawl | 目前按 `backend === daemon` 判本地；适配 local-http，避免把本地端点误判为远程或错误要求真实 API key |
| lazykatok | 外部 CLI 依赖 OpenAI endpoint，当前环境映射未传 query/passage 前缀；必须核对实际 CLI 能力，不能假称任意模型都可共享 |
| mailcrawl | 支持 OpenAI/TEI 与前缀透传；检查本地分类、API opt-in 与 key 环境变量引用 |
| Hister | 目前只接受本地 daemon 的 OpenAI endpoint；调整为受信 local-http，仍保持本地边界，外部配置只经明确同步操作修改 |

相关入口还包括 `src/datasource/embedding-env.ts`、`src/datasource/skills/discrawl/embedding.ts`、`src/datasource/skills/hister/embedding.ts`。实施前逐个查找 `describeEndpoint`、`EmbeddingIdentity` 和共享 embedder 注入点。

外部 CLI 如果不支持当前模型的角色前缀，不得悄悄使用语义不一致的向量。首版选择其原有独立配置，或明确关闭该连接的语义部分并显示诊断；要宣传“共享本地模型可用”，必须先补适配并通过 native-store 验收。不能替用户重写原生数据源存储。

## 兼容配置规则

| 旧配置 | 处理 |
|---|---|
| 只有 `minSync.embedder` 的 OpenAI/TEI endpoint | 可转换为新 profile，保留既有端点、模型、前缀和凭据引用；远程发送仍检查原可信 opt-in，缺少则禁用 |
| 默认 native MinSync 或完全未配 embedder | 显示需要准备本地 FastEmbed；不能把旧 Qwen 向量当成新模型结果 |
| 新旧配置同时存在且不一致 | 返回冲突及精确字段，要求显式迁移，不静默选一方 |
| MinSync 独有配置 | 列出不支持/已弃用字段，不假称 CDC、P2P 等仍生效 |
| 旧 `--method minsync` / `syncMinSync` | 过渡期映射到本地向量索引，输出弃用提示；不得执行二进制或 addon |

转换过程先生成预览/新文件并验证，明确写入后才替换。备份只包含配置引用，不复制凭据值或正文。已有索引与解析镜像不因配置转换自动删除。

公共 API 若 `createMinSyncClient` 等无法提供等价兼容，应在迁移版本中明确废弃/移除并给替代入口，不保留运行时 MinSync 作为隐藏兼容实现。涉及破坏性删除时按仓库版本策略发布；可调用的旧别名只能转入 AutoRAG。

## 索引与模型迁移

旧 Qwen/MinSync、FastEmbed 中文候选、网上 API 属于不同向量空间，即使维度偶然相同也不混用。复用原文解析产物的前提是解析版本和映射未变；向量以内容与语义指纹重新判断。

新 profile 建在 `.autorag/local-index` 内独立目录，旧 profile 保留。当前全局 ready 指针与上下文缓存需要改造，使 build 失败时旧索引继续可查。激活流程详见 [03](03-索引任务及TUI-MCP入口.md)。

记忆、sidecar 等各自存储不会与文档库天然全局原子切换：每个消费者必须拒绝不匹配向量，并显示待重建/词法降级。不得用文档库 build 成功冒充所有消费者已迁移完成。

## 分阶段退出与回退

1. 保存本克隆配置引用、活动索引指纹和依赖版本证据。不要读取/复制真实私有语料作为测试 fixture。
2. 在隔离配置下接入 FastEmbed 和 API，仍保留旧代码以便对比，但新后端不调用 MinSync。
3. 完成任务入口、模型切换和所有已启用消费者测试，再移除生产依赖、安装器和 daemon/native 路径。
4. 在无 MinSync 的镜像中重新执行完整验收，才宣布运行依赖移除完成。
5. 若验收失败，保持旧发布版本/隔离配置作为回退；新版本失败时不能自动启用旧 MinSync。

回退有两个边界：同一新版程序回到保留的、兼容的新 profile；或整体回到旧版程序和对应旧配置/索引。若新版已删旧模型实现，不能仅切旧配置就保证旧 Qwen 索引恢复查询。

不卸载机器共享的 MinSync，不删除 `~/.cache/minsync/models`，不停止其他克隆的 daemon，不清理别人的卷。后续删除旧索引、缓存或本机旧程序均为单独的显式操作，不混入索引迁移。

## 如何判定移除完成

“运行依赖移除”允许历史说明和弃用别名出现 MinSync 字样，但默认/本地/API 路径不能下载、加载、启动或调用它。最终依赖树、构建产物引用与进程执行审计都要验证。

“名称完全移除”是另一个兼容性收尾阶段，需要去掉旧配置、CLI、方法名、导出及相应测试。首版可以先完成运行依赖移除，但必须列出剩余别名，不能宣称仓库零引用。
