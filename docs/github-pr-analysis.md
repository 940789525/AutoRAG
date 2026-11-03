# GitHub PR 问题与变更分析

本功能基于 Pi 已有的 MCP 客户端和 codemode，通过用户配置的 `github` 只读连接读取 PR、明确关联的 Issue、diff、评论以及当前提交的 CI/日志。入口是明确的 `https://github.com/OWNER/REPO/pull/NUMBER`。不会因 commit/push 自动触发，不提供合并、评论、重跑 CI 或修改代码功能。

## 实现与职责

- Pi：认证、连接、工具发现、QuickJS/codemode、嵌套调用事件和取消。
- GitHub 官方 MCP：提供远程只读工具及实际业务结果。
- AutoRAG 新增 `github-mcp-evidence.ts`：检查可信工具身份，识别支持的返回格式，将实际来源/片段登记到已有 EvidenceLedger；同步保留模型显示内容和 codemode 收到的 MCP 结构化对象。
- `github-pr-analysis` skill：指导 PR → 提交 SHA → diff/评论/Issue → CI run/job → 日志的查询顺序、部分失败和答案范围。存在启用的用户级 `github` 配置时，由两类 Pi 会话的资源加载器加载打包 skill，不依赖项目目录自动扫描。
- AutoRAG 原有 ledger、答案推导、编号和交互会话持久化：把实际 `[eN]` 转为原有结果/映射；不引入第二套答案 schema 或中央索引。

普通搜索和 TUI 都装配适配器。TUI 的引用持久化沿用现有会话机制。没有启用的 GitHub 连接时，不增加网络调用、模型轮次或工具。

证据支持 JSON text、嵌套结构化对象、纯文本 diff/log，以及 Actions 的 `workflow_run`、`workflow_job`、`workflow_jobs` 和 `logs_content`。长内容分片记录范围，不将片段当成完整内容。PR 文件页是经核验 PR 身份派生的定位，标明已观察的 head SHA；纯文本日志必须先有真实 job 浏览器 URL。未知/空/错误结果保留原文，不伪造成功证据或下载链接。

