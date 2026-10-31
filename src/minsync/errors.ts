/** Legacy fatal-error name retained for compatibility; no executable lookup or installation. */
export class MinSyncRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MinSyncRequiredError";
	}
}
