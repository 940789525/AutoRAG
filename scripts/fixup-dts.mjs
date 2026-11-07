// Rewrite relative `.ts` specifiers in emitted declaration files to `.js`.
// tsc emits d.ts with the original `.ts` extensions (allowImportingTsExtensions);
// shipped packages only contain .js/.d.ts, so the specifiers must point at .js.
import { copyFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "dist";
const specifier = /(["'])(\.{1,2}\/[^"']+)\.ts\1/g;

function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			walk(path);
		} else if (path.endsWith(".d.ts")) {
			const source = readFileSync(path, "utf8");
			const fixed = source.replace(specifier, "$1$2.js$1");
			if (fixed !== source) writeFileSync(path, fixed);
		}
	}
}

// Removed runtime modules must not survive as stale declarations from a prior build.
for (const name of ["embedding/daemon", "embedding/in-process", "minsync/binary", "minsync/client", "minsync/installer", "minsync/local-embedder"]) rmSync(join(root, `${name}.d.ts`), {force:true});
walk(root);

for (const name of ["service.py", "qwen-model.json", "embedding-requirements.lock"]) {
	copyFileSync(join("src", "embedding", name), join(root, name === "service.py" ? "embedding-service.py" : name));
}

for (const name of ["docling-worker.py", "docling-models.json"]) {
	copyFileSync(join("src", "parser", name), join(root, "parser", name));
}
