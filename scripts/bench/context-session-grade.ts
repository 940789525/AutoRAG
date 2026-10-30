import { basename } from "node:path";
import { contextSessionGold } from "./context-session-review.ts";

const goldCases = contextSessionGold();

export interface GradeTurn {
	readonly turnIndex?: number;
	readonly status: string;
	readonly answer?: string;
	readonly results?: readonly { number: number; source?: string; evidence?: readonly { excerpt: string }[] }[];
	readonly evidence?: readonly { id: string; source: string; content: string }[];
}
const normalize = (text: string) =>
	text.normalize("NFKC").replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const approver = /\bdirector\b|总监|董事|主管董事|이사/iu;
const beforePayout = /before (?:the )?(?:payout|payment)|(?:付|支|发放)款?前|支付前|지급.{0,20}전/iu;
const negative = /\b(?:not|never|isn't|is not)\b|不是|并非|无需|不需要|아니|필요.{0,3}없/iu;

function matchesFact(text: string, fact: string): boolean {
	const clean = normalize(text);
	if (fact.startsWith("Current threshold:")) {
		const amount = /\d+/u.exec(fact)![0];
		const match = new RegExp(`${amount}\\s*(?:credits?|积分|额度|크레딧)`, "iu").exec(clean);
		return !!match && !negative.test(clean.slice(Math.max(0, match.index - 20), match.index));
	}
	if (fact.startsWith("Exceptions"))
		return (
			approver.test(clean) &&
			beforePayout.test(clean) &&
			!/not (?:a )?director|不是总监|无需.{0,8}批准/iu.test(clean)
		);
	if (fact.startsWith("Receipt")) return /37\s*(?:days?|天|일)/iu.test(clean);
	if (fact.startsWith("Inventory"))
		return /(?:inventory|garden).{0,100}(?:not|unrelated|separate|different)|库存.{0,80}(?:不是|无关|不同)|재고.{0,80}(?:아니|별개)/iu.test(
			clean,
		);
	return /2026[-/.]09[-/.]30/u.test(clean) && /retired|supersed|expired|旧版|过期|失效|폐기|종료/iu.test(clean);
}

/** Conservative automated rubric: unrecognized wording stays needs_review, never an invented semantic pass. */
export function gradeContextTurn(caseId: string, turn: GradeTurn) {
	const task = goldCases.find((task) => task.id === caseId);
	const gold = task?.turns[turn.turnIndex ?? -1];
	if (!gold || turn.status !== "completed")
		return {
			status: "failed" as const,
			reason: "missing_or_failed_turn",
			facts: [],
			danglingCitations: [] as string[],
		};
	const answer = turn.answer ?? "";
	const results = new Map((turn.results ?? []).map((result) => [String(result.number), result]));
	const evidence = new Map((turn.evidence ?? []).map((entry) => [entry.id, entry]));
	const references = (text: string) => [...text.matchAll(/\[(e?[1-9][0-9]*)\]/gu)].map((match) => match[1]);
	const dangling = references(answer).filter((id) => !results.has(id) && !evidence.has(id));
	const paragraphs = answer.split(/\n\s*\n/u);
	const facts = gold.facts.map((fact) => {
		const matching = paragraphs.filter((paragraph) => matchesFact(paragraph, fact.fact));
		const cited = matching
			.flatMap((paragraph) => references(paragraph))
			.some((id) => {
				const result = results.get(id);
				const entry = evidence.get(id);
				const source = result?.source ?? entry?.source;
				const excerpts = result?.evidence?.map((item) => item.excerpt).join("\n") ?? entry?.content ?? "";
				if (!source || !fact.sources.includes(basename(source))) return false;
				if (normalize(excerpts).includes(normalize(fact.quote))) return true;
				return (
					fact.fact.startsWith("Current threshold:") &&
					basename(source) === "table.md" &&
					/threshold/iu.test(excerpts) &&
					normalize(excerpts).includes(/\d+ credits/u.exec(fact.fact)![0])
				);
			});
		return {
			fact: fact.fact,
			recognized: matching.length > 0,
			citationSupported: cited,
			status: cited ? "supported" : "needs_review",
		};
	});
	const absent =
		!gold.absenceRequired ||
		/(?:not found|no .{0,30}policy|未找到|没有找到|未检索到|未发现|확인되지|찾지 못|없)[^\n]{0,100}NoSuchProject|NoSuchProject[^\n]{0,100}(?:not found|no .{0,30}policy|未找到|没有|未检索到|未发现|확인되지|찾지 못|없)/iu.test(
			answer.replace(/[*_`]/gu, ""),
		);
	return {
		status: dangling.length
			? ("failed" as const)
			: facts.every((fact) => fact.citationSupported) && absent
				? ("supported_by_automated_rubric" as const)
				: ("needs_review" as const),
		facts,
		absenceDisclosed: absent,
		danglingCitations: dangling,
	};
}

export function gradeContextTrial(trial: { caseId: string; status: string; turns?: readonly GradeTurn[] }) {
	const expected = goldCases.find((task) => task.id === trial.caseId)?.turns.length ?? 0;
	const turns = (trial.turns ?? []).map((turn) => gradeContextTurn(trial.caseId, turn));
	return {
		status:
			trial.status !== "completed" || turns.length !== expected || turns.some((turn) => turn.status === "failed")
				? "failed"
				: turns.every((turn) => turn.status === "supported_by_automated_rubric")
					? "supported_by_automated_rubric"
					: "needs_review",
		turns,
	};
}
