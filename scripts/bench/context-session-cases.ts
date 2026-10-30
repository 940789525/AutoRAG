/** Deterministic, non-sensitive task specifications. Gold terms need independent review before release grading. */
export interface ContextSessionCase {
	readonly id: string;
	readonly group: string;
	readonly family: string;
	readonly split: "dev" | "test";
	readonly documents: readonly { name: string; text: string }[];
	readonly turns: readonly { question: string; goldTerms: readonly string[]; action?: "compact" | "update" }[];
	readonly updatedPolicy: string;
}

export function contextSessionCases(): ContextSessionCase[] {
	return Array.from({ length: 30 }, (_, index) => {
		const group = Math.floor(index / 5) + 1;
		const family = `Orchid-${index + 1}`;
		const amount = 472 + index * 13;
		const threshold = `${amount} credits`;
		const updated = `${amount + 100} credits`;
		const policy = `# ${family} current policy\n\nEffective 2026-10-01. The ordinary refund threshold for ${family} is ${threshold}. Refund exceptions require director approval before payout.\n\nFinance acknowledged the current policy in the October review.\n`;
		const documents = [{ name: "policy.md", text: policy }];
		if (group === 2)
			documents.push({
				name: "retired-policy.md",
				text: `# Retired ${family} policy\n\nEffective until 2026-09-30 only. The OLD ordinary refund threshold was ${amount - 100} credits. This version is superseded by the current policy.\n`,
			});
		if (group === 3)
			documents.push({
				name: "retention.md",
				text: `# ${family} record retention\n\nKeep refund receipts for 37 days. Refund exceptions still require director approval.\n`,
			});
		if (group === 4)
			for (let filler = 0; filler < 16; filler++)
				documents.push({
					name: `inventory-${filler}.md`,
					text: `# ${family} garden inventory ${filler}\n\n${Array.from({ length: 12 }, (_, row) => `Section ${row}: ${family} garden ${filler} contains ${row + 20} chairs and needs weekly inspection. This inventory is not a refund policy. `).join("\n\n")}\n`,
				});
		if (group === 6)
			documents.push({
				name: "table.md",
				text: `# ${family} 中文辅助说明\n\n| Rule | Value |\n| --- | --- |\n| ordinary refund threshold | ${threshold} |\n| exception approver | director |\n\n表格与当前制度一致；不要将花园库存用作退款依据。\n`,
			});
		return {
			id: `M${group}-${(index % 5) + 1}`,
			group: `M${group}`,
			family,
			split: index % 5 < 2 ? "dev" : "test",
			documents,
			updatedPolicy: policy.replace(threshold, updated),
			turns: [
				{
					question: `What is the current ordinary refund threshold for ${family}? Include the exact amount and unit, and cite evidence.`,
					goldTerms: [threshold],
				},
				{
					question:
						group === 4
							? `Search all ${family} documents again, including inventory; distinguish inventory from the refund policy.`
							: group === 3
								? `Search both ${family} policies and receipt retention. How long are receipts kept and who approves refund exceptions?`
								: `Search the ${family} refund sources again. Who approves exceptions, including the current policy's exceptions?`,
					goldTerms: group === 3 ? ["37 days", "director"] : group === 4 ? ["inventory", "refund"] : ["director"],
				},
				{
					question: `Restore and read the complete original text of evidence {{evidenceId}} if a direct evidence-read tool is available; otherwise use your existing retrieval tools. State the current threshold for ${family} with a supported citation.`,
					goldTerms: [threshold],
					...(group === 5 ? { action: "compact" as const } : {}),
				},
				{
					question:
						group === 5
							? `The ${family} policy has just been updated. Recheck the sources and give the current threshold; do not treat old evidence as the updated text.`
							: group === 2
								? `As of 2026-10-27, give ${family}'s current threshold and explain why the retired policy does not apply.`
								: `Confirm ${family}'s threshold and exception approver, and say whether you found a policy for an unknown project called NoSuchProject. Do not invent one.`,
					goldTerms: [
						group === 5 ? updated : threshold,
						...(group === 5 ? [] : group === 2 ? ["retired"] : ["director"]),
					],
					...(group === 5 ? { action: "update" as const } : {}),
				},
			],
		};
	});
}
