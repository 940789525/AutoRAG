# 按需证据恢复：验收证据索引

本表对应 `myself_dev/1026/VALIDATION.md` 的 ER-U01—U18、ER-I01—I07。它记录工程断言的落点，不把模拟回答、工程绿测或模型连通冒充真实回答质量通过。单人自动来源复核已经用户授权，独立人工复核未执行。

测试文件简称：R=`test/agent/read-local-evidence.test.ts`，S=`test/agent/context-selection-session.test.ts`，A=`test/agent/context-append.test.ts`。测试中的 LanceDB 为真实本地库；回答模型及部分边界故障使用可控替身。文件/数据库故障注入不冒充真实设备故障。

| 要求 | 可运行断言与证据 |
| --- | --- |
| ER-U01 | R：unknown IDs/path parameters/extra fields，另含 null、空串、e0/e01、数字；严格 schema 不接受覆盖定位。 |
| ER-U02 | R：三模式 complete original chunks；真实索引命中后禁用 embedding、retrieve、index.search、refresh；读取仍成功、ledger 不变。 |
| ER-U03 | R：长于 excerpt 的原块、SHA256；table whitespace/Unicode/UTF-16 locations，不拼 heading。 |
| ER-U04 | R：public metadata/ordinary excerpt 不授予 locator；A：ordinary user text 不制造可见锚点。 |
| ER-U05 | R：clear/old sessions；实际 restoreConversationState 仅当前 branch 恢复定位，保留全局 ID 序号。 |
| ER-U06 | R：current scope/excluded source；读取数据库期间收紧权限后再次拒绝。 |
| ER-U07 | R：sibling prefix、retargeted configured root、source symlink；精确读取期间的来源/位置变更拒绝。不能据此声称所有操作系统 race 均已穷尽。 |
| ER-U08 | R：修改正文后恢复原大小和 mtime，仍拒绝旧证据。 |
| ER-U09 | R：profile unavailable、body/source/position mismatch；A：changed version/different chunk/source 身份不合并。 |
| ER-U10 | R：missing source/index/chunk、legacy manifest 无指纹、镜像被改；缺库后不创建。 |
| ER-U11 | R：complete/body SHA 对应原文；无法核验版本的分支全部失败，无 excerpt 兜底。 |
| ER-U12 | R：UTF-8 65535/65536/65537 字节、多字节文本；超限错误包含实际大小及限制。 |
| ER-U13 | R：原始文件/数据库诊断、读取前/期间取消、禁用 embedding 后读取；缺失索引不启动 backend。 |
| ER-U14 | A：explicit-read draft abort 后成功重试才提交；R：最终正文截断/变更立即拒绝。 |
| ER-U15 | R：clear、1024 locator 淘汰、restore 后有界、eN 不复用；S：bound runtime dispose 清定位。dispose 缺口由新增测试先失败再修复。 |
| ER-U16 | R：corrupt optional metadata 保留 citation，但不升级读取权限；恢复后仍从当前真实索引核验。 |
| ER-U17 | R：off/observe/adaptive 都能读取；S：off/observe 规范化完整回包一致；A：显式读成功后普通重复命中可引用。 |
| ER-U18 | R：web_fetch/bash/kakao/obsidian 无可信 locator 时 reader 调用数为零；A：非本地正文不投影。 |
| ER-I01 | S：single/progressive standalone seam 完整成功、actual Pi 三模式压缩后补读；R：三模式工具存在。非所有入口/模式的笛卡尔积。 |
| ER-I02 | R：真实索引 → deterministic capacity compaction → complete read → provider dispatch；S：实际 Pi compact 后补读。 |
| ER-I03 | R：读库期间 scope 撤销、最终发送时 scope 失效；A：request fingerprint/epoch 变化废止旧锚点。 |
| ER-I04 | R：final guard 裁正文后不能 dispatch；A：abort/retry 不提前提交、部分完整块不能做锚点。真实 provider 特有的隐式截断仍须 provider 端证据。 |
| ER-I05 | R：真实 LanceDB open/read、无 embedding、缺库不创建、旧会话保守失败、真实分支 metadata 恢复。 |
| ER-I06 | S：actual Pi compact/compact failure/cancel；R：当前分支恢复、读边界 branch 变化；A：cancel/retry 与 lifecycle epoch。 |
| ER-I07 | R/S/A：声明、原始块、模式、去重与 provider 视图断言；会话实验保存 schema、raw results、usage 与补读统计。尚不宣称产品所有 Jev/规划/外部工具调用都已纳入完整成本账本；实验统一关闭这些调用。 |

工程证据：`.omo/evidence/context-completion-regression.json` 为全量快照，3352 通过、63 跳过、0 失败；其后只读 OAuth 接入的相关回归见 `context-completion-credential-tests.log`（41 通过），主机凭据 broker 的三个离线测试见 `context-completion-broker-tests.log`。不同时间的回归数量不可相加冒充最新全量数量。

离线性能：100 候选、20 次预热、200 次采样，selection P95 约 2.40 ms；含注册和两次完整 dispatch 的 CPU P95 约 18.13 ms。后者不能写成“小于 10 ms”。原始条件与 projector hash 见 `.omo/evidence/context-completion-projector-performance.json`；共享机器上的一次观察不是跨机器性能保证。

真实本地 embedding QA 的既有证据见 `.omo/evidence/evidence-read-local.json`；真实生成另行记录。GPT 小规模 E/F 四轮会话均完成，F 一次补读零错误：`.omo/evidence/context-completion-gpt61-runtime-smoke.json`。30 场景正式数据写入 `.omo/evidence/context-completion-gpt61-low/`，运行结束之前不标完整验收通过。

历史 B 使用恢复的 v1 算法与当前公共 harness，非完整旧应用 checkout；来源及哈希见 `scripts/bench/historical/provenance.json`。provider 冷缓存无法清空/隔离，真实 cacheRead 只能作为观察数据；API 目录价格估算不等于 Codex 订阅实际账单。默认模式保持 off。
