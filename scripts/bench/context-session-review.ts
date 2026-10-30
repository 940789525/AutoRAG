import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contextSessionCases } from "./context-session-cases.ts";

/** Reference facts come from the authored corpus, never a model answer. Human attestation stays separate. */
export function contextSessionGold() {
	return contextSessionCases().map((task) => {
		const policy = task.documents.find((doc) => doc.name === "policy.md")!.text;
		const threshold = /threshold for .*? is (\d+ credits)/u.exec(policy)![1];
		const updated = /threshold for .*? is (\d+ credits)/u.exec(task.updatedPolicy)![1];
		return {
			id: task.id,
			family: task.family,
			split: task.split,
			group: task.group,
			documents: task.documents.map((doc) => ({
				name: doc.name,
				sha256: createHash("sha256").update(doc.text).digest("hex"),
			})),
			turns: task.turns.map((turn, index) => {
				const facts: { fact: string; sources: string[]; quote: string }[] = [];
				const amount = turn.action === "update" ? updated : threshold;
				if (index !== 1)
					facts.push({
						fact: `Current threshold: ${amount}`,
						sources: ["policy.md", ...(task.group === "M6" ? ["table.md"] : [])],
						quote: `The ordinary refund threshold for ${task.family} is ${amount}.`,
					});
				if ((index === 1 && task.group !== "M4") || (index === 3 && !["M2", "M5"].includes(task.group)))
					facts.push({
						fact: "Exceptions require director approval before payout",
						sources: ["policy.md"],
						quote: "Refund exceptions require director approval before payout.",
					});
				if (index === 1 && task.group === "M3")
					facts.push({
						fact: "Receipt retention: 37 days",
						sources: ["retention.md"],
						quote: "Keep refund receipts for 37 days.",
					});
				if (index === 1 && task.group === "M4")
					facts.push({
						fact: "Inventory is not refund policy",
						sources: task.documents.filter((doc) => doc.name.startsWith("inventory-")).map((doc) => doc.name),
						quote: "This inventory is not a refund policy.",
					});
				if (index === 3 && task.group === "M2")
					facts.push({
						fact: "Retired policy is superseded and ended 2026-09-30",
						sources: ["retired-policy.md", "policy.md"],
						quote: "Effective until 2026-09-30 only.",
					});
				return {
					index,
					question: turn.question,
					lifecycleAction: turn.action ?? null,
					facts,
					absenceRequired:
						index === 3 && !["M2", "M5"].includes(task.group)
							? "No supplied policy for NoSuchProject; disclose the absence without inventing a threshold or approver"
							: null,
					restoreExpected:
						index === 2
							? "F should restore the current branch ID with exact matching text; other arms may retrieve. This alone does not prove answer quality."
							: null,
					forbidden: [
						"Unsupported facts or sources",
						...(task.group === "M2" ? ["Treating retired amount as current"] : []),
						...(turn.action === "update" ? [`Treating old ${threshold} as current`] : []),
					],
				};
			}),
		};
	});
}

