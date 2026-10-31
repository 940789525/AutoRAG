import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingConfig, EmbeddingConsumer } from "./config.ts";
import { embeddingFingerprint } from "./config.ts";
import type { ManagedEmbedder } from "./embedder.ts";
import { createManagedEmbedder } from "./managed.ts";

/** Profile selection changes only after a successful candidate index activation. */
export class ProfileEmbedder implements ManagedEmbedder {
	readonly config: EmbeddingConfig;
	private selected: string;
	private readonly instances = new Map<string, ManagedEmbedder>();
	private readonly env?: NodeJS.ProcessEnv;
	constructor(config: EmbeddingConfig, options: { workspaceRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
		this.config = structuredClone(config);
		for (const profile of Object.values(this.config.profiles)) {
			if (profile.manifest) Object.freeze(profile.manifest);
			if (profile.allowedConsumers) Object.freeze(profile.allowedConsumers);
			Object.freeze(profile);
		}
		Object.freeze(this.config.profiles);
		Object.freeze(this.config);
		this.selected = config.defaultProfile;
		this.env = options.env;
		const readyPath = options.workspaceRoot && join(options.workspaceRoot, ".autorag", "local-index", "ready.json");
		if (readyPath && existsSync(readyPath)) {
			const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
				embeddingProfile?: string;
				semanticFingerprint?: string;
			};
			if (ready.embeddingProfile) {
				const profile = config.profiles[ready.embeddingProfile];
				if (profile && embeddingFingerprint(profile) === ready.semanticFingerprint)
					this.selected = ready.embeddingProfile;
			}
		}
	}
	get profileId(): string {
		return this.selected;
	}
	profile(id = this.selected) {
		const profile = this.config.profiles[id];
		if (!profile) throw new Error(`Embedding profile is not configured: ${id}`);
		return profile;
	}
	forProfile(id: string): ManagedEmbedder {
		let instance = this.instances.get(id);
		if (!instance) {
			instance = createManagedEmbedder({ profile: this.profile(id), env: this.env });
			this.instances.set(id, instance);
		}
		return instance;
	}
	activate(id: string): void {
		this.profile(id);
		this.selected = id;
	}
	snapshot(): ManagedEmbedder {
		return this.forProfile(this.selected);
	}
	identity: ManagedEmbedder["identity"] = () => this.forProfile(this.selected).identity();
	capabilities: NonNullable<ManagedEmbedder["capabilities"]> = () => this.forProfile(this.selected).capabilities!();
	embed: ManagedEmbedder["embed"] = (texts, options) => this.forProfile(this.selected).embed(texts, options);
	health: ManagedEmbedder["health"] = () => this.forProfile(this.selected).health();
	describeEndpoint: ManagedEmbedder["describeEndpoint"] = () => this.forProfile(this.selected).describeEndpoint();
	start: NonNullable<ManagedEmbedder["start"]> = (signal, onProgress) =>
		this.forProfile(this.selected).start!(signal, onProgress);
	stop: NonNullable<ManagedEmbedder["stop"]> = () => this.forProfile(this.selected).stop!();
	async close(): Promise<void> {
		await Promise.all([...this.instances.values()].map((e) => e.close()));
	}
	forConsumer(consumer: EmbeddingConsumer): ManagedEmbedder {
		const current = () => this.forProfile(this.selected).forConsumer!(consumer);
		return {
			snapshot: current,
			identity: () => current().identity(),
			capabilities: () => current().capabilities!(),
			embed: (texts, opts) => current().embed(texts, opts),
			health: () => current().health(),
			describeEndpoint: () => current().describeEndpoint(),
			close: async () => {},
		};
	}
}
