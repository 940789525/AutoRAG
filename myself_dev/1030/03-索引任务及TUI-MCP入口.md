# 索引任务与 TUI 操作入口

本阶段由 TUI 命令和自然语言原生工具直接调用同一 AutoRAG 内部索引任务模块。索引过程不依赖对话模型；自然语言只负责把请求转成已授权的结构化参数。本阶段不新增 MCP 功能，现有 CLI/程序入口只保持兼容并按需复用共享索引逻辑。

本章 `/index` 子命令、内部任务接口和自然语言原生工具均为拟实现能力，不是当前已可用功能。start/status/cancel 是 TypeScript 内部方法，不是 MCP 工具或新增网络 API。文件名保留历史命名以维持已有链接，正文以本阶段范围为准。

## 内部索引任务接口

建议新增 `src/indexing/jobs.ts`，复用 `AutoRAGAgent.refresh`、`AutoRAGLite` 的无模型能力、`refresh-progress.ts` 与 `IndexEvent/IndexReport`。任务模块依赖可注入的刷新执行器，不创建额外的对话 agent、MCP 服务或独立任务守护进程。

| 操作 | 参数 | 行为 |
|---|---|---|
| `start` | `mode`、`embeddingProfile`、`scopeIds`、`requestId` | 检查权限和 profile，持久化任务并返回 jobId，后台执行 |
| `status` | 可选 jobId | 返回指定任务，或当前工作区最近任务与已激活索引状态 |
| `cancel` | jobId | 申请协作取消，返回是否受理；终态后再确认最终状态 |

`mode` 仅取 `build` / `refresh`。`build` 为指定 profile 建立候选索引，不删除现有已激活索引；无变化且已有相同 profile 时可复用，需明确显示复用。`refresh` 只更新当前已激活 profile；要求别的 profile 时返回“需要 build”，不隐式迁移。灾难性强制删除/重建不在首版工具接口内。

`scopeIds` 只能引用可信配置中的文档根或连接 ID，不接收任意路径、URL 或 shell 命令。省略表示已配置的本地文档根，**不自动包含所有原生数据源**。首版写任务仅支持本地文档；原生 datasource 仍走各自既有入口，语义消费者适配见 [04](04-MinSync移除与兼容迁移.md)。

为避免局部 build 被误认为全库完成，首版若显式传 `scopeIds`，必须等于当前配置的全部本地文档根集合；否则报不支持局部任务。manifest 记录这组根的稳定身份与作用域指纹，根集合变化要重新 build。将来再扩展局部刷新或多索引覆盖管理，首版不隐式实现这些能力。

`embeddingProfile` 是已配置 profile ID。`build` 缺省选择可信配置默认值；任务启动时快照其完整配置与版本，后续修改不影响运行中任务。`refresh` 缺省使用激活索引绑定的 profile，而不是新配置的默认值。

首版本地默认 profile 为 `local-qwen3`，运行 `Qwen/Qwen3-Embedding-0.6B`、1024 维；`api-example` 仅为待配置且明确授权后可选的网上 API 示例。BGE 不作为首版任务选择项自动创建或下载。

`requestId` 在同一工作区、调用主体内幂等：相同 ID 和参数返回原 jobId；相同 ID 不同参数报冲突。进行中的不同请求若竞争同一工作区，返回忙碌与现有 jobId，不创建无界队列。

