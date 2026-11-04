# GitHub PR 分析：剩余人工步骤

2026-11-04 收尾：取消与断连已补真实 Pi→MCP 子进程测试；新增用量日志覆盖回答、压缩、Jev 判断及问题拆解。自动检查与正式人工审签分别记录。历史样本不因本轮代码改动自动升级为通过，也不补填不存在的历史 token。

## 1. 核对已准备的回答与证据

本机已生成两份离线材料：

- `.omo/evidence/github-review-ready-2026-11-04/p6/review.html`：8 次 direct/codemode 冷、热问答。
- `.omo/evidence/github-review-ready-2026-11-04/ci/review.html`：PR #2034 的失败 CI 分析。

用浏览器打开 HTML。每例包含问题、完整回答、编号来源及捕获的 MCP 原始返回，展开即可逐项核对。先看冻结 SHA 和采集时间；当前 GitHub 网页可能已经变化，不用现在的网页状态覆盖历史快照。

1. 事实是否与捕获返回一致，空列表是否仅被解释为“该次查询范围内未取得记录”。
2. 每个编号是否真的支持对应文字，关键结论是否遗漏来源。CI 的 PR→SHA→run→job 必须一致；断言报错不能被写成已证明的改动根因。
3. P6 配对两侧的提交、讨论与 CI 数据是否可比。失败 CI 是独立案例，不把它算成 direct/codemode 配对。

同目录的 `reviews.pending.json` 没有预填通过。复核后填写真实 `reviewer`、ISO 格式 `reviewedAt`，并按每个 caseId 填写：

- `businessReview`: `PASS` 或 `FAIL`。
- `ciReview`: CI 案例填 `PASS` 或 `FAIL`；原本无需失败 CI 的样本保留 `NOT_APPLICABLE`。
- `citationsChecked`、`citationsValid`：你实际检查及有效的引用数量；`unsupportedClaimCount`：无依据关键结论数。
- `comparable`: 只有确实核对两组数据可比时，P6 两侧才填 `true`；独立 CI 案例保留 `false`。

可以把复核结果告诉当前聊天，由代理登记；不需要自行操作命令。若选择自行登记，在 Node 24+ 的隔离 QA shell 中运行：

```bash
make qa-shell QA_MODEL_ENV=
node scripts/manual-qa/run-qa-github-mcp.mts \
  --review .omo/evidence/github-review-ready-2026-11-04/p6/report.json \
  --reviews .omo/evidence/github-review-ready-2026-11-04/p6/reviews.pending.json
node scripts/manual-qa/run-qa-github-mcp.mts \
  --review .omo/evidence/github-review-ready-2026-11-04/ci/report.json \
  --reviews .omo/evidence/github-review-ready-2026-11-04/ci/reviews.pending.json
```

登记前校验 runId 和报告 SHA-256；待填表、错配报告、自动检查失败及未核对的引用不能变成人工通过。只修改材料副本，原始证据保持不变。

材料可离线重新生成，输出目录必须不存在或为空且不含同名文件：

```bash
node scripts/manual-qa/run-qa-github-mcp.mts \
  --prepare-review .omo/evidence/p6-pure-b7b2369c/p6.json --output /tmp/github-p6-review
node scripts/manual-qa/run-qa-github-mcp.mts \
  --prepare-review .omo/evidence/p03-business-result.json --output /tmp/github-ci-review
```

## 2. 补新版本的真实全流程用量

历史 `fullPipelineTokens: null` 无法事后恢复。当前会话没有 runner 所需的 `GITHUB_MCP_TOKEN` 或模型凭据，因此没有执行新一轮远程模型调用。提供明确的读取凭据和可用模型引用后，代理可继续执行。

在支持的隔离 QA 容器中，由操作者通过安全的环境变量输入 GitHub 读取凭据、所选模型的认证；配置只写环境变量引用，不复制日常 `auth.json`，不把 token 写进 argv、仓库或聊天。Codex OAuth 模型可使用 runner 已有的 `AUTORAG_QA_CODEX_ACCESS` 内存注入方式；其他模型沿用 `apiKeyEnv`。模型引用文件格式见 [接入说明](github-pr-analysis.md)。

```bash
node scripts/manual-qa/run-qa-github-mcp.mts \
  --model /tmp/github-qa-model.json \
  --manifest docs/examples/github-pr-usage-sample.json \
  --compare --repeats 1 --stop-on-error \
  --output .omo/evidence/github-pr-new-usage.json
```

样本采用已合并的公开 PR #2083；清单是历史冻结值，运行前仍由 probe 验证 SHA。若已变化，先重新核对事实并另存清单，不覆写历史数据。完成后对新报告使用 `--prepare-review` 生成并审签。

每例的 `pipelineUsage` 汇总同一次查询内的 `answer_session`、`pi_compaction`、`jev`、`query_decomposition` 事件；新日志使用 `search_started.usageVersion: 1` 标记采集范围。未报告用量、失败或缺少完整查询边界时，总量保持 `null`。Jev 不返回缓存拆分及价格时，这两项分别保持未知；能够合计 token 不代表能够合计金额。外部工具及提供方内部重试没有独立计费采集，不据此宣称通用成本或速度收益。

旧报告保持原样。新报告的自动检查和人工复核均通过后，再更新任务的真实评测及正式验收状态。
