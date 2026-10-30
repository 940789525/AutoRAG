import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import { normalizeIdentity, stablePdfs, within } from "../../src/research/discovery.ts";
import { evidenceId, noteSchema, structuredReading, validateNote } from "../../src/research/reader.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() {
	const root = await mkdtemp(join(tmpdir(), "research-unit-"));
	roots.push(root);
	return root;
}

import { note, target } from "./fixtures.ts";

describe("research evidence and discovery boundaries", () => {
	it("rejects fabricated IDs, foreign-only claims and unsupported comparisons", () => {
		assert.doesNotThrow(() => validateNote(note(), [target], target.id));
		assert.throws(() => validateNote(note(["fake"]), [target], target.id), /Unknown evidence/);
		const old = { ...target, id: "old", evidenceId: "ev-old" };
		assert.throws(() => validateNote(note([old.evidenceId]), [target, old], target.id), /new paper/);
		assert.throws(() => validateNote({ ...note(), comparability: "comparable" }, [target], target.id), /both papers/);
		assert.throws(() => validateNote({ ...note(), page: 4 }, [target], target.id), /Invalid paper note/);
		assert.notEqual(evidenceId("a", "b", 0, 1), evidenceId("a", "c", 0, 1));
	});
	it("scans stable PDFs without following links, temporary downloads or hidden state", async () => {
		const root = await temp();
		await mkdir(join(root, "nested"));
		await mkdir(join(root, ".autorag"));
		await writeFile(join(root, "nested", "A.PDF"), "public fixture");
		await writeFile(join(root, "partial.pdf.part"), "not complete");
		await writeFile(join(root, ".autorag", "hidden.pdf"), "state");
		await symlink(join(root, "nested", "A.PDF"), join(root, "link.pdf"));
		const result = await stablePdfs(root, undefined, 1);
		assert.deepEqual(
			result.files.map((file) => file.path),
			[join(root, "nested", "A.PDF")],
		);
		assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/u);
		assert(!within(root, `${root}-sibling/a.pdf`));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(stablePdfs(root, controller.signal, 1));
	});
	it("normalizes explicit work identifiers without using titles", () => {
		assert.deepEqual(normalizeIdentity("https://doi.org/10.1234/ABC", "https://arxiv.org/pdf/2501.12345v2.pdf"), {
			doi: "10.1234/abc",
			arxivId: "2501.12345",
		});
		assert.throws(() => normalizeIdentity("a title", undefined), /Invalid DOI/);
	});
	it("uses the real Pi profile with only the structured submission tool", async () => {
		const root = await temp();
		const agentDir = join(root, "agent");
		await mkdir(agentDir);
		await writeFile(join(root, "AGENTS.md"), "PRIVATE-INSTRUCTION-MARKER");
		const provider = registerFauxProvider({
			api: `faux-research-${Date.now()}`,
			provider: "faux-research",
			models: [{ id: "reader", reasoning: false }],
		});
		const tools = new Set<string>();
		let system = "";
		provider.setResponses([
			(context) => {
				for (const message of context.messages)
					if (message.role === "system") {
						for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
						system += JSON.stringify(message);
					}
				return fauxAssistantMessage(fauxToolCall("submit_paper_note", JSON.parse(JSON.stringify(note()))));
			},
			fauxAssistantMessage("done"),
		]);
		try {
			const result = await structuredReading(
				{ cwd: root, agentDir, env: {}, model: { model: provider.getModel() } },
				"Use supplied evidence only",
				noteSchema,
				(value) => {
					validateNote(value, [target], target.id);
					return value;
				},
				new AbortController().signal,
			);
			assert.equal(result.title, "Paper");
			assert.deepEqual([...tools], ["submit_paper_note"]);
			assert(!system.includes("PRIVATE-INSTRUCTION-MARKER"));
		} finally {
			provider.unregister();
		}
	});
});
