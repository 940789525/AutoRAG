# 索引任务与 TUI MCP 操作入口

TUI 命令、自然语言工具、CLI 与 MCP 调用同一索引任务服务。索引过程不依赖对话模型；自然语言只负责把请求转成已授权的结构化参数。

本章所有 `autorag.index.*` 工具和 `/index` 子命令均为拟新增接口，不是当前可执行命令。

## 索引服务接口

建议新增 `src/indexing/jobs.ts`，复用 `AutoRAGAgent.refresh`、`AutoRAGLite` 的无模型能力、`refresh-progress.ts` 与 `IndexEvent/IndexReport`。任务服务依赖可注入的刷新执行器，不能为 MCP 再创建一个对话 agent。

| 操作 | 参数 | 行为 |
|---|---|---|
| `start` | `mode`、`embeddingProfile`、`scopeIds`、`requestId` | 检查权限和 profile，持久化任务并返回 jobId，后台执行 |
| `status` | 可选 jobId | 返回指定任务，或当前工作区最近任务与已激活索引状态 |
| `cancel` | jobId | 申请协作取消，返回是否受理；终态后再确认最终状态 |

`mode` 仅取 `build` / `refresh`。`build` 为指定 profile 建立候选索引，不删除现有已激活索引；无变化且已有相同 profile 时可复用，需明确显示复用。`refresh` 只更新当前已激活 profile；要求别的 profile 时返回“需要 build”，不隐式迁移。灾难性强制删除/重建不在首版工具接口内。

`scopeIds` 只能引用可信配置中的文档根或连接 ID，不接收任意路径、URL 或 shell 命令。省略表示已配置的本地文档根，**不自动包含所有原生数据源**。首版写任务仅支持本地文档；原生 datasource 仍走各自既有入口，语义消费者适配见 [04](04-MinSync移除与兼容迁移.md)。

为避免局部 build 被误认为全库完成，首版若显式传 `scopeIds`，必须等于当前配置的全部本地文档根集合；否则报不支持局部任务。manifest 记录这组根的稳定身份与作用域指纹，根集合变化要重新 build。将来再扩展局部刷新或多索引覆盖管理，首版不隐式实现这些能力。

`embeddingProfile` 是已配置 profile ID。`build` 缺省选择可信配置默认值；任务启动时快照其完整配置与版本，后续修改不影响运行中任务。`refresh` 缺省使用激活索引绑定的 profile，而不是新配置的默认值。

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

不新增常驻队列服务。任务由发起它的长期 TUI/MCP 进程持有；进程正常退出时申请取消、等待当前安全边界、持久化结果。外部客户端断开不自动撤销已成功创建的任务，前提是 MCP server 本身仍存活。进程崩溃不承诺自动恢复执行；重启后标记 interrupted，允许新 refresh 利用 journal 和缓存恢复。

跨进程 `status` 读取同工作区持久化状态。跨进程取消可写入原子 cancel 标记，由 owner 在每个阶段/批次前以及不超过 1 秒的轮询中触发 AbortController；标记携带 jobId 与 owner instance，避免误取消后来的任务。若 owner 不存活，返回 interrupted，而不是假称取消成功。只允许同工作区受信主体执行。

## 取消语义

- 将 AbortSignal 从任务传到解析、embedding HTTP、批循环和索引写入安全边界。
- 已提交的完整文档保留；正在准备但未提交的文档不得出现半套 chunk。
- 取消 build 不激活候选 profile；清理或保留候选残留按报告说明，默认保留可重用部分。
- 取消 refresh 可能留下已完成的增量更新，结果需报告，不宣称全部撤销。
- HTTP 取消不保证远端未计费；ONNX 正在运行的计算也未必可立即中断。
- 重复 cancel 对终态返回当前终态，不改写已完成报告。

## 候选索引激活

模型切换使用 `build`：在独立 profile 下完成索引与本地一致性检查，再原子切换激活 manifest。仅全部必需文档成功、向量验证通过、基础查询自检通过才切换；失败或取消继续使用旧 profile。

候选构建期间，查询固定旧 profile 的实例与元信息，不能因为默认 embedding 配置改变就使用新模型查询旧向量。新查询实例切换与激活指针使用同一代版本；在途查询允许完成于旧版本。旧证据 handle 若按现有规则失效，应明确提示重新检索，不能指向同 ID 的新内容。

激活 manifest 至少包含 profile、语义/索引指纹、维度、代版本、就绪状态。沿用现有 `ready.json` 的具体 schema 需写迁移测试。当前管线会写 partial 标记，因此必须先改造候选构建的激活时机，不能仅在外围多放一个成功提示。

普通 refresh 的原子性以完整文档为单位；部分失败时状态 degraded，保留真实失败清单。此规则不等于候选 build 可以部分失败后切换。

## TUI 命令

```text
/index build --embedding local-zh
/index build --embedding api-example
/index refresh
/index status
/index status --job JOB_ID
/index cancel --job JOB_ID
```