Actions 字段依据核对过的[官方工具实现](https://github.com/github/github-mcp-server/blob/main/pkg/github/actions.go)与[返回类型](https://github.com/github/github-mcp-server/blob/main/pkg/github/actions_types.go)。这不能替代目标账号实际服务的 `tools/list` 验证；远程工具仍可能变化。

## 配置和使用

需要操作者提供 GitHub 读取凭据及可用模型认证。token 通过 `GITHUB_MCP_TOKEN` 注入，配置只保存变量引用。不要把 token 粘贴到聊天、命令行参数或 Git 文件中；不要复制日常 `auth.json` 到测试环境。

示例配置：

- `docs/examples/github-mcp.codemode.json`：默认方式，模型写脚本，经 Pi 调用 MCP。
- `docs/examples/github-mcp.direct.json`：同样的服务和只读工具，供对照评测使用。

日常正式启用时，将 `mcpServers.github` 合并到指定 Pi 用户目录的 `mcp.json`，保留原配置；示例文件不会自动覆盖用户配置。仅服务端只读模式和所选工具限制这个 MCP 连接，不宣称整个 Pi/bash/其他连接都只读。

在已准备好的隔离 TUI 中，输入：

> 请分析这个 PR 解决的问题、主要修改和讨论中的未决事项。如果当前提交的 CI 失败，读取实际失败日志说明位置。给出可核对的来源，无法读取的部分直接说明：`<真实 PR 链接>`。

冷发现调试可另外明确要求“先在 codemode 发现 PR 读取工具并输出发现结果，再读取 PR 标题”。发现工具不等于读取 GitHub。

## 隔离检查和真实验收

使用仓库支持的 Docker QA 环境。脚本在导入 Agent 前创建独立 HOME、AutoRAG home/config、Pi agent/session 目录，记录日常配置前后 SHA-256；退出时只移除自己的临时状态并关闭自己的客户端。不会停止已有 embedding、数据库、TUI 或其他容器进程。

在容器的 `/workspace` 执行本地检查：

```bash
node scripts/manual-qa/run-qa-github-mcp.mts --checks \
  --output /workspace/.omo/evidence/github-pr-analysis.json
```

它依次执行 check、lint、typecheck、相关合同/集成/回归测试和 build。没有真实凭据/样本/模型引用时，L3、L4、对照评测明确记为 SKIP，本地检查照常执行。

真实验收还需两个由操作者准备的公共测试输入文件：

1. 模型引用配置（`--model`），只允许顶层 `model`，字段沿用现有配置 schema，例如：

```json
{
  "model": {
    "provider": "openrouter",
    "id": "<实际可用且支持工具调用的模型 ID>",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

2. 冻结样本清单（`--manifest`）。链接、SHA 和预期事实须人工核验，以下是格式占位，不是已完成的真实样本：

```json
{
  "version": 1,
  "samples": [
    {
      "id": "public-pr-with-ci-failure",
      "public": true,
      "url": "https://github.com/OWNER/REPO/pull/NUMBER",
      "headSha": "<冻结的真实 head SHA>",
      "expectedText": ["<经人工核对的事实>"],
      "debug": false
    }
  ]
}
```

在容器同一进程环境中安全注入 GitHub 和模型环境凭据后：

```bash
node scripts/manual-qa/run-qa-github-mcp.mts \
  --model /tmp/github-qa-model.json --manifest /tmp/github-qa-public-samples.json \
  --compare --repeats 3 --output /workspace/.omo/evidence/github-pr-comparison.json
```

每个配对使用独立会话，记录 cold/warm 两次任务，重复间交替 direct/codemode 顺序。direct 会停用 codemode，并通过真实调用事件检查混组；两组都记录替代路径。显式冷发现调试用单独的 `debug: true` 样本运行，不与 direct 比较混合。

报告保留父子调用 ID、业务参数、脚本文本/输出、耗时、原错误、证据和原有运行日志。认证 headers/环境值不采集。实际 GitHub 请求按 MCP 执行事件计数，不能把发现函数或一个父脚本当作全部业务请求。model usage 原始记录保留；无法证明包含全部路由/规划成本时，总 token 成本保持 null。

自动状态只检查调用路径和引用结果是否存在。真实业务验收还必须人工核对 PR/head SHA、CI run/job 关联、失败日志、事实和引用支持关系；`businessReview`/`ciReview` 默认 NOT_RUN。远程数据发生变化的配对不能用于性能结论，不能把单次演示或模拟模型写成真实模型完成率。

## 阶段记录与限制

实现基线按用户要求为 `codex/observable-local-index`，基线提交 `3d97c44e6b0f53aac4b1f5d675d528ea86c93902`，未改动其他未跟踪的开发材料。

| 阶段 | 本次实现 | 真实验收状态 |
| --- | --- | --- |
| P0 接入契约 | 保留官方远程只读配置，支持的结果形状有合同测试 | SKIP：环境没有 GITHUB_MCP_TOKEN，实际工具目录/协议/公开 PR 夹具尚未冻结 |
| P1 最小场景 | TUI/headless 的 MCP 调用与 skill 加载已由 L2 验证 | 真实模型冷发现/业务提问 SKIP |
| P2 证据引用 | JSON/结构化/diff/log、真实 ID、结果映射、交互会话恢复 | L1/L2 验证；真实服务 SKIP |
| P3 PR/CI 流程 | skill 和真实 MCP 协议夹具覆盖顺序、并发部分失败与 CI 引用 | 真实失败日志案例 SKIP |
| P4 调用证据 | QA 观察器、隔离运行报告、配置摘要和清理收据 | 夹具调用有实际父子事件；真实服务记录 SKIP |
| P5 回归 | check、lint、typecheck、相关测试和 build | 不宣称全套测试或模型 live E2E 已执行 |
| P6 对照 | 配对运行/分组检测/原始测量设施 | SKIP：没有实际模型/GitHub 样本测量，不宣称性能收益 |
| P7 交付 | 实现、测试、配置示例与本页操作说明 | 仍待补齐以上真实验收，不能标记整个方案完成 |

既有 live-E2E 场景不启用 GitHub MCP；本次没有更改默认本地检索、embedding、数据源身份或公共答案 schema。相应回归仍需覆盖默认无 MCP 路径；GitHub 场景的端到端证据由本页专用 runner 生成。未运行模型冷/暖 live E2E，不沿用既有绿灯作为新功能证明。

不新增运行时依赖，不修改 embedding、许可清单或安全治理政策。当前不支持 GitHub Enterprise、commit-only 分析、跨仓库自动调查、本地资料联合分析或自动触发。
