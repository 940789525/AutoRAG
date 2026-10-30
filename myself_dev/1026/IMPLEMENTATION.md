# v2 开发计划与实现／验收记录

修订日期：2026-10-27。当前有效规格为 SPEC 的 V2-R01—V2-R28；原门槛保留。**用户后续已授权正式实现，按需恢复与真实实验入口已落地；最新代码阶段记录如下，旧文档阶段与旧 v2/v1 数字仅作历史追溯。完整发布门槛尚未通过。**


## 后续验收补齐（执行中）

最新模型接入：已通过 **Pi ModelRuntime 与实际 AutoRAG 工具循环** 两层验证，`openai-codex/gpt-6.1-sol`、`thinking.low`。E/F 各一段四轮对话均完成，F 一次补读、零读取错误；证据为 `.omo/evidence/context-completion-gpt61-runtime-smoke.json`。此前直接 compat API 的 OK 仅作连通诊断，第一次将 OAuth access 当 API-key 的 smoke 失败记录保留，不计通过。修复采用调用方显式注入只读 CredentialStore，原 API-key 路径保持兼容；不写 auth、不刷新、不转交 refresh token。

认证接入后类型检查通过；Pi session 与 credential 专项 41 项通过，主机 broker 的 3 项离线测试通过。此前全量快照 `.omo/evidence/context-completion-regression.json` 为 3352 通过、63 跳过、0 失败，不把专项数量叠加成全量数字。ER-U/ER-I 断言和证据落点见 [context-evidence-acceptance.md](../../docs/context-evidence-acceptance.md)。100 候选 selection P95 约 2.40 ms，含注册与两次 dispatch 的 CPU P95 约 18.13 ms，二者分开披露。

正式 GPT 全量实验已经启动，目录 `.omo/evidence/context-completion-gpt61-low/`，计划 30 场景 × A—F × 3；`suite.json` 与每场景 JSON 是进度事实来源。执行结束前不标全量通过。DeepSeek 的 108 条已有尝试单独保留，402 余额不足及失败费用不删除，也不与 GPT 汇总。

用户已要求直接完成截图中的三项，并选择单人自动复核、明确不宣称独立人工通过。保留当前分支及所有既有改动，起始快照 `/tmp/autorag-1026-completion-cfirsz1g`。本轮先补精确边界、读库异常、实际分支恢复、模式和入口测试；再逐项审计 ER-U/ER-I、生成来源驱动 gold 与冻结指纹、恢复留存补丁的 v1 算法、执行 30 段 A—F 三次对照。执行结果后补，不能提前标 pass。

v1 来源为留存 `.omo/evidence/context-append-v2-task.patch`，是恢复的历史 projector/selector 算法加当前通用 harness，非原应用完整历史 checkout。来源、补丁 hash、未改片段恢复依据与仅 import 适配记录在 scripts/bench/historical/provenance.json；单测验证 latest-copy 路径与当前稳定前缀行为不同。

用户复核口径确认见 VALIDATION 顶部；gold 包 docs/context-session-gold-review.md 保留独立人工未完成标记。修正了原 goldTerms 中两处与问题不对应的诊断词项（M4 要求 director、M2 最后一问要求 director），不据此调算法阈值。缓存由实际 provider 自动管理，记录真实命中与不可控条件，不清共享缓存或用 nonce 伪造 cold。

工程审计已补上 dispose 释放 locator 的真实缺口：旧代码仅清 projector，新增 ER-U15 测试先红后绿，现在 dispose 清 ledger（连带 projector），不重置已发出的全局 ID 序号。另补 UTF-8 65535/65536/65537 字节、Unicode/表格原文、当前 roots/分支、库异常、失败重试、actual Pi 三模式、single/progressive 入口与 off/observe 完整回包一致性。

真实 DeepSeek 阶段：六方案 smoke 全完成；完整计划 540 次尝试已开始，初期 3 worker 与回归并发撞到容器 512 pids 上限。只停止本任务协调器/卡住的测试进程，已开始的场景子进程自行结束；保留6场景108条记录。后续发现部分 model_error 的原始诊断为 402 Insufficient Balance，停止后续付费请求，未充值。DeepSeek 题集/实现复核记录单独保存在 context-completion-deepseek-review.json，不与新模型混算。

用户随后明确要求切换 GPT-6.1 Sol 低思考。已核对官方模型文档与已安装 Pi catalog，目标为 openai-codex/gpt-6.1-sol，thinking.fast/final=low。现有 Pi OAuth 已过期；采用有效的现有 Codex 登录只读访问，通过 stdin 在内存转交 access，不写凭据文件、不转交 refresh、不刷新或改写共享 auth。小型连接探测已真实返回 OK，原认证文件前后 hash 相同。实验只改目标，不修改日常 TUI 配置。新的模型数据重新按 A—F 全部运行并单独保存；API-equivalent 目录费用不能冒充订阅实际额度/账单。


## 2026-10-27 本轮代码交付（当前状态）

用户已明确授权按 1026 文档修改代码，并回复“允许，保留当前分支继续实现”，豁免本轮 main 同步。保留 `codex/observable-local-index` 及既有 tracked/untracked 工作；执行过 fetch，没有 checkout／合并／建 worktree。起始文件 hash 和副本位于 `/tmp/autorag-evidence-implementation-28o4s5cf`，本轮范围按该快照计算，不把 HEAD 以来的全部改动计为本次成果。

