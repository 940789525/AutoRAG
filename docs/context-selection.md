# 多轮证据追加去重与容量整理（实验功能 v2）

v2 保留完整召回结果，正常请求只处理尚未发送的新候选，保留已经发送给模型的历史视图。相同本地证据再次命中且其完整正文仍在当前上下文中时，新工具结果使用短引用；接近容量时批量整理旧候选正文，然后继续稳定追加。

产品默认关闭。显式 `adaptive` 使用 `append-context-v2-evidence-read-experimental`；这取代 v1 的“每次请求重选全部历史、保留最新副本”。请求结构和本地 QA 的验证结果见 [IMPLEMENTATION](../myself_dev/1026/IMPLEMENTATION.md)；真实回答质量、实际 KV 命中和多轮成本仍须独立验收，不能以 mock provider 的请求字节数宣称性能收益。

## 配置与迁移

在实际启动读取的可信配置中合并以下片段，不要覆盖共享配置：

```json
{
  "contextSelection": {
    "mode": "adaptive",
    "evidenceBudgetTokens": 6000
  }
}
```

| 模式 | 行为 |
| --- | --- |
| 不配置／`off` | 保持既有模型输入路径，已有容量保护仍生效 |
| `observe` | 计算假设选择／去重／整理，不改变 off 的模型输入，不提交真实可见状态 |
| `adaptive` | 实际执行 v2 新后缀投影、精确去重和容量整理 |

API 使用 `new AutoRAGAgent({ contextSelection: { mode: "adaptive", evidenceBudgetTokens: 6000 }, ... })`。预算必须为正安全整数；未知字段／模式报错，模型工具参数和文档正文不能修改可信配置。

**6000 的语义在 v2 改变了**：它是同一用户问题中新呈现本地候选的共享软预算，跨 baseline 和后续工具请求累计，包含新增正文、引用和省略说明；保留的历史前缀不再被每轮裁到 6000。明确的工具补取、全量问题和必要原文可能超过软预算，日志显示超支。模型容量上限始终独立生效。

本地调试配置是否显式开启以该配置内容为准；本改动不重写 `.vscode/index-debug.config.json` 或共享 `~/.autorag`。已有 adaptive 用户需要理解上述版本迁移；旧 v1 数字不能当作 v2 验收。

## 正常多轮效果

```text
第一轮已发送：旧消息[A 全文、B 全文]
第二轮召回：B、C
第二轮请求：旧消息[A 全文、B 全文] + 新工具结果[B 短引用、C 全文]
第三轮召回：B、D
第三轮请求：保留此前已发送的模型消息 + 新工具结果[B 短引用、D 全文]
```

这是实际模型消息视图稳定，原始工具结果和原始聊天记录也保留。短引用直接指向较早的完整正文，不引用另一条短引用；正文很短、引用反而更长时保留正文。

精确身份使用证据 ID、source、chunk ID、原始正文及版本指纹；不能只因为 ledger 登记过、向量相同、路径相同或正文相似就省略。不同来源、版本、否定、日期、金额和部分重叠块保留各自正文。原始空白不同但展示格式压成相同文本时，身份无法唯一核验的结果保守透传。

精确去重不依赖问题分类、向量或 Rerank：全量问题、steering 或启用 Rerank 不会自动禁止安全去重。v1 分差／MMR 仅用于新普通事实候选的独立选择；复杂／全量问题绕过语义裁剪。显式读原文、非本地资料和普通用户文本不做自动正文去重。

## 请求与生命周期

1. 对照原始消息身份，复用上次已成功消费的模型视图前缀。
2. 本问题记忆只追加一次，不前置替换旧记忆；准备新候选和短引用。
3. 达到容量阈值时集中整理。
4. 执行现有容量 guard 与 provider 输入限制。
5. 核验完整锚点；必要时补回正文并再次检查容量。无法安全发送时返回明确诊断，不发送悬空引用。
6. 在实际 stream 边界确认最终消息，在成功响应时提交视图；失败或取消不提交草稿。

Pi compaction 成功、分支历史改变、模型／系统／工具／思考参数改变会使旧前缀失效并重新建立 epoch。手动 compaction 仍由既有 Pi 路径处理，不会在 context 回调里调用会中断当前 operation 的 `session.compact()`。摘要模型用量单独记录。

独立搜索结束、取消后的未提交计划、`/new`、ledger reset、runtime dispose 按各自生命周期清理。恢复会话不能证明旧正文实际可见时保守重发，不凭磁盘 ledger 的 eN 重建锚点。状态有界，不另建长期证据数据库。

## 容量整理

首轮开发初值为安全输入容量的 **80% 触发、60% 为目标**；已声明的更严格请求字节限制也参与检查。容量基准沿用原有 guard 的输出预留与安全余量，包含系统、工具声明、记忆、历史和新消息，未知容量明确记录。

首版不增加摘要模型。集中省略较旧的可靠本地候选正文，保护当前活动问题已使用、新结果仍依赖或新用户问题明确点名的证据；相关旧短引用也同步清理为省略状态。原始来源和会话保留，正文再次命中时可以重新提供。非本地内容、显式读原文等不由新整理器压缩，仍占容量。

无法达到低水位但请求合法时可以发送并记录未达目标；没有可移除内容时不反复空整理。必要上下文本身超限时明确失败。现有最后保护可能进一步裁剪，最终引用检查以实际输入为准。

