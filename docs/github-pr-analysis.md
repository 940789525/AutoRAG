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

自动检查核对调用路径、引用是否存在、预期事实、实际 PR/head SHA，以及读取日志前是否已取得同仓库且对应目标 SHA 的 run/job。自动通过只设置 `automaticChecks: PASS`，样例总体状态仍为 `NOT_RUN`，等待人工事实和引用复核；失败保持 `FAIL`。远程数据发生变化的配对不能用于性能结论，不能把单次演示或模拟模型写成真实模型完成率。

## 2026-11-03 续开发与人工接续

本轮补齐 `review_threads`、`/runs/<id>` 证据来源和分页未读提示；严格化本地接口夹具，纠正 `list_workflow_jobs` 的工具与参数归属。只读目录/schema/协议由已安装的 MCP SDK 做受控探测，Pi 会话工具目录等待后台连接就绪后再检查。探测请求与模型业务调用分开记录，均不包含认证 headers。

仅验证真实服务、不调用模型时，在隔离 QA 容器内执行：

```bash
node scripts/manual-qa/run-qa-github-mcp.mts --probe-only \
  --manifest /tmp/github-qa-public-samples.json \
  --output /workspace/.omo/evidence/github-pr-probe.json
```

仍需安全注入 `GITHUB_MCP_TOKEN`。样本必须包含 `version: 1`、明确公开的 PR URL、完整 40 位 head SHA 和非空 `expectedText`。失败 CI 样本另加 `ci: { "runId": <真实数字>, "jobId": <真实数字>, "failureText": "<日志原文>" }`。真实值必须在运行前核验，旧报告中的 ID/SHA 不能默认仍有效。

人工复核可在运行结束后离线登记，不需要重新执行模型或提供认证。复核文件只记录对应报告的真实 runId 和 caseId，例如：

```json
{
  "runId": "<报告中的 runId>",
  "cases": {
    "<样本ID>/0/codemode/cold": {
      "businessReview": "PASS",
      "ciReview": "PASS",
      "comparable": true,
      "citationsChecked": 3,
      "citationsValid": 3,
      "unsupportedClaimCount": 0
    }
  }
}
```

以上为格式示例，不能代替实际审查。没有要求失败 CI 的样本允许 `ciReview: NOT_APPLICABLE`；要求的 CI 样本不能这样豁免。复核不允许覆盖自动检查失败。`comparable` 需确认两组 PR/SHA、讨论和 CI 数据可比后填写。

```bash
node scripts/manual-qa/run-qa-github-mcp.mts \
  --review /workspace/.omo/evidence/github-pr-comparison.json \
  --reviews /tmp/github-human-reviews.json
```

只有两组均通过自动检查、人工业务/CI 复核且确认可比的配对才进入性能指标。报告按 cold/warm、direct/codemode 分开保存逐阶段 usage、缓存 token、调用数、延迟和引用有效率。原有路由/规划成本尚未完整测量，总 token 成本继续保持 null，不能据此宣称全流程节省。

本地检查每个子命令最多等待 60 秒，服务探测每个请求超时 15 秒；这是 QA 的执行边界，不改变产品会话或模型轮次。没有凭据时直接 SKIP，不启动远程调用。最初一轮 141 项测试及检查记录见 [续开发验证报告](qa/github-pr-follow-up-2026-11-03.json)。原先在宿主环境失败的九项 MCP 测试，在独立无网络 Docker 中全部通过；不将宿主差异当作产品缺陷修补。

Docker 恢复后，真实模型调用暴露了一个兼容缺陷：进度说明逻辑向 grammar 约束的 `codemode` 添加必填 `i` 字段，违反单字符串输入合同，导致模型请求发出前失败。现已在 `intent-tracing.ts` 保留 grammar 工具的原始声明，并让 headless/TUI 回归使用提供方实际的 grammar 校验函数。修复后 check、lint、typecheck、build 与 12 个文件的 149 项测试均通过。

当前账号的 `openai-codex/gpt-6.1-sol` 已在独立容器中通过冷发现调试：加载分析 skill，经 codemode 发现并实际读取公开 PR #2023，标题、完整 head SHA 和最终 GitHub 来源引用核对一致，耗时约 23.5 秒。其中一次错误的发现调用由模型自行纠正，记录中保留失败。普通 PR #2034/CI 分析达到 75 秒总时限后停止，未保存完整答案或工具轨迹，不记为业务通过，也没有重复运行。日常认证与配置摘要前后一致，只清理本次创建的容器。详见 [真实调用与修复记录](qa/github-pr-codemode-live-2026-11-03.json)。

