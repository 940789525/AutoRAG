import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

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