整理会破坏一部分旧缓存前缀，这是显式 epoch 边界；之后保留新前缀。前缀稳定仅保留缓存复用的机会，不保证 provider 开关、TTL、路由或缓存粒度满足命中条件。

## 观测口径

`logs/runs.jsonl` 中 `context_selection` 分阶段记录 selection／prepared／dispatch／commit／abort，包含 requestId、策略版本、epoch、前缀变化原因、完整正文数、短引用数、新证据估算、预算超支、整理前后量和有界修复。跨 stage 的相同请求不能重复累计收益。

`candidateCount` 是映射到的候选出现次数，不是公开 API `resultCount`。`prefixBytes` 是应用层前缀指标，不是实际 cache hit。observe 的 hypothetical 只表示假设计划；prepared 才是实际请求观测。

`model_usage` 区分 `answer_session` 和 `pi_compaction`，分列 input、cacheRead、cacheWrite、output、total、cost、响应耗时和首个文本 delta 时间。后者是单个模型响应的时间，不是整段用户问答的端到端耗时。规划／Jev 等未被此 seam 覆盖的调用仍需单独汇总；不得将 answer_session 当全部成本。归一化 token 前要核对 adapter 是否已把缓存计入 input，避免重复累计。缺失记 null，不当作零收益。

默认日志不新增正文、向量或凭据。原始错误路径与诊断遵循错误透明原则，不被原因枚举替代。

## 验证

设计、编号需求、测试矩阵和发布门槛见 [SPEC](../myself_dev/1026/SPEC.md)、[VALIDATION](../myself_dev/1026/VALIDATION.md)。新增 `test/agent/context-append.test.ts` 验证正常追加、完整锚点、回退、容量和 epoch；实际 provider seam 的多轮及 Pi compaction 集成测试位于 `test/agent/context-selection-session.test.ts`。

在具备依赖和本地 Qwen3／1024 嵌入后端的隔离开发容器中：

```bash
bun run check && bun run lint && bun run typecheck
bun run build
node scripts/manual-qa/run-qa-context-selection.ts .omo/evidence/context-append-v2-local.json
```

脚本自行隔离 AutoRAG／Pi 配置并清理临时目录，记录默认配置前后哈希，不启动或停止已有 daemon。它使用真实本地嵌入和模拟回答 provider，检查单轮选块、三轮五次实际请求前缀和引用，**不测真实回答质量或实际 KV 命中**。

不带 `--sessions` 的 `scripts/bench/context-selection.ts` 仍是 v1 新候选离线 A–F 分析。`--sessions` 则进入真正多轮生成实验，不能混用两者结果。120 题合成 fixture 也不是经独立复核的多轮盲测集。真实模型质量、缓存费用和延迟收益未通过对应门槛前，不宣传“节省 X% / 加速 Y%”。


## 按需恢复完整本地证据

模型可调用 `read_local_evidence({ evidenceId: "e2" })`，读取本分支此前由本地原生索引产生的完整块，包括 Pi compaction 后正文已不在模型上下文的情况。工具独立于投影模式，本地 off／observe／adaptive 都可用；Telegram／Discord、Lite MCP 和 profiles 不新增此接口。

只接受可信 `[eN]`，不接受路径。定位保留在现有 session ledger 的可选字段中，最多 1024 个；保留的是身份和指纹，不是新的全文快照。每次读取重新检查当前 roots／exclude／scope、源文件与解析镜像 SHA256、索引 profile 和精确 chunk ID／正文；变更、权限失效、旧会话无定位、索引缺失或版本不明时明确失败。普通网页／数据源结果、公开 metadata 和 ledger 的 2000 字符摘录不能提供此能力。

读取只访问已有本地索引和文件，不调用 embedding、语义检索、refresh、下载或索引创建。单块 UTF-8 正文最多 64 KiB，超限拒绝完整返回；显式读取本次保留全文，最终 provider 请求再次校验，容量 guard 截断时安全失败，不能误称 `complete: true`。旧解析镜像没有 SHA256 时必须显式强制 refresh 后重新检索，读取不会隐式迁移。

真实多轮实验使用 30 段合成会话、六类场景与按资料族划分的 12 dev／18 test。默认只预检；显式授权运行既有模型：

```bash
node scripts/bench/context-selection.ts --sessions --run-real \
  --split dev --limit 12 --repeats 3 --variants A,B,C,D,E,F \
  --auth-dir /path/to/existing/pi/agent \
  --output .omo/evidence/context-sessions-real.json
```

可用 `AUTORAG_QA_TOKENIZER_PATH` 指定已有 Qwen tokenizer 目录。脚本隔离 AutoRAG／Pi 状态，只使用合成语料与已选定的 API-key 模型，不刷新 OAuth、不切换 provider；检查共享配置与认证文件 hash。B 缺少冻结历史 v1 时标记 blocked。C／D／E 是内部基准干预，不新增产品配置；F 仅增加读取工具与必要声明。报告保留失败、缺失 usage、实际缓存读写、schema 指纹、逐次模型用量和按 case 配对统计。单 case 的重复试验不生成独立样本置信区间。目录价格估算不是账单；词项命中也不是独立事实／引用质量评分。

正式质量非劣、缓存状态和完整费用证据不足时维持默认 off，不宣传节省或加速比例。最新实际执行记录见 1026 的 IMPLEMENTATION。
