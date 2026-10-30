# 上下文 v2：30 段会话 gold 复核包

状态：已按用户确认完成单人自动来源核对（30 段、120 轮、150 条参考事实）；不属于独立人工复核。
请逐段核对问题、必要事实、版本及引用依据；记录姓名/日期、是否与作者独立、修正项。只有逐条复核完成才能填写 reviewed。
来源为 scripts/bench/context-session-cases.ts 的自建非敏感语料；完整数据与逐条参考依据位于 .omo/evidence/context-session-gold.json。
评分：每个必要事实分别判断正确/错误/遗漏；每条事实引用分别判断支持/不支持/缺失；未知项目必须明确未找到；失败与取消单列，不用关键词出现替代语义评分。
注意：当前 M3 未覆盖真实 rerank/steering，M5 未覆盖真实模型取消/resume，M6 未混入实际非本地资料；这些工程边界另有测试，不能据此把这 30 段称为所有场景的完整盲测。
题集指纹：7ae322cbd25e2e3474c10faae387940c8426dbd86c52c7c8df188f23342c2fd5

## M1-1（dev，Orchid-1）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-1? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 472 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-1 is 472 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-1 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-1 with a supported citation.

- 必要事实：Current threshold: 472 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-1 is 472 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-1's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 472 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-1 is 472 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M1-2（dev，Orchid-2）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-2? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 485 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-2 is 485 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-2 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-2 with a supported citation.

- 必要事实：Current threshold: 485 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-2 is 485 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-2's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 485 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-2 is 485 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M1-3（test，Orchid-3）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-3? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 498 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-3 is 498 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-3 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-3 with a supported citation.

- 必要事实：Current threshold: 498 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-3 is 498 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-3's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 498 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-3 is 498 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M1-4（test，Orchid-4）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-4? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 511 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-4 is 511 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-4 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-4 with a supported citation.

- 必要事实：Current threshold: 511 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-4 is 511 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-4's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 511 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-4 is 511 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M1-5（test，Orchid-5）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-5? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 524 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-5 is 524 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-5 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-5 with a supported citation.

- 必要事实：Current threshold: 524 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-5 is 524 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-5's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 524 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-5 is 524 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M2-1（dev，Orchid-6）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-6? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 537 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-6 is 537 credits.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 2 轮
Search the Orchid-6 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-6 with a supported citation.

- 必要事实：Current threshold: 537 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-6 is 537 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 4 轮
As of 2026-10-27, give Orchid-6's current threshold and explain why the retired policy does not apply.

- 必要事实：Current threshold: 537 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-6 is 537 credits.
- 必要事实：Retired policy is superseded and ended 2026-09-30；允许来源：retired-policy.md, policy.md；依据：Effective until 2026-09-30 only.
- 禁止：Unsupported facts or sources；Treating retired amount as current

## M2-2（dev，Orchid-7）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-7? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 550 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-7 is 550 credits.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 2 轮
Search the Orchid-7 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-7 with a supported citation.

- 必要事实：Current threshold: 550 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-7 is 550 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 4 轮
As of 2026-10-27, give Orchid-7's current threshold and explain why the retired policy does not apply.

- 必要事实：Current threshold: 550 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-7 is 550 credits.
- 必要事实：Retired policy is superseded and ended 2026-09-30；允许来源：retired-policy.md, policy.md；依据：Effective until 2026-09-30 only.
- 禁止：Unsupported facts or sources；Treating retired amount as current

## M2-3（test，Orchid-8）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-8? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 563 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-8 is 563 credits.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 2 轮
Search the Orchid-8 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-8 with a supported citation.

- 必要事实：Current threshold: 563 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-8 is 563 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 4 轮
As of 2026-10-27, give Orchid-8's current threshold and explain why the retired policy does not apply.

- 必要事实：Current threshold: 563 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-8 is 563 credits.
- 必要事实：Retired policy is superseded and ended 2026-09-30；允许来源：retired-policy.md, policy.md；依据：Effective until 2026-09-30 only.
- 禁止：Unsupported facts or sources；Treating retired amount as current

## M2-4（test，Orchid-9）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-9? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 576 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-9 is 576 credits.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 2 轮
Search the Orchid-9 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-9 with a supported citation.

- 必要事实：Current threshold: 576 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-9 is 576 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 4 轮
As of 2026-10-27, give Orchid-9's current threshold and explain why the retired policy does not apply.

- 必要事实：Current threshold: 576 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-9 is 576 credits.
- 必要事实：Retired policy is superseded and ended 2026-09-30；允许来源：retired-policy.md, policy.md；依据：Effective until 2026-09-30 only.
- 禁止：Unsupported facts or sources；Treating retired amount as current

## M2-5（test，Orchid-10）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-10? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 589 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-10 is 589 credits.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 2 轮
Search the Orchid-10 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-10 with a supported citation.

- 必要事实：Current threshold: 589 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-10 is 589 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources；Treating retired amount as current

