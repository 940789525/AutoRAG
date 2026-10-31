import { readFileSync } from "node:fs";

/** Linux start tick distinguishes a stale PID from a later process using the same number. */
export function processBirth(pid = process.pid): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
	} catch {
		return undefined;
	}
}
export function ownerAlive(pid: number, birth?: string): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	const current = processBirth(pid);
	return !birth || !current || birth === current;
}
