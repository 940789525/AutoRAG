import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve from the installed package, including bundled dist/cli and source layouts. */
export function packagedSkillPath(name: string): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) {
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	const path = join(dir, "skills", name, "SKILL.md");
	return existsSync(path) ? path : undefined;
}