### 第 4 轮
As of 2026-10-27, give Orchid-10's current threshold and explain why the retired policy does not apply.

- 必要事实：Current threshold: 589 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-10 is 589 credits.
- 必要事实：Retired policy is superseded and ended 2026-09-30；允许来源：retired-policy.md, policy.md；依据：Effective until 2026-09-30 only.
- 禁止：Unsupported facts or sources；Treating retired amount as current

## M3-1（dev，Orchid-11）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-11? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 602 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-11 is 602 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search both Orchid-11 policies and receipt retention. How long are receipts kept and who approves refund exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 必要事实：Receipt retention: 37 days；允许来源：retention.md；依据：Keep refund receipts for 37 days.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-11 with a supported citation.

- 必要事实：Current threshold: 602 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-11 is 602 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-11's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 602 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-11 is 602 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M3-2（dev，Orchid-12）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-12? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 615 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-12 is 615 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search both Orchid-12 policies and receipt retention. How long are receipts kept and who approves refund exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 必要事实：Receipt retention: 37 days；允许来源：retention.md；依据：Keep refund receipts for 37 days.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-12 with a supported citation.

- 必要事实：Current threshold: 615 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-12 is 615 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-12's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 615 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-12 is 615 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M3-3（test，Orchid-13）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-13? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 628 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-13 is 628 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search both Orchid-13 policies and receipt retention. How long are receipts kept and who approves refund exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 必要事实：Receipt retention: 37 days；允许来源：retention.md；依据：Keep refund receipts for 37 days.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-13 with a supported citation.

- 必要事实：Current threshold: 628 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-13 is 628 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-13's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 628 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-13 is 628 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M3-4（test，Orchid-14）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-14? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 641 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-14 is 641 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search both Orchid-14 policies and receipt retention. How long are receipts kept and who approves refund exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 必要事实：Receipt retention: 37 days；允许来源：retention.md；依据：Keep refund receipts for 37 days.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-14 with a supported citation.

- 必要事实：Current threshold: 641 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-14 is 641 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-14's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 641 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-14 is 641 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M3-5（test，Orchid-15）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-15? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 654 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-15 is 654 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search both Orchid-15 policies and receipt retention. How long are receipts kept and who approves refund exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 必要事实：Receipt retention: 37 days；允许来源：retention.md；依据：Keep refund receipts for 37 days.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-15 with a supported citation.

- 必要事实：Current threshold: 654 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-15 is 654 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-15's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 654 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-15 is 654 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M4-1（dev，Orchid-16）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-16? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 667 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-16 is 667 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search all Orchid-16 documents again, including inventory; distinguish inventory from the refund policy.

- 必要事实：Inventory is not refund policy；允许来源：inventory-0.md, inventory-1.md, inventory-2.md, inventory-3.md, inventory-4.md, inventory-5.md, inventory-6.md, inventory-7.md, inventory-8.md, inventory-9.md, inventory-10.md, inventory-11.md, inventory-12.md, inventory-13.md, inventory-14.md, inventory-15.md；依据：This inventory is not a refund policy.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-16 with a supported citation.

- 必要事实：Current threshold: 667 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-16 is 667 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-16's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 667 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-16 is 667 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M4-2（dev，Orchid-17）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-17? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 680 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-17 is 680 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search all Orchid-17 documents again, including inventory; distinguish inventory from the refund policy.

- 必要事实：Inventory is not refund policy；允许来源：inventory-0.md, inventory-1.md, inventory-2.md, inventory-3.md, inventory-4.md, inventory-5.md, inventory-6.md, inventory-7.md, inventory-8.md, inventory-9.md, inventory-10.md, inventory-11.md, inventory-12.md, inventory-13.md, inventory-14.md, inventory-15.md；依据：This inventory is not a refund policy.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-17 with a supported citation.

- 必要事实：Current threshold: 680 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-17 is 680 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-17's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 680 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-17 is 680 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M4-3（test，Orchid-18）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-18? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 693 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-18 is 693 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search all Orchid-18 documents again, including inventory; distinguish inventory from the refund policy.

- 必要事实：Inventory is not refund policy；允许来源：inventory-0.md, inventory-1.md, inventory-2.md, inventory-3.md, inventory-4.md, inventory-5.md, inventory-6.md, inventory-7.md, inventory-8.md, inventory-9.md, inventory-10.md, inventory-11.md, inventory-12.md, inventory-13.md, inventory-14.md, inventory-15.md；依据：This inventory is not a refund policy.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-18 with a supported citation.

- 必要事实：Current threshold: 693 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-18 is 693 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-18's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 693 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-18 is 693 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M4-4（test，Orchid-19）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-19? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 706 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-19 is 706 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search all Orchid-19 documents again, including inventory; distinguish inventory from the refund policy.

- 必要事实：Inventory is not refund policy；允许来源：inventory-0.md, inventory-1.md, inventory-2.md, inventory-3.md, inventory-4.md, inventory-5.md, inventory-6.md, inventory-7.md, inventory-8.md, inventory-9.md, inventory-10.md, inventory-11.md, inventory-12.md, inventory-13.md, inventory-14.md, inventory-15.md；依据：This inventory is not a refund policy.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-19 with a supported citation.

