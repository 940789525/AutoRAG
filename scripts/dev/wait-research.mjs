#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";

console.log("正在等待论文研读服务就绪…");
const end = Date.now() + 45000;
let ready = false;
while (Date.now() < end) {
	try {
		const response = await fetch("http://127.0.0.1:8765/research/v1/health", {
			signal: AbortSignal.timeout(1500),
			redirect: "error",
		});
		if (response.ok) {
			const body = await response.json();
			if (body.api === "ok" && body.database === "ok") {
				ready = true;
				break;
			}
		}
	} catch {
		/* The companion debug session may still be starting. */
	}
	await sleep(500);
}
if (!ready) {
	console.error(
		"研读服务未就绪。首次使用请在宿主机运行 node scripts/dev/setup-research.mjs，再选择完整的“AutoRAG：调试 TUI”启动项；同时查看研读服务终端的原始错误。",
	);
	process.exitCode = 1;
} else console.log("研读服务已就绪，即将启动 TUI。输入 /research 打开论文收件箱。");