export function renderContextGoldReview(singleAgentReviewed = false): string {
	const gold = contextSessionGold();
	return [
		"# 上下文 v2：30 段会话 gold 复核包",
		"",
		singleAgentReviewed
			? "状态：已按用户确认完成单人自动来源核对（30 段、120 轮、150 条参考事实）；不属于独立人工复核。"
			: "状态：作者按合成来源编写，独立人工复核尚未完成。不得把本文件的生成或单人自动核对标成独立人工通过。",
		"请逐段核对问题、必要事实、版本及引用依据；记录姓名/日期、是否与作者独立、修正项。只有逐条复核完成才能填写 reviewed。",
		"来源为 scripts/bench/context-session-cases.ts 的自建非敏感语料；完整数据与逐条参考依据位于 .omo/evidence/context-session-gold.json。",
		"评分：每个必要事实分别判断正确/错误/遗漏；每条事实引用分别判断支持/不支持/缺失；未知项目必须明确未找到；失败与取消单列，不用关键词出现替代语义评分。",
		"注意：当前 M3 未覆盖真实 rerank/steering，M5 未覆盖真实模型取消/resume，M6 未混入实际非本地资料；这些工程边界另有测试，不能据此把这 30 段称为所有场景的完整盲测。",
		`题集指纹：${createHash("sha256").update(JSON.stringify(contextSessionCases())).digest("hex")}`,
		"",
		...gold.flatMap((task) => [
			`## ${task.id}（${task.split}，${task.family}）`,
			...task.turns.flatMap((turn) => [
				`### 第 ${turn.index + 1} 轮${turn.lifecycleAction ? `：${turn.lifecycleAction}` : ""}`,
				turn.question,
				"",
				...turn.facts.map(
					(fact) => `- 必要事实：${fact.fact}；允许来源：${fact.sources.join(", ")}；依据：${fact.quote}`,
				),
				...(turn.absenceRequired ? [`- 无答案要求：${turn.absenceRequired}`] : []),
				...(turn.restoreExpected ? [`- 工具行为：${turn.restoreExpected}`] : []),
				`- 禁止：${turn.forbidden.join("；")}`,
				"",
			]),
		]),
	].join("\n");
}

export function validateContextGold(): { cases: number; turns: number; supportedFacts: number } {
	const tasks = contextSessionCases();
	let supportedFacts = 0;
	for (const gold of contextSessionGold()) {
		const task = tasks.find((task) => task.id === gold.id)!;
		for (const turn of gold.turns) {
			const documents = task.documents.map((doc) =>
				doc.name === "policy.md" && turn.lifecycleAction === "update" ? { ...doc, text: task.updatedPolicy } : doc,
			);
			for (const fact of turn.facts) {
				if (
					!fact.sources.every((source) => documents.some((doc) => doc.name === source)) ||
					!documents.some((doc) => fact.sources.includes(doc.name) && doc.text.includes(fact.quote))
				)
					throw new Error(`Unsupported reference fact in ${gold.id}/${turn.index}: ${fact.fact}`);
				supportedFacts++;
			}
			if (turn.absenceRequired && documents.some((doc) => doc.text.includes("NoSuchProject")))
				throw new Error("Invalid no-answer reference");
		}
	}
	return { cases: tasks.length, turns: tasks.reduce((n, task) => n + task.turns.length, 0), supportedFacts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const json = resolve(process.argv[2] ?? ".omo/evidence/context-session-gold.json");
	const markdown = resolve(process.argv[3] ?? "docs/context-session-gold-review.md");
	for (const path of [json, markdown]) mkdirSync(dirname(path), { recursive: true });
	const singleAgentReviewed = process.argv.includes("--attest-single-agent");
	if (singleAgentReviewed) validateContextGold();
	writeFileSync(
		json,
		JSON.stringify(
			{
				reviewStatus: singleAgentReviewed ? "single_agent_source_checks_completed" : "pending",
				independentHumanReview: false,
				cases: contextSessionGold(),
			},
			null,
			2,
		),
	);
	writeFileSync(markdown, renderContextGoldReview(singleAgentReviewed));
	if (process.argv.includes("--attest-single-agent")) {
		const preflight = JSON.parse(readFileSync(".omo/evidence/context-completion-preflight.json", "utf8"));
		const checked = validateContextGold();
		writeFileSync(
			".omo/evidence/context-session-review-attestation.json",
			JSON.stringify(
				{
					reviewMethod: "single_agent_automated_authorized_by_user",
					independentHumanReview: false,
					userAuthorization:
						"User explicitly selected single-person automated review, with no claim of independent human approval.",
					datasetSha256: createHash("sha256").update(JSON.stringify(contextSessionCases())).digest("hex"),
					implementationSha256: preflight.implementationSha256,
					checked,
					limitations: [
						"Author and reviewer are the same agent",
						"Rubric and source checks do not establish independent semantic or human scoring",
						"Existing fixture coverage limitations remain disclosed",
					],
				},
				null,
				2,
			),
		);
	}
	console.log(JSON.stringify({ json, markdown, cases: 30, independentHumanReview: false }));
}