### 实现落点

| 能力 | 实际实现 |
| --- | --- |
| 可信精确读取 | `IndexStore.readChunk`、LanceDB `openExisting` 与 `LocalDocumentIndex.readEvidence`。精确 source ID + chunk ID 查询，不返回 vector，不经过 embedding context，不创建缺失表或索引。 |
| 版本绑定 | 现有 parsed manifest 增加可选 source/output SHA256，不改索引列。解析前后核验源文件与指纹，拒绝解析中变化；获取 locator 时核验源、镜像及原始切片，补读时再次核验当前版本/profile/body。 |
| 会话身份 | 只从内部 symbol 接受 local read handle，现有 session ledger 持久化可选定位，最多 1024；正文仍由本地索引提供。相同规范化 eN 对应不同原始正文/定位时取消读取授权，不悄悄改指向。旧会话与 corrupt locator 保留原 citation，保守拒绝补读。 |
| 工具与容量 | `read_local_evidence` 严格只接收 evidenceId。本地 off/observe/adaptive 均可调用；不扩 Telegram/Discord、Lite MCP 或 profiles。完整 UTF-8 正文上限 64 KiB；最终 prepared/dispatch 复核完整正文与当前 roots/scope，截断、撤销权限或分支切换时失败。 |
| Pi 生命周期 | 显式读取本次不会立刻变短引用，成功模型消费才提交可见状态。实际 Pi compaction 后仍可按本分支 eN 补读；清空/恢复依现有 ledger 生命周期，不建立全文历史库。 |
| usage | 所有模式记录 answer_session/pi_compaction；错误/缺失用量为 null，不记为免费调用。产品其他规划调用不冒充已完整计费；实验关闭 Jev、规划分解、rerank、web、memory embedding。 |
| 真实实验 | `context-selection.ts --sessions` 进入新 runner；30 段四轮合成会话，M1—M6 各五段，12 dev/18 test 按资料族分离。仅显式 `--run-real` 使用已有选定 API-key 模型，默认预检；不拷凭据、不刷新 OAuth、不切换 provider、不发送私有语料。 |
| 真实干预与统计 | A=off；C=稳定追加；D=增加精确去重；E=再增加容量整理；F=E+补读及必要 schema。C/D/E/F 的语义选择一律关闭以排除混杂。B 缺冻结历史实现明确 blocked。记录逐次 usage/缓存/费用估算/失败/schema hash，配对按 case 聚合、2000 次固定种子 case bootstrap；单 case 的三次重复不冒充三个独立样本。 |

版本为 `append-context-v2-evidence-read-experimental`，默认 off 不变；旧 manifest 缺指纹须先显式强制 refresh 再检索。没有新增 runtime 依赖、修改模型/embedding 后端、正式配置、许可证、政策或共享 home。

### 当前验证与证据边界

- 受影响模块最终专项回归：9 个测试文件、198 项通过，覆盖真实 LanceDB、长正文、三种模式、精确版本/权限/路径/分支拒绝、定位容量、最终截断、实际 Pi compact 和原追加去重。
- 仓库 check/lint/typecheck/build 在隔离副本通过；实验及 QA 脚本额外做独立 TypeScript/Biome 检查，因为默认配置未覆盖这些脚本。完整回归快照共 3381 项：3318 通过、63 跳过、0 失败（`.omo/evidence/evidence-read-regression-final.json`）。直接工作区 `bun run check && bun run lint && bun run typecheck` 也通过。之后仅统计脚本追加了失败费用汇总断言（4/4 通过），最新专项 198 项包含这项新增测试；不把重复执行相加为全量测试数。
- 本地 QA `.omo/evidence/evidence-read-local.json`：pass，真实 daemon/Qwen3-Embedding-0.6B/1024、真实索引和来源；长块超过 2000 字符，actual Pi compact 后补读完整且零额外 embedding，源更新拒绝；共享配置 hash 相同、临时根清理、既有 daemon 未动。回答 provider 为模拟，不能用于回答质量或缓存结论。
- 真实生成 `.omo/evidence/evidence-read-real-repeated.json`：DeepSeek/deepseek-flash，M1-1 dev，A/C/D/E/F 各 3 次四轮会话，共 15 段完成；B 共 3 项 blocked；F 共 6 次补读、无补读错误。完整记录 input/cacheRead/cacheWrite/output 与目录价格估算；共享配置、Pi auth/settings hash 均未变化，任务临时状态已清理。
- 该重复样例的 E→F 配对费用相对变化中位数约 **+1.08%**，A→E 约 **+0.22%**；都只有一个独立 case，不提供有意义的置信区间，不得宣称节省。F 额外工具声明与调用已包含费用。延迟受共享运行环境及 provider 波动影响，不是受控速度基准。
- M5-1 真实生命周期初次采用 Pi 缺省 20000-token 保留尾部时，六项均在第三轮因 `Nothing to compact (session too small)` 中止，保留 `evidence-read-real-lifecycle-small-session.json`。第二次在所有组统一关闭自动压缩、手动压缩只保留 1 token 的受控生命周期条件下，六项中一项 F 完成全部四轮，另五项摘要在统一的 2000 模型输出 token 上限条件下中止（随后核对发现 Pi 的 reserveTokens=1000 进一步把实际摘要上限限制为 800，而非 2000）（`evidence-read-real-lifecycle-final.json`）；5 次实际补读均成功，完成样例在压缩后回答旧阈值，并在更新后正确检索 832 credits。摘要失败及其真实费用全部保留，不算完成会话。
- 因该开发实验暴露的摘要输出预算不足，runner 统一改为最多 8192 output tokens，所有组同样适用并记录参数。追加 `evidence-read-real-lifecycle-8192.json` 后仍因实际摘要上限 800 中止。这证明仅改 model.maxTokens 不足；核对已安装 Pi `compaction.js` 的 `min(floor(0.8 * reserveTokens), model.maxTokens)` 后，将所有组 reserveTokens 统一恢复为 16384（小容量实验最多窗口四分之一），keepRecentTokens=1 仍仅用于触发短夹具手动压缩。最终结果为 `evidence-read-real-lifecycle-reserve.json`；这些不同运行配置不混合汇总。这是开发实验夹具/预算修正，不改变产品默认、选择阈值或质量门槛，不冒充盲测。
- 最终 M5-1 E/F 对照（`evidence-read-real-lifecycle-reserve.json`）：两组各 3 次、共 6 段四轮会话全部完成，12 次实际 Pi 摘要调用，F 的 11 次完整补读全部成功，更新后回答使用当前 832 credits。诊断词项全部出现，但不是独立事实/引用评分。全部 usage 与 Pi 摘要费用计入，配置/认证 hash 相同，临时根已清理。该 case 同样只有一个独立样例，且与 M1 的输出预算不同，不合并费用差异为总体收益。

