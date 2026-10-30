# API 与事件契约

## 通用规则

前缀 `/api/research/v1`。JSON 字段使用 camelCase；UUID 和事件序号均作为字符串。时间为 ISO 8601 UTC。未知字段拒绝，列表默认 limit=20、上限 100，使用不透明游标。合同版本固定为 `research-spec-v1.1`；本次为未实现草案修订，路由主版本与事件 schemaVersion=1 保持不变。

所有 POST/PATCH 需要 `Idempotency-Key`，长度 1—128，仅允许字母数字及 `._:-`。幂等范围是本地用户范围、method、规范化 route 和 key；摘要包含规范化 JSON、If-Match 和操作语义。相同请求返回首次响应，key 配不同内容返回 409。先做调用者及 schema 校验，再查询幂等响应；成功重放优先于已经变旧的 If-Match，防止网络重试错误报冲突。

项目、单元格编辑和接受备忘录需要 If-Match，缺少返回 428，版本不匹配返回 412，响应包含重新读取入口。ETag 是服务端生成的不透明带引号字符串，如 `"cell:<id>:7"`。

接口校验 schema 是 contracts 的权威定义，后续从同一来源生成 OpenAPI 与前端类型，不能手写三套互相漂移的类型。本文先冻结语义，不声称已有可运行 API。

## 路由

| 方法 | 路径 | 输入/作用 | 成功 |
| --- | --- | --- | --- |
| GET | /health/live | 进程存活，不调用模型 | 200 |
| GET | /health/ready | API、数据库、schema 兼容；附 Worker 心跳，不以 Worker 离线禁止读旧成果 | 200/503 |
| GET | /capabilities | 支持的协议、限额、modelProcessingEnabled、模式；无凭据 | 200 |
| GET | /library/files | 受信根目录内的 PDF 候选列表，返回 fileId、相对名称、大小 | 200 |
| POST | /library/registrations | `{fileIds:[...]}`，异步稳定观察与 hash 登记，不调用模型 | 202 RunRef |
| GET | /assets/:id | 登记状态、版本、解析状态与来源可用性 | 200 |
| GET | /assets/:id/document | 可指定 parsedRevisionId；返回不可变文本、章节与全局 UTF-16 区间，分页按块读取 | 200 |
| GET/HEAD | /assets/:id/file | 受控 PDF 预览；支持合法 Range，asset 与当前文件版本核对 | 200/206 |
| POST | /assets/:id/evidence | `{parsedRevisionId,start,end}`，登记用户选区为证据，不调用模型 | 201 Evidence |
| POST | /projects | 问题、约束、已登记 assetIds、维度；允许先建空项目 | 201 Project |
| GET | /projects | 项目列表和真实状态摘要 | 200 |
| GET | /projects/:id | 项目输入与 ETag | 200 |
| PATCH | /projects/:id | 完整期望输入，If-Match；创建新 project revision | 200 Project |
| GET | /projects/:id/matrix | 支持 matrixVersion 或 projectRevision，返回冻结矩阵、coverage 与有效性 | 200 Matrix |
| POST | /projects/:id/analyses | `{projectRevision,mode,assetIds?,rerun?}`；mode 为 initial/incremental/repair，rerun 默认 false | 202 RunRef |
| GET | /cells/:id | 当前建议、人工记录、证据与 ETag | 200 Cell |
| POST | /cells/:id/reviews | action=confirm/correct/reject，assertionKind、replacement、evidenceIds、reason；If-Match | 201 Review |
| GET | /projects/:id/assessments | 支持 matrixVersion；条件核验范围、结果、输入版本与当前有效性 | 200 |
| GET | /evidence/:id | 指定版本的引用、上下文和当前有效性 | 200 |
| GET | /runs/:id | 执行快照、阶段、用量、partialResults 与底层错误 | 200 Run |
| GET | /runs/:id/events | SSE，支持 Last-Event-ID | 200/410 |
| POST | /runs/:id/cancel | 持久取消请求；终态则原样返回 | 200 Run |
| POST | /runs/:id/retry | 仅 failed/cancelled 且输入仍有效；创建关联后继或返回已存在后继 | 202 RunRef |
| POST | /projects/:id/memoranda | `{projectRevision,matrixVersion,baseId?,rerun?}`，生成草稿任务，rerun 默认 false | 202 RunRef |
| GET | /projects/:id/memoranda | 历史版本及状态 | 200 |
| GET | /memoranda/:id | 内容、输入依赖、未确认项与 ETag | 200 |
| POST | /memoranda/:id/accept | `{expectedProjectETag}` 加备忘录 If-Match；原子校验项目与草稿后更新定稿指针 | 200 Project |
| POST | /projects/:id/exports | `{format,matrixVersion,memorandumId?}`；只格式化已有成果，不调用模型 | 201 ExportRef |
| GET | /exports/:id/file | 只读下载对应不可变文件 | 200 |

