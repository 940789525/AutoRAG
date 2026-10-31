import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: [
			"test/setup/kiwi-available.ts",
			"test/setup/isolated-pi-agent-dir.ts",
		],
		// Child-process and Pi-session tests exceed the 5s default on slow CI runners.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Bun's Windows fs-event implementation can abort parallel Vitest forks.
		fileParallelism: process.platform !== "win32",
	},
});