当前阶段：ER-P0—P4 的核心实现、专项/全量工程回归与隔离本地 QA 已完成；ER-P5 已有真实模型开发样例三次重复数据，完整数据/独立 gold/历史 B 与受控缓存仍未完成；ER-P6 同步说明并维持实验默认 off。ER-U/ER-I 表是验收责任，不将本轮的部分样例覆盖标成所有子项逐条完成。

### 未完成的正式发布门槛

独立人工 gold/事实和引用评分尚未完成；30 段全量 A—F、冻结历史 B、受控 cold/warm 缓存、正式质量非劣和费用门槛均未通过。当前 goldTerms 仅为诊断代理，不是质量分数。M1—M6 fixture 和失败边界测试不能等同于所有 30 段真实运行；取消与未知版本等工程测试也不能冒充真实模型场景覆盖。正式 releaseGate 保持 blocked，不放宽规格、不改默认值。

已审查 live-E2E 影响：本轮增加本地 agent 工具说明与只读恢复，不改 native datasource source identity、MinSync 配置或结果输出；新增 clone-local 手工 QA 覆盖该工具与 Pi 请求入口，现有 cold/warm 证据不作为本功能证明。没有调用共享 native store，没有重跑全套 native datasource live lane，未宣传那些 lane 通过。本轮验证的是此前索引改造已采用的 AutoRAG-owned LanceDB + 本地 Qwen embedder 路径，没有生成旧 CLI `.minsync/cursor.json`，不能据此宣称旧 MinSync CLI 的逐项 live gate 全部通过。

首轮全量测试副本遗漏 `.github` 和 `legacy/uv.lock`，出现 4 个测试失败及一个文件收集错误；这是 QA 副本缺资料，不以删测试修复。已补齐只读资料重跑。旧 npm 缺失用任务临时 npm@11.6.2 解决；缺失 tokenizer_config 使用与缓存 tokenizer 同 revision 的公开配置，放任务临时路径，均不改项目依赖或真实配置。

未提交/推送/开 PR：本 checkout 缺 Git author name/email，且包含大量前序未提交修改。没有代填身份或捆绑提交其他改动；当前分支保留符合用户本轮豁免。最终可审查结果由源码、文档、测试和独立于旧工作区的范围清单 `.omo/evidence/evidence-read-change-scope.json` 提供：起始 889 文件中 26 个修改、863 个保持原字节，新增 9 文件；没有改依赖清单/锁文件或正式调试配置。

## 历史阶段：先修订规格，彼时按需恢复尚未实现

用户明确要求：如果需要修改 1026 文档，先只改这部分文件，不动具体项目代码。检查后确认旧规格仅要求“再次命中时重发正文”，没有定义主动按 eN 读取的接口、来源/版本校验、容量边界和工具方案实验。因此本轮只更新既有 README、SPEC、VALIDATION、IMPLEMENTATION，不新增本目录文件；先前代码授权不能覆盖这次分阶段要求。

新增内容为 V2-R22—R28、ER-U01—U18、ER-I01—I07、ER-X01—X05，以及独立 V2-F 工具对照。原有 v2 数据划分、质量／成本门槛、默认 off 和 v1 历史数字保留。恢复工具计划命名 `read_local_evidence`，不是当前可用功能。

### 下一轮实现顺序（全部待执行）

