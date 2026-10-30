import { ResearchDatabase } from "../../src/research/database.ts";
import { ResearchService } from "../../src/research/service.ts";
import { startResearchWorker } from "../../src/research/worker.ts";
import { fixtureRuntime } from "./fixture-runtime.ts";

const databaseUrl = process.env.AUTORAG_RESEARCH_TEST_DATABASE_URL!;
const root = process.env.RESEARCH_QA_ROOT!;
const db = new ResearchDatabase(databaseUrl);
const fixture = fixtureRuntime(root);
const screen = fixture.runtime.screen;
fixture.runtime.screen = async (...args) => {
	await db.pool.query("INSERT INTO research.qa_calls(phase) VALUES('screen')");
	return screen(...args);
};
const read = fixture.runtime.read;
fixture.runtime.read = async (...args) => {
	await db.pool.query("INSERT INTO research.qa_calls(phase) VALUES('read')");
	if (process.env.RESEARCH_QA_CRASH === "1") await new Promise<void>(() => {});
	return read(...args);
};
const service = new ResearchService(db, fixture.runtime, { root, workspace: `${root}-workspace`, stabilityMs: 1 });
const worker = await startResearchWorker(service, databaseUrl);
process.on("SIGTERM", () => {
	void worker
		.stop()
		.then(() => db.close())
		.then(() => process.exit(0));
});
setInterval(() => {}, 1000);