每次登记最多 10 个 fileId。登记任务完成后结果包含 fileId 到 assetId 的映射。前端先展示“正在登记”，拿到 asset 后再更新项目输入；不使用浏览器传来的任意绝对路径。候选列表只观察元数据，不为展示列表预先 hash 或解析全库。

默认输出最新状态不代表原始来源仍有效。原文已变化/缺失时，历史证据返回 `validity=source_changed/source_unavailable`，不可冒充当前已验证内容；预览接口返回 409，历史解析文本可以明确标记后查看。

### 矩阵、重跑与修订规则

矩阵查询省略两个参数时返回当前 project revision 的最新快照；仅 projectRevision 时返回该输入版本最后一个快照；仅 matrixVersion 时返回精确历史快照；同时提供时必须匹配同一快照，否则 409，未知版本为 404。响应包含 projectRevision、matrixVersion、当前项目版本和逐项 applicability。项目输入 PATCH 成功后立即有新矩阵快照，不等待模型完成。

历史矩阵中的 cell/review/assessment 均内联精确版本的可展示投影，不能再 GET 当前 `/cells/:id` 拼成历史。历史模式禁止写操作；转到当前模式重新读取 ETag 后才可编辑。assessment 查询省略 matrixVersion 时使用当前快照，过时结论显式返回 validity=stale，不参与当前比较或备忘录有效输入。

rerun 与网络重试分开：相同幂等请求始终重放；新请求若有同输入活动任务则返回它。相同输入已成功时 rerun=false 返回原 run，rerun=true 才创建新 generation 并重新消耗预算。失败/取消走 retry；superseded 或旧输入的 retry 返回 409，details 给出当前项目入口，不自动把旧任务变成新问题。登记任务不提供模型 rerun。完整状态表见 03。

MVP 的备忘录“可修订”指修改上游事实/判断或项目输入后，通过 baseId 关联旧版本生成新草稿，再由用户接受；不包含直接手工编辑正文。baseId 必须属于同项目，旧正文及输入保留。相同输入主动重新生成也须 rerun=true。若以后加入正文编辑，应单独定义人工作者身份、证据保留和编辑并发规则。

接受备忘录时 If-Match 匹配备忘录，expectedProjectETag 匹配项目的 edit_version；版本冲突为 412，输入已过时为 409。成功响应返回新的项目 ETag。两个不同草稿不能仅凭各自仍有效的 ETag 互相覆盖项目定稿指针。

### 人工证据登记与审阅

选区接口接受服务器解析版本 ID 与全局 `[start,end)`，要求整数、`0≤start<end≤文本UTF-16长度`；引用长度上限由 capabilities 返回并由受信配置固定。宿主从不可变文本切片计算 quote 与 hash，不接受客户端自报 quote、路径、asset hash 或证据有效性。相同区间复用同一证据 ID；没有提前被模型读取过的区间也能由用户登记，且不计入模型阅读 coverage。

解析版本不属于该 asset 返回 422，来源已变化或不可用返回 409。修正论文事实的 evidenceIds 必须绑定该单元格的 asset 和适用解析版本，且当前有效；不能只检查 ID 存在或同项目归属。confirm 绑定 If-Match 对应的当前建议，correct 必须提供 replacement，更正事实还需证据，reject 必须有 reason 且不能继续把被拒绝建议当有效事实。用户判断使用 assertionKind=user_judgment，明确独立于论文原文事实。

## 关键 DTO 示例

```json
{
  "runId": "00000000-0000-4000-8000-000000000001",
  "state": "queued",
  "statusUrl": "/api/research/v1/runs/00000000-0000-4000-8000-000000000001",
  "eventsUrl": "/api/research/v1/runs/00000000-0000-4000-8000-000000000001/events"
}
```