| 阶段 | 工作 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| ER-P0 | 按仓库 Git 流程准备代码阶段；保留原有未提交工作；检查 npm/tokenizer/本地嵌入/回答模型授权 | 代码基线和环境/授权状态明确，不自动打包他人变更或清理真实 home | 未开始 |
| ER-P1 | 先写精确读取、来源权限、完整正文和变更拒绝测试 | ER-U 的关键失败边界先有可运行断言 | 未开始 |
| ER-P2 | 扩展最小只读块查询、可信定位与版本核验 | 零新增 embedding/refresh，精确正文，缺失索引不创建；不改索引列/后端 | 未开始 |
| ER-P3 | 接只读工具、session 可选元数据、projector/guard 与模式兼容 | ER-U／ER-I、原相关回归与构建通过，无误导 complete 或提前提交锚点 | 未开始 |
| ER-P4 | 隔离真实本地 QA：命中→整理→按 ID 补读→源变化拒绝 | 来源绝对可读、hash/profile 匹配、配置前后 hash 相同与清理回执 | 未开始 |
| ER-P5 | 冻结 30 段多轮任务、真正 A—F 对照、已有模型上的 warm/cold 实验 | ER-X 和原发布门槛分别给出 pass/fail/blocked；全部 usage 与缺失范围公开 | 未开始 |
| ER-P6 | 根据实验决定保留/简化方案，同步说明和受影响 live-E2E | 不以配置启用替代验收；无证据不宣传费用/速度收益 | 未开始 |

### 当前代码差距与影响分析

- `src/indexing/types.ts` 的 IndexStore 目前只有 search、findVectors 等，没有按 source/profile/chunk 精确读取全文的只读接口；`lance-store.ts` / `pipeline.ts` 需最小补齐读取路径，不能借 query embedding 实现。
- `src/indexing/evidence.ts` 现有内部信号包含 profile/query/scope/vector；读取定位还需可靠来源与块身份、原始正文 hash、可核验版本。结果登记和可选 session 元数据一起设计，不能把公开 metadata 或模型自填内容直接当授权。
- `src/agent/evidence-ledger.ts` 的 excerpt 有 2000 字符限制，不能作为全文恢复来源；`evidence-persistence.ts` 负责分支恢复，可复用而不是另建正文库。
- `agent.ts`、检索工具包装和后续只读工具负责注册/调用时 scope、取消、统计；`context-selection-projector.ts`、`pi-session.ts`、`context-token-guard.ts`、`request-limits.ts` 负责最后可见性和提交。工具注册及必要系统提示的变化需明确版本/epoch。
- `src/observability/run-log.ts` 现有模型 usage 仅覆盖 answer_session/pi_compaction；要区分实际补读开销并核对规划/Jev 等完整费用。缺失不得当零，schema 开销不能排除在总费用外。
- 优先扩展现有 `scripts/manual-qa/run-qa-context-selection.ts`、`scripts/bench/context-selection.ts` 与现有 fixture；原 bench 是 v1 选块分析，不能只改标签变成 A—F 真实生成实验。
- 后续覆盖真实 LanceDB、工具、scope/权限、原文版本、Pi lifecycle、最终请求和旧会话兼容；同步 `docs/context-selection.md` 和必要技能说明，审查 live-E2E 影响。本轮没有修改上述源码、脚本、测试或说明。

### 本轮检查与证据边界

修改前的四份文件备份和作用域文件 hash 清单位于本任务 `/tmp/autorag-1026-evidence-spec-6njqjy8x`。这是本轮文件变更证明，不是模型实验结果。当前目录仍只保留既有四份 Markdown。

| 本轮检查 | 结果 |
| --- | --- |
| 文件范围 | 对 src/test/scripts/skills/docs/myself_dev/.vscode 共 889 个原有文件计算 hash，对照确认仅四份目标 Markdown 改动 |
| 文档结构 | V2-R01—R28、原 V2-U01—U36／V2-I01—I12、新 ER-U01—U18／ER-I01—I07／ER-X01—X05 连续唯一；相对文件链接、代码围栏与行尾空白检查通过 |
| Git 空白检查 | `git diff --check` 通过；四份目标原已 untracked，因此另外直接检查文件，未以 git diff 为空冒充目标文档无改动 |
| 项目 checks | 尝试 `bun run check && bun run lint && bun run typecheck`，退出 127：`/bin/bash: line 1: bun: command not found`；lint/typecheck 未执行，没有安装依赖或修改代码来绕过 |
| 业务验证 | 本轮不实现工具、不跑业务测试、真实检索或模型实验；新增验收全部保持待执行 |

没有执行新增工具、模型问答、缓存或成本实验，未修复 npm/tokenizer 环境；既有 136 项和 3353 项数字均属于下方此前代码快照，不能标为本轮结果。工作区已有大量 tracked/untracked 改动，四份文档原已 untracked；本次不暂存其他改动，不开 PR，不切分支、不推送。代码阶段的 Git/提交要求仍需按仓库约束处理。

## 0. 2026-10-27 既有 v2 代码实现记录（此前快照，非本轮）

用户本轮已明确授权按最新 1026 规格修改代码。本节取代下方 2026-10-26 规划中的“待开发”状态；旧记录保留作追溯，不作为新代码的验收数字。

