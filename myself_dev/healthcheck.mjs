import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.env.HOME, ".cache/minsync/serve");
try {
  for (const instance of await readdir(root)) {
    const port = Number((await readFile(join(root, instance, "port"), "utf8")).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = await response.json();
    if (response.ok && health.status === "ok" &&
        health.model_id === "Qwen/Qwen3-Embedding-0.6B" && health.dimension === 1024) {
      console.log(JSON.stringify(health));
      process.exit(0);
    }
  }
} catch (error) {
  console.error(error.message);
}
process.exit(1);