## 2026-11-04 失败 CI 验收

公开 PR #2034 的固定样本在 [样本清单](examples/github-pr-ci-public-sample.json)。使用前述隔离步骤并安全注入 GitHub 只读凭据后，可以单独验证 PR 的 head SHA、失败 run、该 run 中的失败 job 和日志尾部原文。任何一层身份不匹配都会终止后续探测。

```bash
node scripts/manual-qa/run-qa-github-mcp.mts --probe-only \
  --manifest docs/examples/github-pr-ci-public-sample.json \
  --output .omo/evidence/github-ci-probe.json
```

模型验收每次业务提问限时 60 秒，到期调用 `agent.abort()` 并将该案例记为失败。模型请求、工具开始和结束、超时以及清理事件逐条写入输出文件旁的 `<output>.<runId>.events.jsonl`。即使测试进程被外部终止，已经写出的事件也可以用于定位。CI 样本的最终答案必须有指向指定 job 的引用。

本轮在当前代码回放了七类真实 MCP 返回，逐个核对了证据编号与来源。随后在隔离容器内用当前账号的 6.1 sol 完成了 PR #2034 的在线分析。GitHub 工具在 5.4 秒内就绪，含就绪时间共用 53.5 秒。AutoRAG 通过 codemode 成功读取 GitHub 11 次，将 PR 提交与失败 run、job 对应，并引用了目标 job 的真实测试日志。该案例的自动检查通过，业务与 CI 结论的正式人工复核尚未执行。完整回答和 10 条编号来源见 [P0–P3 验证记录](qa/github-pr-p0-p3-2026-11-04.json)。

## 阶段记录与限制

早期实现记录使用 `codex/observable-local-index` 的 `3d97c44e6b0f53aac4b1f5d675d528ea86c93902`。本轮继续当前分支 `codex/github-pr-analysis-local-index`，HEAD 为 `52da4df6e307f92eaefd72b2e8ddb72210dd6d0c`；修改尚未提交，没有切换或同步分支，未改动其他未跟踪的开发材料。

| 阶段 | 本次实现 | 真实验收状态 |
| --- | --- | --- |
| P0 接入契约 | 只读配置、独立 SDK 探测与目录/schema/协议记录 | 官方服务与五个只读工具已验证，两个公开 PR/SHA 已核验；失败样本的 PR、run、job 和日志已逐层核验 |
| P1 最小场景 | TUI/headless 装配、skill 加载与 grammar 参数兼容修复 | 真实 6.1 sol 冷发现与单 PR 读取通过；PR #2034 普通业务自动检查通过，实际终端演示待补 |
| P2 证据引用 | JSON/结构化/diff/log、review_threads、CI /runs/ 来源、分页诊断和会话恢复 | L1/L2 通过；真实 PR 标题/SHA 到最终来源引用已验证，七类真实返回回放通过，完整回答的逐项人工复核待补 |
| P3 PR/CI 流程 | skill、严格接口夹具，以及 SHA/run/job/事实验收检查 | PR #2034 完整分析与真实失败日志自动检查通过；业务与 CI 人工复核及其他场景待补 |
| P4 调用证据 | QA 观察器、逐阶段 usage、隔离摘要与离线人工复核 | 最小真实调用和 PR #2034 成功运行都有父子事件，旧超时运行没有完整轨迹，全流程成本仍未知 |
| P5 回归 | check、lint、typecheck、152 项相关测试和 build 通过 | 最小模型链路通过；不宣称全套测试或完整业务 E2E 已通过 |
| P6 对照 | 配对运行、混组检测、人工复核门禁和指标汇总 | SKIP：没有 direct/codemode 的有效配对结果，不宣称性能收益 |
| P7 交付 | 实现、测试、配置示例与本页操作说明 | 仍待补齐以上真实验收，不能标记整个方案完成 |

既有 live-E2E 场景不启用 GitHub MCP；本次没有更改默认本地检索、embedding、数据源身份或公共答案 schema。相应回归仍需覆盖默认无 MCP 路径；GitHub 场景的端到端证据由本页专用 runner 生成。未运行模型冷/暖 live E2E，不沿用既有绿灯作为新功能证明。

不新增运行时依赖，不修改 embedding、许可清单或安全治理政策。当前不支持 GitHub Enterprise、commit-only 分析、跨仓库自动调查、本地资料联合分析或自动触发。
