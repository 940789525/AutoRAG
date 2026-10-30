#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run on the Docker host once. The attached development container has no Docker socket.
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");
function docker(args, options = {}) {
	return execFileSync("docker", args, { cwd: root, encoding: "utf8", ...options });
}
try {
	const id = docker(["compose", "-f", join(root, "myself_dev/compose.yaml"), "ps", "-q", "dev"]).trim();
	if (!id) throw new Error("Start the development container first: bash myself_dev/dev.sh up -d");
	const inspected = JSON.parse(docker(["inspect", id]))[0];
	if (inspected.Mounts.find((mount) => mount.Destination === "/workspace")?.Source !== root)
		throw new Error("The running development container belongs to another checkout; refusing to configure it");
	const network = Object.keys(inspected.NetworkSettings.Networks)[0];
	const state = resolve(
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
		"autorag-research-dev",
		createHash("sha256").update(root).digest("hex").slice(0, 12),
	);
	mkdirSync(state, { recursive: true, mode: 0o700 });
	const secret = join(state, "postgres-password");
	try {
		writeFileSync(secret, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	chmodSync(secret, 0o600);
	docker(["compose", "-f", join(root, "myself_dev/1027/compose.research.yaml"), "up", "-d", "--wait", "research-db"], {
		env: { ...process.env, AUTORAG_RESEARCH_DB_PASSWORD_FILE: secret, AUTORAG_RESEARCH_DEV_NETWORK: network },
		stdio: ["ignore", "inherit", "inherit"],
	});
	const prepare = `import fs from "node:fs";import path from "node:path";
const home="/dev-home/.autorag-research-dev";fs.mkdirSync(home,{recursive:true,mode:0o700});fs.writeFileSync(home+"/postgres-password",fs.readFileSync(0),{mode:0o600});fs.chmodSync(home+"/postgres-password",0o600);
const source="/data/workspace/index-debug/.autorag/models/tokenizers";const destination="/data/workspace/research-inbox/.autorag/models/tokenizers";
if(fs.existsSync(source))for(const name of fs.readdirSync(source)){if(!/^[a-f0-9]{64}$/.test(name))continue;const files=["tokenizer.json","tokenizer_config.json"];if(!files.every(file=>fs.existsSync(path.join(source,name,file))))continue;fs.mkdirSync(path.join(destination,name),{recursive:true});for(const file of files){const target=path.join(destination,name,file);if(!fs.existsSync(target))fs.copyFileSync(path.join(source,name,file),target);}}
console.log("Research secret reference and public tokenizer cache prepared.");`;
	process.stdout.write(
		docker(["exec", "-i", "--workdir", "/workspace", id, "node", "--input-type=module", "-e", prepare], {
			input: readFileSync(secret),
		}),
	);
	const check = `import fs from "node:fs";import pg from "pg";const url=new URL("postgresql://research@research-db:5432/autorag_research");url.password=fs.readFileSync("/dev-home/.autorag-research-dev/postgres-password","utf8").trim();const pool=new pg.Pool({connectionString:url.href,connectionTimeoutMillis:5000});try{await pool.query("SELECT 1");console.log("Research PostgreSQL is ready. In the container VS Code window, select AutoRAG：调试 TUI and press F5.");}finally{await pool.end();}`;
	process.stdout.write(docker(["exec", "--workdir", "/workspace", id, "node", "--input-type=module", "-e", check]));
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