`--embedding` 使用 profile ID，不接受 API key。API profile 未授权或凭据缺失时，在发送第一批正文前报错。若已有不同模型索引，build 提示需要重新向量化及当前数据边界，不清除旧索引。

命令入口无需登录对话模型；embedding API 仍需它自己的凭据。前台显示 jobId、阶段、已处理/已嵌入/缓存复用、耗时与最后错误。退出 TUI 提示本进程任务将取消并执行安全收尾，不暗示退出后继续后台运行。

现有 `/embedding on|off|toggle|status` 和 Ctrl+Shift+E 需同步改造为新服务生命周期入口；不能保留隐藏的 MinSync 启动逻辑。`/mcp` 仍由 Pi 管理连接，不用它代替索引状态命令。

## 自然语言

支持的意图示例：“用本地模型给已配置的文档目录建索引”“用已配置 API 更新索引”“查看索引进度”“取消刚才的索引任务”。

流程：输入路由先判定操作意图，进入受限操作工具路径，再调用同一 start/status/cancel。不能先走检索预取，否则首次没有索引时可能在执行建库意图之前失败。

明确命令可确定性解析；自然语言使用已有对话模型路由为结构化参数。没有对话模型时引导使用 `/index`，不得假装自然语言解析仍可用。模糊的“索引这批文件”只有在作用域可确定时执行；未配置目录或未授权 API 需要明确补充，不能让模型擅自开启远程发送。

正文、文件名或检索命中中的指令不能成为 profile 授权来源。已有搜索进行时，索引命令应由独立命令路由处理，不被误当成搜索 steering；写任务与查询共享资源上限并保持界面可响应。

## MCP 工具契约

首版在现有 `src/mcp/server.ts` 增加普通工具：`autorag.index.start`、`autorag.index.status`、`autorag.index.cancel`。注册名遵循仓库已有 `autorag.*` 风格；Pi 暴露给模型的名称可能另加前缀，以实际工具列表为准。

start 输入示例：

```json
{
  "mode": "build",
  "embeddingProfile": "local-zh",
  "scopeIds": ["documents"],
  "requestId": "client-request-001"
}
```

start 成功响应示例：

```json
{
  "ok": true,
  "jobId": "index-job-001",
  "state": "queued",
  "embeddingProfile": "local-zh"
}
```

status 返回 `state`、`phase`、计数、耗时、配置/激活 profile、partial、错误与报告引用；cancel 返回 `accepted` 和当前 `state`。这些是应用业务字段，不冒充 MCP 标准 Tasks 数据结构。

普通短请求先返回 jobId，客户端用 status 轮询。可在活跃请求协商了 progress token 时桥接进度；原请求返回后，后续进度不再伪装为该请求的持续通知。不要靠单个 `autorag.refresh` 长调用无限延长超时。

MCP 2025-11-25 的标准 Tasks 仍为实验能力且需要能力协商；首版不依赖它，未来可把既有 job 包装成协议 Tasks。[MCP Tasks 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

`readOnly` 模式只允许 status，不注册 start/cancel；服务端独立检查 workspace、profile、远程授权和并发。工具注解不是权限机制，不能因 Pi 展示了工具就绕过业务检查。

Pi 1.4.0 支持 stdio 与 Streamable HTTP 的 MCP 连接。[Pi MCP 文档](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md) AutoRAG 当前封装只读受信 Pi agent 目录的 `mcp.json`，不能直接推定上游项目级配置也生效；本方案不需要放宽项目配置边界。

AutoRAG 原生 TUI 直接调用任务服务，无需启动一个 MCP 子进程调用自己。其他 MCP 客户端通过现有 AutoRAG MCP server 使用同样能力，首版优先测试 stdio。

## 外部 MCP 客户端配置示意

下面面向运行在开发容器中的另一个 MCP 客户端，使用现有 stdio 服务入口；新工具只有实施后才存在。需先构建 dist，并在示例独立目录准备可信配置和目录权限。客户端若运行在宿主机，必须改成其可访问的 Node/程序/配置路径，不能照抄容器路径。

```json
{
  "mcpServers": {
    "autorag-index": {
      "command": "node",
      "args": ["/workspace/dist/mcp/index.js"],
      "env": {
        "AUTORAG_HOME": "/data/workspace/embedding-demo-home",
        "AUTORAG_CONFIG": "/data/workspace/embedding-demo-home/config.json",
        "AUTORAG_MCP_READ_ONLY": "false",
        "AUTORAG_MCP_TOOLS": "autorag.index.start,autorag.index.status,autorag.index.cancel"
      }
    }
  }
}
```

这些环境变量在当前 `src/mcp/index.ts` 已有读取入口；新增工具仍需注册和服务端校验。API 凭据通过客户端受信的环境注入能力传给 server，不填入此 JSON 的字面量。stdio 的 stdout 只能用于协议，服务日志写 stderr 或任务报告，避免 Python 子进程日志破坏协议通道。