- 必要事实：Current threshold: 706 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-19 is 706 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-19's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 706 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-19 is 706 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M4-5（test，Orchid-20）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-20? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 719 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-20 is 719 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search all Orchid-20 documents again, including inventory; distinguish inventory from the refund policy.

- 必要事实：Inventory is not refund policy；允许来源：inventory-0.md, inventory-1.md, inventory-2.md, inventory-3.md, inventory-4.md, inventory-5.md, inventory-6.md, inventory-7.md, inventory-8.md, inventory-9.md, inventory-10.md, inventory-11.md, inventory-12.md, inventory-13.md, inventory-14.md, inventory-15.md；依据：This inventory is not a refund policy.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-20 with a supported citation.

- 必要事实：Current threshold: 719 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-20 is 719 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-20's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 719 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-20 is 719 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M5-1（dev，Orchid-21）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-21? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 732 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-21 is 732 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-21 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮：compact
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-21 with a supported citation.

- 必要事实：Current threshold: 732 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-21 is 732 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮：update
The Orchid-21 policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.

- 必要事实：Current threshold: 832 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-21 is 832 credits.
- 禁止：Unsupported facts or sources；Treating old 732 credits as current

## M5-2（dev，Orchid-22）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-22? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 745 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-22 is 745 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-22 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮：compact
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-22 with a supported citation.

- 必要事实：Current threshold: 745 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-22 is 745 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮：update
The Orchid-22 policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.

- 必要事实：Current threshold: 845 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-22 is 845 credits.
- 禁止：Unsupported facts or sources；Treating old 745 credits as current

## M5-3（test，Orchid-23）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-23? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 758 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-23 is 758 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-23 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮：compact
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-23 with a supported citation.

- 必要事实：Current threshold: 758 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-23 is 758 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮：update
The Orchid-23 policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.

- 必要事实：Current threshold: 858 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-23 is 858 credits.
- 禁止：Unsupported facts or sources；Treating old 758 credits as current

## M5-4（test，Orchid-24）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-24? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 771 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-24 is 771 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-24 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮：compact
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-24 with a supported citation.

- 必要事实：Current threshold: 771 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-24 is 771 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮：update
The Orchid-24 policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.

- 必要事实：Current threshold: 871 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-24 is 871 credits.
- 禁止：Unsupported facts or sources；Treating old 771 credits as current

## M5-5（test，Orchid-25）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-25? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 784 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-25 is 784 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-25 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮：compact
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-25 with a supported citation.

- 必要事实：Current threshold: 784 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-25 is 784 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮：update
The Orchid-25 policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.

- 必要事实：Current threshold: 884 credits；允许来源：policy.md；依据：The ordinary refund threshold for Orchid-25 is 884 credits.
- 禁止：Unsupported facts or sources；Treating old 784 credits as current

## M6-1（dev，Orchid-26）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-26? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 797 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-26 is 797 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-26 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-26 with a supported citation.

- 必要事实：Current threshold: 797 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-26 is 797 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-26's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 797 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-26 is 797 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M6-2（dev，Orchid-27）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-27? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 810 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-27 is 810 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-27 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-27 with a supported citation.

- 必要事实：Current threshold: 810 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-27 is 810 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-27's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 810 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-27 is 810 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M6-3（test，Orchid-28）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-28? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 823 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-28 is 823 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-28 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-28 with a supported citation.

- 必要事实：Current threshold: 823 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-28 is 823 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-28's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 823 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-28 is 823 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M6-4（test，Orchid-29）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-29? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 836 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-29 is 836 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-29 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-29 with a supported citation.

- 必要事实：Current threshold: 836 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-29 is 836 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-29's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 836 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-29 is 836 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources

## M6-5（test，Orchid-30）
### 第 1 轮
What is the current ordinary refund threshold for Orchid-30? Include the exact amount and unit, and cite evidence.

- 必要事实：Current threshold: 849 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-30 is 849 credits.
- 禁止：Unsupported facts or sources

### 第 2 轮
Search the Orchid-30 refund sources again. Who approves exceptions, including the current policy's exceptions?

- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 禁止：Unsupported facts or sources

### 第 3 轮
Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for Orchid-30 with a supported citation.

- 必要事实：Current threshold: 849 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-30 is 849 credits.
- 工具行为：F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality.
- 禁止：Unsupported facts or sources

### 第 4 轮
Confirm Orchid-30's threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.

- 必要事实：Current threshold: 849 credits；允许来源：policy.md, table.md；依据：The ordinary refund threshold for Orchid-30 is 849 credits.
- 必要事实：Exceptions require director approval before payout；允许来源：policy.md；依据：Refund exceptions require director approval before payout.
- 无答案要求：No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver
- 禁止：Unsupported facts or sources