| 需求 | 实际落点／验证 |
| --- | --- |
| V2-R02—R10 | projector 登记精确身份和可信正文边界；保留已提交视图，处理新后缀，短引用只指向完整原文；API／raw transcript 不变 |
| V2-R09／R10／R18 | prepared → dispatch → commit／abort；在实际 stream seam 核验，成功消费才提交；guard 裁掉锚点时有界补回，派发前再次验证 |
| V2-R11／R12 | 启用 v2 时记忆每个问题只追加一次；精确去重与语义选择分开；6000 仅约束本问题新增呈现，预算累计而不重选历史 |
| V2-R13—R15 | 安全输入容量／更严格字节限制的 80%／60% 初值；批量省略旧候选，保护当前问题已使用／明确点名的证据，清理依赖引用、重建 epoch，必要时正文重发 |
| V2-R16／R17 | 显式 Pi before／success／failed compaction 事件及 stream 生命周期；恢复／历史／模型配置变化保守重建，dispose／ledger reset 清理 |
| V2-R19 | 版本、requestId、epoch、前缀字节、引用、整理、修复、预算和阶段日志；answer_session／pi_compaction 使用量、缓存读写、cost、响应耗时分开 |
| V2-R20／R21 | 默认 off 不变；新增确定性与实际 provider seam 回归；文档说明配置语义迁移，未新增依赖／摘要模型 |

| 阶段 | 最新状态 |
| --- | --- |
| P0 | 工作区基线已保存；多轮独立 gold 及盲测冻结仍待完成 |
| P1—P3 | 核心代码及请求级集成已接入；当前重点回归 136 项通过，包含当前问题证据保护与 Pi 压缩成功／失败 |
| P4 | 日志／构建／模拟请求核验完成；真实索引与三轮本地 QA 被 tokenizer 下载阻塞 |
| P5 | 未执行真实回答质量、缓存成本与多轮盲测；不得填写实测收益 |
| P6 | 产品默认 off 不变，实验 adaptive 可显式使用；未完成发布验收 |

关键文件为 `src/agent/context-selection-projector.ts`、`context-token-guard.ts`、`pi-session.ts`、`agent.ts`、`context-selection.ts` 和 `src/observability/run-log.ts`。测试包括新的 `test/agent/context-append.test.ts`、更新的 projector／session 测试；后者捕获三轮五次最终 provider 请求，并实际执行 Pi 成功／失败压缩。模拟 provider 不能证明真实 KV 命中或回答质量。

### 工程验证与环境

- 使用现有开发容器 `autorag-xsy-dev-dev-1`，Node 24.22.1、Bun；每次命令创建临时 HOME／AUTORAG_HOME／AUTORAG_CONFIG／Pi 目录并清理，没有使用共享配置运行 Agent。
- `bun run check && bun run lint && bun run typecheck` 通过；完整日志 `.omo/evidence/context-append-v2-checks.log`。仓库既有 useTemplate 信息提示不冒充错误。
- `bun run build` 通过；日志 `.omo/evidence/context-append-v2-build.log`。
- 首次完整套件：3346 项，3281 通过、63 跳过、2 失败；失败均为 `test/supply-chain/release-assets.test.ts` 的 `npm pack failed: spawnSync npm ENOENT`。容器缺少 npm，未改测试、安装依赖或绕过发布门槛。
- 最终边界加固的针对性回归：136 项通过，证据 `.omo/evidence/context-append-v2-focused.json`。不将不同快照的数字相加。
- 最终源码快照再次执行完整套件：**3353 项，3288 通过、63 跳过、2 失败**。两项仍是同一缺少 npm 的发布资源测试；完整退出码为 1，不能称作全绿。最终 check／lint／typecheck 和 build 均重新通过，重点 136 项覆盖最后的保护及生命周期修复。

### 真实本地 QA：仍阻塞

`scripts/manual-qa/run-qa-context-selection.ts` 已扩展为真实本地检索、三轮五次模拟回答请求的前缀检查。初次隔离运行没有可发现的 daemon／addon；检查后找到已安装 MinSync 和缓存 Qwen 模型，启动了任务自有、空闲端口／临时 state-dir 的实例，未停止或重配已有实例。

- 已观察到 `backend=daemon`、`model=Qwen/Qwen3-Embedding-0.6B`、`dimension=1024`、`remote=false`。
- 索引创建需要的 tokenizer 资产未齐；新隔离工作区从公共模型站点下载时失败，原始诊断为 `TypeError: terminated`（undici Fetch / TLSSocket）。宿主下载同一公开 tokenizer_config.json 的升级重试也返回 `curl: (28) Connection timed out after 30000 milliseconds`。
- 因此**尚未完成这次真实本地 refresh、语义命中和三轮请求 QA**，不复用 v1 的绿色结果。证据 `.omo/evidence/context-append-v2-local.json`，状态为 `blocked_or_failed`，其中 embedding 健康与索引完成状态分开。该阻塞记录来自新增边界保护前的快照，不冒充最终代码的真实 QA 通过证据。
- QA 内层临时根已清理，外层 shell 停止并等待自己启动的 daemon 后删除自有状态；随后进程检查确认本任务临时实例剩余数为 0。脚本记录 configUnchanged=true；容器真实配置前后 SHA256 同为 `c655960cce74a0087340214e665827c1c8241aa736e6b0d18b114ad7d3a816ac`，宿主真实配置仍为 absent。

### 尚未通过的发布门槛

多轮 gold 题集及独立人工复核、冻结 V2-A—E 的真实生成对照、实际 cacheRead／cacheWrite／cost、端到端质量与延迟、100 候选真实向量的完整 warm P95 尚未验收。日志只覆盖该 seam 的回答／Pi 摘要，规划／Jev 等其它调用不能假装已全部统计。正式发布前需重新审查并运行受影响的 live-E2E，不沿用旧证据。默认 off 保持不变。

### Git 与作用域