Cell 的必选字段：id、version、assetId、dimensionId、dimensionRevision、suggestion、effectiveValue、review、evidence、coverage、applicability。suggestion 包含 value、valueState、conditions、cellRevisionId；valueState 非 reported 时 value 可空。review 可以为空，但不得把“未审阅”折叠成“已确认”。pending 单元格的 suggestion、effectiveValue 可空；stale 历史值只能供对照，不能作为当前已验证事实。

Evidence 的必选字段：evidenceId、assetId、parsedRevisionId、sourceSha256、textSha256、start、end、quote、validity。pageHint 可空，页面映射不可靠时不得伪造。证据全文和用户笔记通过受控查询获取，不通过普通进度事件广播。

Assessment 包含 id、scope、state、validity、metric、conditionDimensions、reason、inputCellRevisionIds、reviewIds、coverage。scope 为 `{assetIds,metricDimensionId,metricDimensionRevision}`，assetIds 为 2—10 个有序唯一资产。reason 中解释判断边界；没有支持全部参与资产的条件时，不输出全组肯定可比。validity 与历史结论 state 分开，不以当前失效改写历史判断。

Coverage 包含 policyVersion、requiredRanges、observedRanges、unreadRanges、parseGaps、claimScope、complete。区间绑定 assetId/parsedRevisionId，由宿主根据实际交付模型的记录计算；模型不能自报 complete=true 绕过校验。not_reported 仅在预定范围完整覆盖且无相关解析缺口时有效，并展示 claimScope，详见 05。

Run 包含 kind、state、phase、projectRevision、cancelRequestedAt、completedUnits、totalUnits、lastEventId、partialResults、error、usage、mode、startedAt、updatedAt。units 指已完成的明确工作单位，不是估计的模型完成百分比。

## 事件契约

事件 type：`run.queued`、`run.started`、`run.progress`、`cell.published`、`assessment.published`、`memorandum.draft_created`、`run.cancel_requested`、`run.succeeded`、`run.failed`、`run.cancelled`、`run.superseded`。

payload 共有 schemaVersion、runId、seq、occurredAt、projectRevision 可空、phase、counts 可空、resourceIds 可空。错误终态可带原始 message，按长度截断但不把路径或原因替换成泛化枚举。

```text
id: 12
event: cell.published
data: {"schemaVersion":1,"runId":"example-run","seq":"12","occurredAt":"2026-10-28T10:00:00Z","projectRevision":2,"resourceIds":{"cellId":"example-cell"}}
```

这是协议示意，不是有效 UUID 测试夹具。event ID 为该 run 的 seq；锁 run 行分配并与业务结果同事务提交，避免序号顺序与提交可见性错位。客户端按 `(runId,seq)` 去重，收到 resourceId 后重取资源。

首次连接先查询 Run，再订阅 seq 之后的事件。断线携带 Last-Event-ID；保留历史不能覆盖时，建立流前返回 410 和 snapshotUrl。流建立后若发现缺口，发送无 id 的 `reset` 控制事件并关闭，客户端取快照后重连。心跳为不带 id 的注释。终态事件发送后关闭；已经终态的连接先补齐可用事件，再关闭。

默认每连接输出缓冲 256 KiB，慢客户端断开后恢复，不能无限缓存。客户端手动断流或关闭网页不会取消后台任务。

## 错误语义

统一结构 `{code,message,requestId,details?}`，message 保留底层错误文字；code 只是附加信息，不能替代原因。状态码：400 schema 错误，403 来源/模型许可/Origin 不允许，404 未知资源，409 幂等或来源/业务冲突，412 编辑版本变化，413 文件过大，416 非法 Range，422 不满足领域条件，428 缺少 If-Match，429 队列容量不足，503 API 的数据库或必要能力不可用。

模型连接错误通常记录到已接受 run 的 failed 状态，通过查询/事件呈现，不把已经接受的请求追溯改成提交失败。预算耗尽使用 run.error.code=budget_exceeded，保留已完成成果。

## 浏览器边界

同源入口，严格 Host/Origin 验证，拒绝跨站写请求；浏览器写操作使用同源会话/CSRF 保护，具体实现随本地访问方案验证，不引入公共匿名服务。开发代理与容器端口转发必须保留正确来源语义，不能通过全量放开 CORS 解决。

API 不提供修改模型、凭据、根目录或远端处理授权的路由。单用户本地模式不直接发布公网；公网部署、多用户认证另立设计。
