/** Bounded, cancellable producer/consumer channel: parse failures never strand an index worker. */
export class DocumentChannel<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private changed: (() => void)[] = [];
	private finished = false;
	private failure: unknown;
	private failed = false;
	private readonly capacity: number;
	constructor(capacity = 8) {
		if (!Number.isInteger(capacity) || capacity < 1)
			throw new RangeError("index channel capacity must be a positive integer");
		this.capacity = capacity;
	}
	private wake(): void {
		for (const wake of this.changed.splice(0)) wake();
	}
	private wait(): Promise<void> {
		return new Promise((resolve) => this.changed.push(resolve));
	}
	async push(item: T): Promise<void> {
		while (!this.finished && this.items.length >= this.capacity) await this.wait();
		if (this.failed) throw this.failure;
		if (this.finished) throw new Error("index input is closed");
		this.items.push(item);
		this.wake();
	}
	close(): void {
		this.finished = true;
		this.wake();
	}
	fail(error: unknown): void {
		this.failure = error;
		this.failed = true;
		this.finished = true;
		this.wake();
	}
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.failed) throw this.failure;
			const item = this.items.shift();
			if (item !== undefined) {
				this.wake();
				yield item;
			} else if (this.finished) return;
			else await this.wait();
		}
	}
}
