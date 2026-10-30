import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { isRefreshOwnerAlive, readRefreshProgress } from "../agent/refresh-progress.ts";
import type { ResearchService } from "./service.ts";
import { errorText, ResearchError, TERMINAL_RUNS } from "./types.ts";

const text = (maxLength = 2000) => Type.String({ minLength: 1, maxLength });
const uuid = Type.String({ format: "uuid" });
const object = (properties: Parameters<typeof Type.Object>[0]) =>
	Type.Object(properties, { additionalProperties: false });
const idParams = object({ id: uuid });
const pageQuery = object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
	topicId: Type.Optional(uuid),
	reviewState: Type.Optional(Type.Union([Type.Literal("unread"), Type.Literal("later"), Type.Literal("read")])),
});

export function createResearchServer(service: ResearchService): FastifyInstance {
	const app = Fastify({
		bodyLimit: 32768,
		logger: false,
		ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
	});
	const db = service.db;
	const prefix = "/research/v1";
	const streams = new Set<ServerResponse>();
	app.addHook("preClose", async () => {
		for (const stream of streams) stream.destroy();
	});
	app.addHook("onRequest", async (request, reply) => {
		const host = request.headers.host;
		if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u.test(host))
			return reply.code(403).send({ error: "Research API accepts loopback hosts only" });
		// This local API has no browser UI; reject browser cross-origin requests and DNS rebinding.
		if (request.headers.origin || request.headers["sec-fetch-site"] === "cross-site")
			return reply.code(403).send({ error: "Browser origins are not allowed on the research API" });
	});
	app.setErrorHandler((error, _request, reply) => {
		const cause = error as Error & { code?: string; statusCode?: number };
		const status = cause.code === "23505" ? 409 : (cause.statusCode ?? 500);
		void reply.code(status).send({ error: errorText(error) });
	});
	const resource = async (table: "libraries" | "batches" | "analysis_runs" | "inbox_items", id: string) => {
		const row = (await db.pool.query(`SELECT * FROM research.${table} WHERE id=$1`, [id])).rows[0];
		if (!row) throw new ResearchError(404, `${table} resource not found`);
		return row;
	};
	const mutate = async (request: FastifyRequest, fn: (client: PoolClient) => Promise<unknown>) => {
		const key = request.headers["idempotency-key"];
		if (typeof key !== "string" || !/^[\w.:/-]{1,128}$/u.test(key))
			throw new ResearchError(400, "A 1–128 character Idempotency-Key header is required");
		return db.idempotent(key, `${request.method}:${request.url.split("?")[0]}`, request.body ?? {}, fn);
	};
	const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
	app.get(`${prefix}/health`, async () => {
		await db.pool.query("SELECT 1");
		return { api: "ok", database: "ok", modelCalled: false };
	});
	app.get(`${prefix}/overview`, async () => {
		const [libraries, topics, unread, runs, batches] = await Promise.all([
			db.pool.query("SELECT id,name,state,root_path FROM research.libraries ORDER BY created_at"),
			db.pool.query("SELECT * FROM research.topics ORDER BY id"),
			db.pool.query("SELECT count(*)::int AS n FROM research.inbox_items WHERE review_state='unread'"),
			db.pool.query(
				"SELECT id,state,asset_id,topic_snapshot,error,result FROM research.analysis_runs ORDER BY CASE WHEN state IN ('screening','reading','validating') THEN 0 WHEN state='planned' THEN 1 ELSE 2 END,created_at DESC,id LIMIT 30",
			),
			db.pool.query("SELECT id,kind,status,counts,error FROM research.batches ORDER BY created_at DESC,id LIMIT 10"),
		]);
		return {
			libraries: libraries.rows,
			topics: topics.rows,
			unread: unread.rows[0].n,
			runs: runs.rows,
			batches: batches.rows,
			modelProcessingEnabled: service.options.allowModelProcessing === true,
		};
	});
	app.post(`${prefix}/libraries`, { schema: { body: object({ name: text(200) }) } }, async (request) =>
		mutate(request, (client) => service.createLibrary(client, (request.body as { name: string }).name)),
	);
	app.get(
		`${prefix}/libraries`,
		async () => (await db.pool.query("SELECT * FROM research.libraries ORDER BY created_at")).rows,
	);
	app.post(
		`${prefix}/libraries/:id/scans`,
		{
			schema: {
				params: idParams,
				body: object({ mode: Type.Union([Type.Literal("seed"), Type.Literal("incremental")]) }),
			},
		},
		async (request, reply) => {
			const result = await mutate(request, (client) =>
				service.planScan(client, idOf(request), (request.body as { mode: "seed" | "incremental" }).mode),
			);
			return reply.code(202).send(result);
		},
	);
	app.get(`${prefix}/batches/:id`, { schema: { params: idParams } }, async (request) => {
		const batch = await resource("batches", idOf(request));
		const progress = batch.status === "indexing" ? readRefreshProgress(service.options.workspace) : undefined;
		const currentProgress =
			progress && Date.parse(progress.startedAt) >= new Date(batch.created_at).getTime() ? progress : undefined;
		return {
			...batch,
			...(currentProgress
				? {
						progress: {
							phase: currentProgress.phase,
							startedAt: currentProgress.startedAt,
							updatedAt: currentProgress.updatedAt,
							sourceFiles: currentProgress.sourceFiles,
							parsedCounts: currentProgress.parsedCounts,
							indexing: currentProgress.indexing,
							error: currentProgress.error,
							ownerAlive: isRefreshOwnerAlive(currentProgress),
						},
					}
				: {}),
			items: (
				await db.pool.query(
					"SELECT i.*,f.path FROM research.batch_items i JOIN research.file_locations f ON f.id=i.location_id WHERE i.batch_id=$1 ORDER BY i.id",
					[batch.id],
				)
			).rows,
		};
	});
	const topicBody = object({
		libraryId: uuid,
		title: text(200),
		question: text(),
		focus: Type.Array(text(200), { maxItems: 6 }),
		exclusions: Type.Array(text(200), { maxItems: 6 }),
	});
	app.post(`${prefix}/topics`, { schema: { body: topicBody } }, async (request) =>
		mutate(request, async (client) => {
			const body = request.body as {
				libraryId: string;
				title: string;
				question: string;
				focus: string[];
				exclusions: string[];
			};
			if (
				!(await client.query("SELECT id FROM research.libraries WHERE id=$1 FOR UPDATE", [body.libraryId])).rowCount
			)
				throw new ResearchError(404, "Library not found");
			if (
				(await client.query("SELECT count(*)::int AS n FROM research.topics WHERE library_id=$1", [body.libraryId]))
					.rows[0].n >= 5
			)
				throw new ResearchError(409, "Research MVP supports at most five topics");
			return (
				await client.query(
					"INSERT INTO research.topics(id,library_id,title,question,focus,exclusions) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
					[
						randomUUID(),
						body.libraryId,
						body.title,
						body.question,
						JSON.stringify(body.focus),
						JSON.stringify(body.exclusions),
					],
				)
			).rows[0];
		}),
	);
	app.get(`${prefix}/topics`, async () => (await db.pool.query("SELECT * FROM research.topics ORDER BY id")).rows);
	app.patch(
		`${prefix}/topics/:id`,
		{
			schema: {
				params: idParams,
				body: object({
					title: Type.Optional(text(200)),
					question: Type.Optional(text()),
					focus: Type.Optional(Type.Array(text(200), { maxItems: 6 })),
					exclusions: Type.Optional(Type.Array(text(200), { maxItems: 6 })),
					active: Type.Optional(Type.Boolean()),
				}),
			},
		},
		async (request) =>
			mutate(request, async (client) => {
				const body = request.body as {
					title?: string;
					question?: string;
					focus?: string[];
					exclusions?: string[];
					active?: boolean;
				};
				const result = await client.query(
					"UPDATE research.topics SET title=COALESCE($2,title),question=COALESCE($3,question),focus=COALESCE($4,focus),exclusions=COALESCE($5,exclusions),active=COALESCE($6,active),revision=revision+1 WHERE id=$1 RETURNING *",
					[
						idOf(request),
						body.title,
						body.question,
						body.focus === undefined ? null : JSON.stringify(body.focus),
						body.exclusions === undefined ? null : JSON.stringify(body.exclusions),
						body.active,
					],
				);
				if (!result.rows[0]) throw new ResearchError(404, "Topic not found");
				await client.query("UPDATE research.inbox_items SET validity='revision_changed' WHERE topic_id=$1", [
					idOf(request),
				]);
				return result.rows[0];
			}),
	);
	app.get(`${prefix}/papers`, { schema: { querystring: pageQuery } }, async (request) => {
		const page = request.query as { limit?: number; offset?: number };
		return (
			await db.pool.query(
				"SELECT p.*,COALESCE((SELECT jsonb_agg(a ORDER BY a.created_at) FROM research.paper_assets a WHERE a.paper_id=p.id),'[]') AS assets FROM research.papers p ORDER BY p.id LIMIT $1 OFFSET $2",
				[page.limit ?? 50, page.offset ?? 0],
			)
		).rows;
	});
	app.patch(
		`${prefix}/papers/:id`,
		{
			schema: {
				params: idParams,
				body: object({
					doi: Type.Optional(text(300)),
					arxivId: Type.Optional(text(100)),
					title: Type.Optional(text(400)),
					assignToPaperId: Type.Optional(uuid),
				}),
			},
		},
		async (request) =>
			mutate(request, (client) =>
				service.resolveIdentity(
					client,
					idOf(request),
					request.body as Parameters<ResearchService["resolveIdentity"]>[2],
				),
			),
	);
	app.post(
		`${prefix}/papers/:id/analyses`,
		{ schema: { params: idParams, body: object({ assetId: uuid, topicId: uuid }) } },
		async (request, reply) => {
			const result = await mutate(request, async (client) => {
				const body = request.body as { assetId: string; topicId: string };
				if (
					!(
						await client.query("SELECT 1 FROM research.paper_assets WHERE id=$1 AND paper_id=$2", [
							body.assetId,
							idOf(request),
						])
					).rowCount
				)
					throw new ResearchError(404, "Paper asset not found");
				return service.planAnalysis(client, body.assetId, body.topicId);
			});
			return reply.code(202).send(result);
		},
	);
	app.get(`${prefix}/inbox`, { schema: { querystring: pageQuery } }, async (request) => {
		const page = request.query as { limit?: number; offset?: number; topicId?: string; reviewState?: string };
		return (
			await db.pool.query(
				"SELECT id,topic_id,asset_id,run_id,payload->>'title' AS title,priority,relevance,review_state,validity,created_at FROM research.inbox_items WHERE ($1::uuid IS NULL OR topic_id=$1) AND ($2::text IS NULL OR review_state=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4",
				[page.topicId, page.reviewState, page.limit ?? 50, page.offset ?? 0],
			)
		).rows;
	});
	app.get(`${prefix}/inbox/:id`, { schema: { params: idParams } }, async (request) => {
		const item = await resource("inbox_items", idOf(request));
		try {
			for (const entry of item.evidence) await service.runtime.verify(entry);
		} catch (error) {
			await db.pool.query("UPDATE research.inbox_items SET validity='source_unavailable' WHERE id=$1", [item.id]);
			return { ...item, validity: "source_unavailable", verificationError: errorText(error) };
		}
		return item;
	});
	app.post(
		`${prefix}/inbox/:id/feedback`,
		{
			schema: {
				params: idParams,
				body: object({
					kind: Type.Union([Type.Literal("usefulness"), Type.Literal("relevance"), Type.Literal("reading_state")]),
					value: text(30),
					comment: Type.Optional(text(1000)),
				}),
			},
		},
		async (request) =>
			mutate(request, async (client) => {
				const body = request.body as { kind: string; value: string; comment?: string };
				const values =
					body.kind === "reading_state"
						? ["unread", "later", "read"]
						: body.kind === "usefulness"
							? ["useful", "not_useful"]
							: ["relevant", "not_relevant"];
				if (!values.includes(body.value)) throw new ResearchError(400, "Invalid feedback value for kind");
				if (
					!(await client.query("SELECT id FROM research.inbox_items WHERE id=$1 FOR UPDATE", [idOf(request)]))
						.rowCount
				)
					throw new ResearchError(404, "Inbox item not found");
				if (body.kind === "reading_state")
					await client.query("UPDATE research.inbox_items SET review_state=$2 WHERE id=$1", [
						idOf(request),
						body.value,
					]);
				return (
					await client.query(
						"INSERT INTO research.feedback(id,item_id,kind,value,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(item_id,kind) DO UPDATE SET value=$4,comment=$5 RETURNING *",
						[randomUUID(), idOf(request), body.kind, body.value, body.comment],
					)
				).rows[0];
			}),
	);
	app.get(`${prefix}/runs/:id`, { schema: { params: idParams } }, (request) =>
		resource("analysis_runs", idOf(request)),
	);
	app.post(`${prefix}/runs/:id/cancel`, { schema: { params: idParams } }, async (request) => {
		const result = await mutate(request, (client) => service.cancel(client, idOf(request)));
		service.abortCancelled(idOf(request));
		return result;
	});
	app.post(`${prefix}/runs/:id/retry`, { schema: { params: idParams } }, async (request, reply) =>
		reply.code(202).send(await mutate(request, (client) => service.retry(client, idOf(request)))),
	);
	app.get(`${prefix}/runs/:id/events`, { schema: { params: idParams } }, async (request, reply) => {
		const runId = idOf(request);
		await resource("analysis_runs", runId);
		const header = request.headers["last-event-id"] ?? "0";
		if (typeof header !== "string" || !/^\d{1,10}$/u.test(header))
			throw new ResearchError(400, "Invalid Last-Event-ID");
		let cursor = Number(header);
		const first = (await db.pool.query("SELECT min(seq) AS seq FROM research.run_events WHERE run_id=$1", [runId]))
			.rows[0].seq;
		if (first && cursor > 0 && cursor < first - 1)
			throw new ResearchError(410, "Event history expired; fetch the run status");
		reply.hijack();
		streams.add(reply.raw);
		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		let polling = false;
		const send = async () => {
			if (polling || reply.raw.destroyed) return;
			polling = true;
			try {
				const events = (
					await db.pool.query(
						"SELECT seq,type,payload FROM research.run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 100",
						[runId, cursor],
					)
				).rows;
				for (const event of events) {
					if (cursor && event.seq !== cursor + 1) {
						reply.raw.write('event: reset\ndata: {"reason":"history_expired"}\n\n');
						reply.raw.end();
						return;
					}
					reply.raw.write(
						`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ state: event.type })}\n\n`,
					);
					cursor = event.seq;
					if (reply.raw.writableLength > 256 * 1024) {
						reply.raw.destroy();
						return;
					}
				}
				const current = await resource("analysis_runs", runId);
				if (TERMINAL_RUNS.includes(current.state) && cursor >= current.last_event_seq) reply.raw.end();
			} catch (error) {
				reply.raw.destroy(error instanceof Error ? error : new Error(errorText(error)));
			} finally {
				polling = false;
			}
		};
		const timer = setInterval(() => {
			void send();
		}, 500);
		const heartbeat = setInterval(() => {
			reply.raw.write(": heartbeat\n\n");
		}, 15000);
		reply.raw.on("close", () => {
			streams.delete(reply.raw);
			clearInterval(timer);
			clearInterval(heartbeat);
		});
		await send();
	});
	return app;
}