按要求尝试获取 origin：默认沙箱报 `.git/FETCH_HEAD: Read-only file system`，升级后 fetch 成功。没有在大量既有未提交改动上切换 main、重放上游或重写历史，也没有创建 worktree。Git 作者姓名／邮箱未配置；不代填身份、不打包其他会话改动提交，故本轮未提交／推送／开 PR，保留当前工作分支。

修改前副本和原有文件 SHA256 位于任务临时证据 `/tmp/autorag-v2-20261027`；最终对照以本轮开始快照区分修改，不能将 `git diff HEAD` 中所有变更都归本轮。本目录仍只有原四份文件；未修改正式调试配置、共享 home、原始文档或依赖。

## 1. 2026-10-26 原始状态与新旧差距（实现前）

| 项目 | 当前代码事实 | v2 状态 |
| --- | --- | --- |
| ledger 来源／正文归一化 hash、稳定 eN | 已有，可复用；不等于最终正文可见性 | 待补精确指纹和锚点验证 |
| 原始结果／会话与 provider 投影分离 | 已有 | 待保留稳定已发送视图 |
| latest map 和全历史重选 | v1 adaptive 现行实现 | 必须替换正常路径，不能只改为 earliest |
| 追加去重和短引用 | 尚无符合 v2 全部约束的实现 | 待开发 |
| 最终 guard 后引用核验／事务提交 | 现有 onContextPrepared 主要是统计 | 待开发，不以工具完成事件作为“模型已见” |
| memory_context | 根据当前 query 前置于消息序列 | 待改为启用 v2 时追加一次，不改历史 |
| 容量保护 | 有超限 guard 和 provider 输入限制 | 待增加高低水位集中整理和有界修复 |
| Pi compaction | 依赖有事件／API | 待适配成功／取消／失败、standalone 差异 |
| scope=answer_session usage | 已有 input/output/cacheRead 记录 | 不覆盖全部模型调用，待核对 adapter 与补齐总成本 |
| 模式 | 产品缺省 off；当前本地调试 JSON 为 adaptive | 调试启用的是 v1，本轮未改任何配置 |

当前目录中的旧“已实现”“最新工具证据优先”“全请求共享 6000”及旧 U/I 编号仅属于下方 v1 历史。当前主需求是旧视图稳定、新结果引用、容量触发整理；不能继续用旧定义验收。

## 2. SDD 分阶段任务与退出条件（原计划，最新状态见第 0 节）

| 阶段 | 需求 | 具体工作 | 退出条件 | 状态 |
| --- | --- | --- | --- | --- |
| P0 规格与基线 | V2-R01—R04、R19—R21 | 更新四份文档；固定旧实现指纹、已有改动和候选接口；补多轮 gold | 规格相互一致；正式模型实验前独立复核、冻结数据 | 文档已修订；代码基线／gold 待冻结 |
| P1 纯逻辑与状态测试 | V2-R05—R10、R17—R18 | 精确身份、完整锚点、稳定后缀、prepare／commit／rollback、同批稳定顺序 | 对应 U 测试通过；off／observe 输入不变 | 未开始 |
| P2 多入口追加投影 | V2-R03、R09—R12 | 接 baseline／工具／standalone／Pi；冻结实际发送视图；记忆追加；软预算迁移 | 正常多轮前缀精确一致，最终引用闭包成立 | 未开始 |
| P3 容量整理 | V2-R13—R18 | 0.80／0.60 初值、保护内容、epoch、指针处理、最终 guard 修复、Pi 事件 | 小窗口、取消／重试／恢复全部通过，无抖动和悬空引用 | 未开始 |
| P4 观测与隔离 QA | V2-R19—R21 | 前缀／整理／重发日志、usage 口径、真实本地检索＋模拟回答捕获 | 真实 source 可读、请求安全、配置前后 hash 相同 | 未开始 |
| P5 多轮真实评估 | V2-R20、VALIDATION | 冻结 V2-A—E，warm/cold 三次配对，成本、延迟、事实和引用评分 | 新门槛逐项 pass/fail/blocked；不拿 v1 数字替代 | 未开始 |
| P6 发布决策 | V2-R12、R20—R21 | 同步产品文档、配置迁移和 live-E2E 判断；受控启用或维持 off | 未完成门槛公开，不把配置开启写成验证通过 | 未开始 |

P1—P3 优先在现有 context-selection／projector／session 适配层演进，不先建立新框架。新候选分差／MMR 可复用，但不得拖回旧的全历史重选设计。各阶段先将 V2-R 映射到 V2-U／I，再提交实际实现证据；没有执行的阶段不填写“已完成”。

## 3. 实现前预计涉及的位置（2026-10-26 原始影响分析）

- `src/agent/context-selection-projector.ts`：稳定历史视图、精确去重、新后缀计划、epoch、完整锚点和修复。
- `src/agent/context-selection.ts`：版本与配置语义；现有纯新候选选择保留／适配，不新增模型。
- `src/agent/agent.ts`：记忆后缀、问题生命周期、工具结果登记、provider 事务边界、日志 scope。
- `src/agent/pi-session.ts`、`context-token-guard.ts`、`request-limits.ts`：最终视图检查、容量与 Pi compaction 协调；不能只在 formatter 过滤重复。
- `src/agent/evidence-ledger.ts`、检索工具包装：沿用原始证据和 eN，不把 ledger 改成全局已见缓存。
- `src/observability/run-log.ts`、CLI config／程序 API、现有测试／fixture／manual-QA／bench 和 `docs/context-selection.md`：按实际必要变更同步；不改正式调试配置和共享 home。

