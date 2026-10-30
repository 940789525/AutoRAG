# 回答可读性与单次交付

## 默认行为

AutoRAG 现在默认使用 `answerMode: "single"`。不需要修改已有用户配置即可获得新默认值。

普通查询的流程为：

```text
问题路由（如已启用 Jev）
  → 必要的基线检索
  → 一个允许调用工具的回答回合：补足证据、核对重要事实、解决冲突
  → 一份完整、自包含的最终答案
  → 结束
```

这里的“单次交付”不是禁止工具调用，也不是要求只发起一次模型请求。一个回答回合内仍然可以多次检索、读取原文及处理用户纠正；被取消的查询不会启动额外核验。原文核验在答案交付前完成，而不是删除核验功能。

默认流程不生成 fast-answer 初答，不发送 `preliminary` 事件，不执行首答之后的 Jev follow-up 判断，也不自动发起要求 `DELTA ONLY` 的第二轮回答。因此不会先出现完整答案，再被大量工具记录隔开，最后只看到“确认无误”。

## 配置与兼容

可在现有 AutoRAG 配置文件中显式设置：

```json
{
  "answerMode": "single"
}
```

这是字段示例，不应使用这个片段覆盖完整配置文件。

需要旧版渐进式体验时，显式改为 `"answerMode": "progressive"`。旧的首答、事后核验及增量回答分支保留并由兼容测试覆盖。其他值会被配置解析器和 library 构造器拒绝。

程序调用对应：

```ts
const agent = new AutoRAGAgent({
  ...existingOptions,
  answerMode: "single",
});
```

`thinking.final` 控制单次回答回合；`thinking.fast` 仅用于显式 progressive 模式。Jev 的问题路由、分解、数据源选择，以及证据引用和记忆判断仍保留。

## 显示层

- 人类可读的 `autorag search` 输出默认只显示正式答案。使用 `--debug` 时，进度写入 stderr，不混入答案 stdout。
- JSON 流保留既有结构化 `progress` 事件协议，方便程序处理；默认 single 模式只产生一个 `complete` 答案，不产生 `preliminary`。
- TUI 默认折叠工具执行详情，可使用 Pi 原有展开操作查看。工具调用的简短意图作为临时工作状态，仍可提示程序正在工作。
- TUI 默认隐藏 thinking block。如果用户在 Pi 的全局或项目设置中明确设置了 `hideThinkingBlock`，尊重其选择。默认值仅通过内存覆盖生效，不写全局设置，并在会话重载后重新应用。
- 不隐藏权限确认，不丢弃诊断，不把工具失败说成核验成功。提示词要求避免重复过程叙述，并在同一检查连续失败两次后停止等价重试。该重试规则是模型行为约束，不是新的强制工具计数器；已有 runaway-loop guard 保持不变。

外部桌面或 Web 客户端若自行把每个 `progress` 事件追加到聊天正文，仍应在其界面中将这些事件放入可折叠的运行详情；本次没有修改不在当前项目中的客户端，也没有移除其事件协议。

## 生效范围

源码修改需要由新构建加载。已经运行并持有旧代码/旧提示词的进程不会被这次改动自动重启。重新启动 CLI/TUI，并新建会话使用新流程；恢复旧会话仍会看到已经存在的旧消息，历史不会被删除。

本次没有重写用户配置、切换 Git 分支、提交或推送，也不覆盖原有无关的未提交修改。

## 验收

自动化覆盖：

1. 默认只有一个模型回答回合；无初答事件、无自动追加核验请求。
2. 仍可在回答前检索、返回真实引用并将其映射到结果。
3. Jev 路由与基线检索仍运行，但 single 模式不询问 post-answer follow-up。
4. 显式 progressive 模式仍保留旧协议。
5. 用户纠正可在同一回答中生效；取消后不启动额外回合。
6. 人类 CLI stdout 不含过程进度，debug 进度进入 stderr，JSON 协议保持兼容。
7. 真实交互会话默认隐藏 thinking block、折叠工具详情，且不改写共享设置。
8. 来源或模型错误仍保留诊断，不伪称已经核验。

已完成验证：

- 隔离环境中的 agent 与 CLI 回归：112 个测试文件、1259 个用例通过。
- 后续新增的技能说明一致性与配置回归：2 个测试文件、24 个用例通过（与上述统计有重叠，不应相加）。
- `bun run check`、`bun run lint`、`bun run typecheck`、`bun run build` 通过；check/lint 仅报告仓库中既有的 7 条 informational 建议，未自动修改无关内容。
- 构建产物的离线冒烟测试通过：一个模型回答请求、零个 preliminary、一个 complete，引用正确解析。
- `git diff --check` 通过；原有 index 命令、CLI 入口和输出文件的未提交差异保持原样，帮助文件原有新增内容保留。

## 回退与修改记录

原有文件均原路径修改，没有移动、重命名或删除。

备份目录：`/tmp/autorag-readable-answer-bmkaZH`。目录内按原项目相对路径保存修改前内容，`before.diff` 保存操作前的 tracked 差异。对于操作前干净、首次编辑后才补存的两个测试文件，备份内容取自当时的 HEAD。

生产代码修改：

| 原路径 | 修改后路径 | 内容 |
| --- | --- | --- |
| `src/agent/agent.ts` | 同原路径 | 默认 single 分支、保留 progressive、单次回答提示词 |
| `src/agent/system-prompt.ts` | 同原路径 | 一次完整交付、证据充分即停、无效重试约束 |
| `src/agent/pi-session.ts` | 同原路径 | 会话级隐藏 thinking 与工具详情折叠 |
| `src/agent/search-documents.ts` | 同原路径 | preliminary 事件兼容模式说明 |
| `src/cli/config.ts` | 同原路径 | answerMode 校验与传递 |
| `src/cli/commands/search.ts` | 同原路径 | 人类答案 stdout 与调试进度 stderr 分离 |
| `src/cli/command-help.ts` | 同原路径 | 帮助与新默认行为一致，保留原有其他修改 |
| `skills/autorag/SKILL.md` | 同原路径 | 用户技能说明与单次交付默认值一致 |
| `skills/autorag-setup/SKILL.md` | 同原路径 | 自配置技能不再推荐默认事后核验 |
| `skills/autorag-doctor/SKILL.md` | 同原路径 | 将 follow-up 诊断限定为显式兼容模式 |

相关测试为原路径更新；新增配置测试为 `test/cli/config.answer-mode.test.ts`，新增本文为 `docs/answer-delivery.md`。回退时应只恢复本次改动，不应使用整仓 `git reset`；如果备份后有新的编辑，须先比较差异再恢复。
