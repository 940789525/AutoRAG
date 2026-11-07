import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prepareGitHubReview } from "../../scripts/manual-qa/github-mcp-review.ts";

it("generates a review packet offline, rejects pending/tampered reviews, and records an explicit fixture review", () => {
	const root = mkdtempSync(join(tmpdir(), "autorag-review-packet-test-"));
	const script = fileURLToPath(new URL("../../scripts/manual-qa/run-qa-github-mcp.mts", import.meta.url));
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
	try {
		const source = join(root, "source.json");
		const output = join(root, "packet");
		writeFileSync(
			source,
			JSON.stringify({
				runId: "fixture-review",
				cases: [
					{
						caseId: "pr/0/direct/cold",
						sample: "pr",
						exposure: "direct",
						phase: "cold",
						repetition: 0,
						status: "NOT_RUN",
						automaticChecks: "PASS",
						ciReview: "NOT_APPLICABLE",
						response: { answer: "A", results: [] },
						trace: [],
					},
				],
			}),
		);
		expect(run("--prepare-review", source, "--output", output).status).toBe(0);
		const reportPath = join(output, "report.json");
		const reviewsPath = join(output, "reviews.pending.json");
		const before = readFileSync(reportPath, "utf8");
		expect(existsSync(join(output, "review.html"))).toBe(true);
		expect(run("--review", reportPath, "--reviews", reviewsPath).status).toBe(1);
		expect(readFileSync(reportPath, "utf8")).toBe(before);
		const reviews = JSON.parse(readFileSync(reviewsPath, "utf8"));
		reviews.reviewer = "Fixture Reviewer";
		reviews.reviewedAt = "2026-11-04T00:00:00Z";
		reviews.cases["pr/0/direct/cold"] = {
			businessReview: "PASS",
			ciReview: "NOT_APPLICABLE",
			comparable: false,
			citationsChecked: 1,
			citationsValid: 1,
			unsupportedClaimCount: 0,
		};
		writeFileSync(reviewsPath, JSON.stringify(reviews));
		writeFileSync(reportPath, `${before} `);
		expect(run("--review", reportPath, "--reviews", reviewsPath).stderr).toContain("report changed");
		writeFileSync(reportPath, before);
		expect(run("--review", reportPath, "--reviews", reviewsPath).status).toBe(0);
		expect(JSON.parse(readFileSync(reportPath, "utf8")).humanReview.reviewer).toBe("Fixture Reviewer");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("prepares inert, unapproved review material bound to the captured report", () => {
	const packet = prepareGitHubReview(
		{
			runId: "r",
			cases: [
				{
					caseId: "pr/0/direct/cold",
					automaticChecks: "PASS",
					ciReview: "NOT_APPLICABLE",
					query: "<script>alert(1)</script>",
					response: { answer: "A", results: [] },
					trace: [],
				},
			],
		},
		"source-hash",
	);
	expect(packet.html).toContain("&lt;script&gt;");
	expect(packet.html).not.toContain("<script>");
	expect(packet.reviews.reviewer).toBeNull();
	expect(packet.reviews.cases["pr/0/direct/cold"].businessReview).toBe("NOT_RUN");
	expect(packet.reviews.reportSha256).toHaveLength(64);
});

it("reports missing real-service prerequisites as SKIP and proves config preservation and cleanup", () => {
	const root = mkdtempSync(join(tmpdir(), "autorag-github-qa-test-"));
	try {
		const output = join(root, "report.json");
		const env = { ...process.env };
		delete env.GITHUB_MCP_TOKEN;
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../../scripts/manual-qa/run-qa-github-mcp.mts", import.meta.url)), "--output", output],
			{ encoding: "utf8", env },
		);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(readFileSync(output, "utf8"));
		expect(report.L3.status).toBe("SKIP");
		expect(report.L4.status).toBe("SKIP");
		expect(report.comparison.status).toBe("SKIP");
		expect(report.cases).toEqual([]);
		expect(report.realConfigBefore).toEqual(report.realConfigAfter);
		expect(report.cleanup).toEqual({ tempRootRemoved: true, stoppedOnlyOwnedClients: true });
		expect(existsSync(output)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("applies reviews offline without letting a human override failed automatic checks", () => {
	const root = mkdtempSync(join(tmpdir(), "autorag-github-review-test-"));
	try {
		const reportPath = join(root, "report.json");
		const reviewsPath = join(root, "reviews.json");
		writeFileSync(
			reportPath,
			JSON.stringify({
				runId: "review-run",
				cases: [
					{ caseId: "pr/0/direct/cold", status: "FAIL", automaticChecks: "FAIL", ciReview: "NOT_APPLICABLE" },
				],
			}),
		);
		writeFileSync(
			reviewsPath,
			JSON.stringify({
				runId: "review-run",
				reviewer: "Fixture Reviewer",
				reviewedAt: "2026-11-04T00:00:00Z",
				cases: {
					"pr/0/direct/cold": {
						businessReview: "PASS",
						ciReview: "NOT_APPLICABLE",
						comparable: true,
						citationsChecked: 2,
						citationsValid: 2,
						unsupportedClaimCount: 0,
					},
				},
			}),
		);
		const run = () =>
			spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("../../scripts/manual-qa/run-qa-github-mcp.mts", import.meta.url)),
					"--review",
					reportPath,
					"--reviews",
					reviewsPath,
				],
				{ encoding: "utf8", timeout: 5000 },
			);
		expect(run().status).toBe(1);
		expect(JSON.parse(readFileSync(reportPath, "utf8")).cases[0].status).toBe("FAIL");
		const before = readFileSync(reportPath, "utf8");
		writeFileSync(reviewsPath, JSON.stringify({ runId: "another-run", cases: {} }));
		expect(run().status).toBe(1);
		expect(readFileSync(reportPath, "utf8")).toBe(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
