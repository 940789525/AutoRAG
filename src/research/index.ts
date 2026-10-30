#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import watcher from "@parcel/watcher";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ResearchDatabase } from "./database.ts";
import { createResearchRuntime } from "./runtime.ts";
import { createResearchServer } from "./server.ts";
import { ResearchService } from "./service.ts";
import { errorText } from "./types.ts";
import { startResearchWorker } from "./worker.ts";

export const configSchema = Type.Object(
	{
		root: Type.String({ minLength: 1 }),
		workspace: Type.String({ minLength: 1 }),
		runtimeConfig: Type.String({ minLength: 1 }),
		agentDir: Type.String({ minLength: 1 }),
		databaseUrlEnv: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
		databasePasswordFileEnv: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" })),
		allowModelProcessing: Type.Boolean(),
		port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
	},
	{ additionalProperties: false },
);

export async function startResearch(configPath: string) {
	if (!isAbsolute(configPath)) throw new Error("Research config must be an absolute path");
	const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
	if (!Value.Check(configSchema, config))
		throw new Error(
			`Invalid research config: ${[...Value.Errors(configSchema, config)].map((error) => error.message).join("; ")}`,
		);
	for (const path of [config.root, config.workspace, config.runtimeConfig, config.agentDir])
		if (!isAbsolute(path)) throw new Error("All research configuration paths must be absolute");
	let databaseUrl = process.env[config.databaseUrlEnv];
	if (!databaseUrl) throw new Error(`Database URL environment variable ${config.databaseUrlEnv} is missing`);
	if (config.databasePasswordFileEnv) {
		const passwordFile = process.env[config.databasePasswordFileEnv];
		if (!passwordFile || !isAbsolute(passwordFile))
			throw new Error(
				`Set ${config.databasePasswordFileEnv} to an absolute secret-file path. For the development container, run: node scripts/dev/setup-research.mjs on the host`,
			);
		const url = new URL(databaseUrl);
		url.password = (await readFile(passwordFile, "utf8")).trim();
		databaseUrl = url.href;
	}
	const runtime = await createResearchRuntime(config);
	const db = new ResearchDatabase(databaseUrl);
	let worker: Awaited<ReturnType<typeof startResearchWorker>> | undefined;
	let subscription: Awaited<ReturnType<typeof watcher.subscribe>> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let firstHint = 0;
	let reconcile: NodeJS.Timeout | undefined;
	const service = new ResearchService(db, runtime, {
		allowModelProcessing: config.allowModelProcessing,
		root: await realpath(config.root),
		workspace: await realpath(config.workspace),
	});
	const app = createResearchServer(service);
	let stopped = false;
	let reconciling = false;
	const scan = async () => {
		if (stopped || reconciling) return;
		reconciling = true;
		try {
			for (const library of (await db.pool.query("SELECT id FROM research.libraries WHERE state='active'")).rows)
				await db.transaction((client) => service.planScan(client, library.id, "incremental"));
			await worker?.dispatch();
		} finally {
			reconciling = false;
		}
	};
	const report = (error: unknown) => console.error(errorText(error));
	const close = async () => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		clearInterval(reconcile);
		await subscription?.unsubscribe();
		await app.close();
		await worker?.stop();
		await db.close();
	};
	try {
		await db.migrate();
		const libraries = (await db.pool.query("SELECT root_path,workspace_path FROM research.libraries")).rows;
		if (
			libraries.some(
				(row) => row.root_path !== service.options.root || row.workspace_path !== service.options.workspace,
			)
		)
			throw new Error("Research database belongs to a different root/workspace");
		worker = await startResearchWorker(service, databaseUrl);
		subscription = await watcher.subscribe(config.root, (error, events) => {
			if (error) {
				report(error);
				return;
			}
			if (
				!events.some(
					(event) =>
						/\.pdf$/iu.test(event.path) && !event.path.split(/[\\/]/u).some((part) => part.startsWith(".")),
				)
			)
				return;
			firstHint ||= Date.now();
			clearTimeout(timer);
			timer = setTimeout(
				() => {
					firstHint = 0;
					void scan().catch(report);
				},
				Math.max(0, Math.min(5000, 30000 - (Date.now() - firstHint))),
			);
		});
		reconcile = setInterval(() => {
			void scan().catch(report);
		}, 300000);
		await scan();
		await app.listen({ host: "127.0.0.1", port: config.port ?? 8765 });
		return { app, service, worker, close };
	} catch (error) {
		await close();
		throw error;
	}
}

function isInvokedDirectly(): boolean {
	try {
		return (
			process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isInvokedDirectly()) {
	const configPath = process.argv[2];
	if (!configPath) {
		console.error("Usage: autorag-research /absolute/path/research.local.json");
		process.exitCode = 1;
	} else
		void startResearch(configPath)
			.then((running) => {
				const stop = () => {
					void running.close().catch((error) => {
						console.error(errorText(error));
						process.exitCode = 1;
					});
				};
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
				console.log(
					`Research inbox listening at ${running.app.server.address() && `http://127.0.0.1:${(running.app.server.address() as { port: number }).port}/research/v1`}`,
				);
			})
			.catch((error) => {
				console.error(errorText(error));
				process.exitCode = 1;
			});
}