上述是影响分析，不是本轮已修改文件列表；各条仍以最小必要变更为准。Pi 手动 compact 会中断当前 operation，P3 必须通过事件和安全边界处理，不在 context handler 内直接调用。

## 4. 风险、回滚与待测量事项

- 前缀相同不保证 provider 命中缓存；cache TTL、路由、参数、模型与工具变化需分别观测。
- 旧正文放在中间可能影响质量，需验证短引用的定位效果与补读次数，不能只看 token 节省。
- 最后容量 guard 可能删除锚点；必须以最终模型视图为准，不允许仅凭 ledger／原始 transcript 建索引。
- 已发送视图元数据若不能可靠恢复，允许有记录地开启新 epoch、重发正文；不能跨分支猜测。
- v1 的 6000 预算语义与新语义不同，策略版本、说明和实验组都必须明确；本轮不修改代码配置。
- 先保留产品默认 off；代码阶段出现来源／指针损坏立即回退并保留原错误，旧前缀可信时仍保留它，不悄悄恢复全部 raw 历史。

## 5. 2026-10-26 规格修订记录（历史）

本轮仅修改 `README.md`、`SPEC.md`、`VALIDATION.md`、`IMPLEMENTATION.md` 四个既有文件；没有新增本目录文件，没有实现 v2、运行回答模型、修改检索或调试配置。`/workspace` 在当前宿主不存在，按既有映射编辑 WSL 项目下的同一相对目录。

本轮检查结果：

| 检查 | 结果 |
| --- | --- |
| 作用域文件哈希 | 已比较 src／test／scripts／skills／docs／.vscode／本目录共 802 个原有文件，本轮只改四份目标文档 |
| 目录文件清单 | 仍只有原四份 Markdown，无新增文件 |
| 规格结构 | 21 条 V2-R、36 条 V2-U、12 条 V2-I 连续唯一，需求追踪表已补齐；代码围栏配对、相对链接存在 |
| v1 执行记录 | 原文保留，仅标题降低一级并明确历史边界；未将旧结果登记为 v2 通过 |
| 空白与 diff | 四份文档单独检查；`git diff --check` 通过，但目标文档原未跟踪，不能仅依赖 git diff 检查它们 |
| 项目必需 checks | 尝试 `bun run check && bun run lint && bun run typecheck`，退出 127，原始诊断 `/bin/bash: line 1: bun: command not found`；后两项未执行，没有声称通过，未安装运行时 |
| 运行验证 | 本轮未执行业务测试、真实检索、模型、缓存实验或 live-E2E；它们属于后续实现验收 |

由于原工作区已有大量他人／前序未提交改动，且目标四份文档原已处于未跟踪目录，本轮不暂存、提交、推送、切换分支或开启 PR，不将整个 dirty checkout 打包提交。此项文档修订不是代码功能完成或发布完成。

## 6. v1 历史实现与实验记录（原文保留，非 v2 验收）

下面保持旧执行记录，包括旧算法、旧需求编号、指纹、计数、失败和环境限制。它们只能证明当时 v1 的对应结果。特别是旧调试配置 hash／默认开关描述不代表当前配置，旧“最新优先”及全历史预算行为已经被 v2 规格取代。

## 实现与验收记录

日期：2026-10-26。本文记录本次实现状态；SPEC / VALIDATION 的原有算法与发布门槛保持不变。

### 已实现

核心实现位于 `src/agent/context-selection.ts` 和 `src/agent/context-selection-projector.ts`，配置、真实请求路径、索引内部数据及日志已接入。使用方法见 [context-selection.md](../../docs/context-selection.md)。

| 规格 | 落点 | 验证依据 |
| --- | --- | --- |
| R-01 / R-04 / R-05 | 保留候选、ledger 和原始 transcript，只投影模型请求 | session 测试比较完整 API、实际 provider 输入与交互原始会话 |
| R-06 / R-17 | single、progressive、工具回包、绑定 Pi session 接入共同变换 | context-selection-session、既有 context-guard / pi-session / two-phase / steering 测试 |
| R-07 | trusted config 与 API；缺省 off；严格校验字段 | config.context-selection、纯配置测试 |
| R-08 / R-09 | Symbol 伴随数据、已有向量、纯选择器、有界内存 | indexing 回归、JSON 不含向量、确定性与生命周期测试 |
| R-10 | 仅正向识别有限事实问法，其余保守绕过 | 明确全量、比较、例外、宽泛政策、未知问题测试 |
| R-11 | 同证据去重；跨 ID 不合并，不改写句段 | 重复 query、相同向量不同 ID / 版本、最新工具证据测试 |
| R-12 / R-13 / R-14 | 分区分差、缓冲、MMR、分区轮询、覆盖提示 | gap、维度和缺失数据、负值、平滑分数、多 query 单测 |
| R-15 | 全请求共享预算、完整块装入、tokenizer / 估算器 | 多消息预算、路径提示、小窗口、中文、零可容纳块测试 |
| R-16 | 复用原 Agent 工具；新证据优先；原文读取保留 | 工具二次请求、原文和非本地消息不变测试 |
| R-18 | 原错误回退、Rerank 绕过、取消不追加请求 | projector 故障注入、缺失数据、取消测试 |