## 状态与持久化

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelling -> cancelled
queued -> cancelled
进程意外退出后的 queued/running/cancelling -> interrupted
```

`queued` 仅表示本进程即将执行的短暂状态，不代表拥有持久后台调度系统。部分文档失败的任务为 `failed`，报告附 `partial:true` 与已完成数量，不能以 `succeeded` 掩盖失败。

每个任务记录 jobId、requestId、workspace ID、owner instance ID、PID、时间、配置指纹、目标/激活 profile、状态、最后事件、计数、原始错误与报告路径。首版可存放于工作区 `.autorag/index-jobs/`，写入用临时文件加原子替换，持久化格式带版本。索引报告和来源路径只向拥有该工作区权限的调用方开放。

单写者保护要覆盖解析镜像更新、增量判断、向量写入和激活指针切换，不能仅保护 LanceDB 最后写入。复用现有 lease 的跨进程能力；如现有作用域不够，在编排层扩展。崩溃后依据 owner 身份、锁和进程存活信息处理孤立任务，不能仅以 PID 相同认定任务仍在运行。

不新增常驻队列服务。任务由发起它的 TUI 进程持有；进程正常退出时申请取消、等待当前安全边界、持久化结果。现有 CLI/程序调用若复用任务模块，也由自身进程负责生命周期，不引入客户端断开后继续执行的后台服务。进程崩溃不承诺自动恢复执行；重启后标记 interrupted，允许新 refresh 利用 journal 和缓存恢复。

`status` 可以读取同工作区持久化报告，但首版 `cancel` 只控制当前进程拥有的任务，直接触发其 AbortController。其他进程仍存活时返回忙碌及 owner 信息，不能误取消或停止它；owner 已退出的孤立任务标记 interrupted。跨进程取消信箱、外部客户端控制和断线语义放到后续独立设计，不作为本阶段实现要求。跨进程单写者锁仍必须保留。

## 取消语义

- 将 AbortSignal 从任务传到解析、embedding HTTP、批循环和索引写入安全边界。
- 已提交的完整文档保留；正在准备但未提交的文档不得出现半套 chunk。
- 取消 build 不激活候选 profile；清理或保留候选残留按报告说明，默认保留可重用部分。
- 取消 refresh 可能留下已完成的增量更新，结果需报告，不宣称全部撤销。
- HTTP 取消不保证远端未计费；ONNX 正在运行的计算也未必可立即中断。
- 重复 cancel 对终态返回当前终态，不改写已完成报告。

## 候选索引激活

模型切换使用 `build`：在独立 profile 下完成索引与本地一致性检查，再原子切换激活 manifest。仅全部必需文档成功、向量验证通过、基础查询自检通过才切换；失败或取消继续使用旧 profile。

首次从 MinSync 迁移到 FastEmbed 时，模型仍为同一 Qwen，但首版也通过 `build` 重新向量化并建立新 profile，避免直接继承未经验证的旧向量。已是 FastEmbed 的同一 profile 后再做增量更新，才使用 `refresh`。旧 MinSync profile 的可查询性受旧版运行环境约束，回退边界见 [04](04-MinSync移除与兼容迁移.md)。

候选构建期间，查询固定旧 profile 的实例与元信息，不能因为默认 embedding 配置改变就使用新模型查询旧向量。新查询实例切换与激活指针使用同一代版本；在途查询允许完成于旧版本。旧证据 handle 若按现有规则失效，应明确提示重新检索，不能指向同 ID 的新内容。

激活 manifest 至少包含 profile、语义/索引指纹、维度、代版本、就绪状态。沿用现有 `ready.json` 的具体 schema 需写迁移测试。当前管线会写 partial 标记，因此必须先改造候选构建的激活时机，不能仅在外围多放一个成功提示。

普通 refresh 的原子性以完整文档为单位；部分失败时状态 degraded，保留真实失败清单。此规则不等于候选 build 可以部分失败后切换。

## TUI 命令

```text
/index build --embedding local-qwen3
/index build --embedding api-example
/index refresh
/index status
/index status --job JOB_ID
/index cancel --job JOB_ID
```

`--embedding` 使用 profile ID，不接受 API key。API profile 未授权或凭据缺失时，在发送第一批正文前报错。若已有不同模型索引，build 提示需要重新向量化及当前数据边界，不清除旧索引。

对首次迁移显示“保留 Qwen 模型，替换推理引擎并重建索引”；如需准备 ONNX 制品，说明这是同模型文件准备，不显示为切换到 BGE。旧模型缓存不自动删除。

命令入口无需登录对话模型；embedding API 仍需它自己的凭据。前台显示 jobId、阶段、已处理/已嵌入/缓存复用、耗时与最后错误。退出 TUI 提示本进程任务将取消并执行安全收尾，不暗示退出后继续后台运行。

现有 `/embedding on|off|toggle|status` 和 Ctrl+Shift+E 需同步改造为新服务生命周期入口；不能保留隐藏的 MinSync 启动逻辑。现有 `/mcp` 连接管理保持原功能，不是本阶段索引操作的入口或前置条件。

## 自然语言

支持的意图示例：“用本地 Qwen 模型给已配置的文档目录建索引”“用已配置 API 建立索引”“更新当前索引”“查看索引进度”“取消刚才的索引任务”。从本地切到 API 要走 build；API profile 已激活后的更新才走 refresh。

流程：输入路由先判定操作意图，进入受限的 Pi/AutoRAG 原生操作工具路径，再直接调用同一内部 start/status/cancel。原生工具在当前进程注册，不通过 MCP 暴露，也不要求 `mcp.json`。不能先走检索预取，否则首次没有索引时可能在执行建库意图之前失败。

明确命令可确定性解析；自然语言使用已有对话模型路由为结构化参数。没有对话模型时引导使用 `/index`，不得假装自然语言解析仍可用。模糊的“索引这批文件”只有在作用域可确定时执行；未配置目录或未授权 API 需要明确补充，不能让模型擅自开启远程发送。

正文、文件名或检索命中中的指令不能成为 profile 授权来源。已有搜索进行时，索引命令应由独立命令路由处理，不被误当成搜索 steering；写任务与查询共享资源上限并保持界面可响应。

## 任务结果与 TUI 进度

内部 start 成功后返回 jobId 与初始状态；TUI 订阅已有 IndexEvent，在当前进程持续展示阶段和计数，不依赖 MCP progress。status 返回 state、phase、计数、耗时、配置/激活 profile、partial、错误与报告引用；cancel 返回是否受理和当前状态，最终以任务终态为准。

任务模块独立检查工作区、profile、作用域、远程授权和并发。TUI 命令与自然语言原生工具不能绕过相同的参数及权限校验；显示某个工具不代表允许任意发送语料。

## 现有 MCP 兼容边界

项目现有 MCP 客户端、服务端和 `autorag.refresh` 等工具不因本阶段被主动移除或扩展。仅当共享配置、类型或旧方法别名迁移使已有调用回归时，做最小兼容修复，维持既有只读/授权边界及错误行为。

本阶段不新增 `autorag.index.start`、`autorag.index.status`、`autorag.index.cancel` MCP 工具，不新增 MCP server，不要求外部客户端配置，不实现 MCP progress/Tasks 桥接，也不升级 MCP 协议或 SDK。这里的限制不影响 TUI 使用内部同名职责的方法。

## 后续 MCP 扩展

将来确有外部 AI 客户端操作索引的需求时，再通过独立任务给既有内部 start/status/cancel 增加 MCP 包装。届时另行确定工具名、schema、外部权限、进度、跨进程控制及服务生命周期，并补客户端测试。本阶段不预先冻结这套对外契约，不把该扩展作为向量化或 TUI 的依赖。
