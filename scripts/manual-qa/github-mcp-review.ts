import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { githubPayloads } from "./github-mcp-acceptance.ts";

/** Prepare evidence for a human. This function never records an approval. */
export function prepareGitHubReview(raw: Record<string, any>, sourceSha256: string) {
	const report = Array.isArray(raw.cases) ? structuredClone(raw) : {
		version: 1,
		runId: `legacy-ci-${sourceSha256.slice(0, 16)}`,
		date: raw.date,
		implementationSha256: raw.implementationSha256,
		cases: [{
			...raw.validation,
			caseId: "identity-ci/0/codemode/cold", sample: "identity-ci", repetition: 0, exposure: "codemode", phase: "cold",
			query: raw.query, response: raw.response, trace: raw.trace, durationMs: raw.durationMs,
		}],
	};
	assert(typeof report.runId === "string" && report.cases.length > 0, "A captured run is required");
	assert(report.cases.every((row: any) => row.caseId && row.response && Array.isArray(row.trace)), "Cases need stable IDs, answers and tool traces");
	report.reviewSourceSha256 = sourceSha256;
	const reportText = `${JSON.stringify(report, null, 2)}\n`;
	const reviews = {
		runId: report.runId,
		reportSha256: createHash("sha256").update(reportText).digest("hex"),
		reviewer: null,
		reviewedAt: null,
		cases: Object.fromEntries(report.cases.map((row: any) => [row.caseId, {
			businessReview: "NOT_RUN", ciReview: row.ciReview === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "NOT_RUN",
			comparable: false, citationsChecked: null, citationsValid: null, unsupportedClaimCount: null,
		}])),
	};
	const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
	const sections = report.cases.map((row: any) => `<section><h2>${escape(row.caseId)}</h2>
<p>自动检查：${escape(row.automaticChecks)}；人工：待复核。逐项核对事实、引用、读取范围、CI 身份和两组数据可比性。</p>
<h3>问题与回答</h3><pre>${escape(row.query)}\n\n${escape(row.response.answer)}</pre>
<h3>编号来源与实际证据</h3>${row.response.results.map((result: any) => `<details><summary>[${escape(result.number)}] ${escape(result.source)}</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre></details>`).join("")}
<h3>实际 MCP 返回（含失败及空结果）</h3>${row.trace.filter((call: any) => call.tool.startsWith("mcp__github__")).map((call: any) => `<details><summary>${escape(call.tool)} ${escape(call.parameters?.method)} — ${escape(call.status)}</summary><pre>${escape(JSON.stringify({ parameters: call.parameters, result: githubPayloads(call.result) }, null, 2))}</pre></details>`).join("")}</section>`).join("\n");
	const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>GitHub PR 人工验收</title>
<style>body{max-width:1080px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}section{border-top:2px solid #cbd5e1;margin-top:32px}summary{cursor:pointer}details{margin:10px 0}</style>
<h1>GitHub PR 人工验收材料</h1><p>runId：${escape(report.runId)}<br>原始记录 SHA-256：${escape(sourceSha256)}</p>
<p>这是历史冻结快照。GitHub 当前页面可能已变化，先核对本页捕获的原始返回。此材料没有预填人工通过；请在 reviews.pending.json 中填写真实复核结果、姓名和时间。</p>
${sections}</html>`;
	return { reportText, reviews, html };
}