U01—U22 对应边界已纳入选择器／投影测试。I01—I15 的工程入口由上述测试覆盖，包括实际模拟 provider seam；这不代表真实 LLM 的事实正确性、引用支持率或补取行为已验收。

### 实验工件

- `test/fixtures/context-selection/cases.json`：120 条合成工程题，六组各 20 条，固定每组 8 dev / 12 test，含原始自建文档和 gold 引用；独立人工复核为 pending，题型丰富度尚不能满足正式盲测要求。
- `scripts/manual-qa/run-qa-context-selection.ts`：真实本地嵌入 + 模拟 provider 的最终请求核验。
- `scripts/bench/context-selection.ts`：开发集离线 A–F 选块分析；不执行回答与补取，不以文档 ID 保留率代替关键事实覆盖率。
- `.omo/evidence/context-selection-local.json` / `context-selection-analysis.json`：忽略的运行证据，含实现指纹、配置哈希与清理回执；不提交语料请求正文。

原有 `scripts/live-e2e/` 和原始输出契约无需因默认 off 改动；没有复用旧 live 证据证明新 adaptive 行为。本次增加独立 QA；正式启用前仍须真实回答模型的 cold/warm 与质量评估。

### 当前已完成与未完成的验收

已完成：默认关闭、配置校验、纯选择、模型请求投影、既有相关回归、容器构建与真实本地检索。

| 检查 | 本次结果 |
| --- | --- |
| `bun run check && bun run lint && bun run typecheck` | 通过；保留仓库既有的 useTemplate 信息提示 |
| `bun run build` | 通过，包含源码构建与声明输出 |
| 选择器 / projector / session / fixture / config 新增测试 | 5 个文件，67 项通过 |
| 含索引、ledger、Pi session、steering、progressive 的相关回归 | 共 14 个文件，186 项通过 |
| 真实本地检索与请求 QA | 通过；现有 daemon，Qwen3-Embedding-0.6B，1024 维；106 个自建文档、212 块，召回 100 |
| QA 的最终 provider 输入 | off / observe 各 100 个候选出现，规范化后的 role/content 完全一致；adaptive 3 个，保留 `472 credits` 原始事实 |
| QA 的请求消息序列化字节 | off / observe 各 38,482；adaptive 30,329；这是该问题的模拟 provider 消息字节，不能当作计费 token 或一般收益 |
| A–F 离线分析 smoke | 2 个 dev 问题、12 行方案结果通过；没有运行 72 题测试集或真实生成对照 |
| QA 隔离与清理 | 默认配置哈希不变，临时根已删除，现有 daemon 未停止或重配 |

上述 QA 实现指纹（12 个关键源文件的有序内容 SHA256）：`02059f2ff6c31c3dade124f9f3419973997cfe8a45021ba2d5f84fbb15401359`。题集 SHA256：`05c7d08398ce2babaf710a56d2c603fb906945b797b48cab4269c812e6b2c7f3`。两者仅标识该实验的代码／题集，不代表完整未提交工作区快照。

容器默认配置前后均为 `c655960cce74a0087340214e665827c1c8241aa736e6b0d18b114ad7d3a816ac`；宿主默认配置为 absent；调试配置保持 `29747e71675cf0cf1327c71536f37ef2ea89c46f866c1319036ce8a86b312244`。

首次完整回归有 3,232 项通过、三项失败：两项发布资源测试因容器缺少 npm（`npm pack failed: spawnSync npm ENOENT`），另一个 sidecar 大规模用例在并发运行真实本地 QA 时超时。后者隔离复跑 32 项全部通过。

最终快照再次运行完整回归，命令为 `node node_modules/vitest/vitest.mjs run --maxWorkers 2 --testTimeout 180000 --reporter=json --outputFile=.omo/evidence/context-selection-regression.json`：**3,244 项通过、63 项跳过、2 项失败**，总计 3,309 项。两项失败均在 `test/supply-chain/release-assets.test.ts`，仍为上述缺少 npm；sidecar 在这次完整运行中通过。完整套件退出码为 1，不能称作全绿。未修改发布测试来绕过环境问题，未安装额外依赖。

未完成，禁止标记为发布通过：

- P0：独立人工复核的代表性 gold 题集。
- P3：获准真实回答模型上的事实／例外／多来源／无答案／全量验证，以及同配置隔离 TUI smoke；没有声称命中 VS Code GUI 断点。
- P4：冻结参数后的 72 题盲测、完整回答流程 A–F 三次配对、usage 汇总、事实与引用评分、置信区间、100 候选 warm P95 门槛。
- P5：是否适合启用；目前保持 off。

没有使用真实远端回答模型或外部裁判，没有新增依赖或更换嵌入后端。模拟请求的字节数和选块计时不是实际计费 token 或端到端回答延迟。

### Git 与既有工作区

开始时已有大量未提交改动，本次保留。尝试 `git fetch origin` 超时，且当前 Git 作者姓名／邮箱未配置，不能安全生成满足 DCO 的提交。继续当前 `codex/observable-local-index` 工作区，不创建 worktree、不切换丢失现有改动、不代填身份、不提交其他改动；因此尚无提交、推送或 PR。

本次保存了操作前 tracked 文件哈希，并核对只有预期的 10 个既有源文件被本次进一步修改；新增实现、测试和说明单列。不改变 LICENSE、凭据、默认调试配置及原始资料。
