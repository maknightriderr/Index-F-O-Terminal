/** Bounded, deadline-aware work. Expired queued tasks never start; running work is not falsely cancelled. */
export class FreshWorkQueue {
    private running = 0;
    private jobs: Array<{
        deadline: number;
        run: () => Promise<unknown>;
        resolve: (x: unknown) => void;
        reject: (e: Error) => void;
    }> = [];
    constructor(private capacity: number, private concurrency: number, private now: () => number = Date.now) {
        if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1)
            throw new Error('INVALID_QUEUE_LIMITS');
    }
    get size() { return this.jobs.length; }
    get inFlight() { return this.running; }
    add<T>(deadline: number, run: () => Promise<T>): Promise<T> {
        if (!Number.isFinite(deadline) || deadline <= this.now())
            return Promise.reject(new Error('DEADLINE_EXPIRED'));
        if (this.jobs.length >= this.capacity)
            return Promise.reject(new Error('QUEUE_FULL'));
        return new Promise<T>((resolve, reject) => { this.jobs.push({ deadline, run, resolve: resolve as (x: unknown) => void, reject }); this.drain(); });
    }
    private drain() {
        while (this.running < this.concurrency && this.jobs.length) {
            const j = this.jobs.shift()!;
            if (j.deadline <= this.now()) {
                j.reject(new Error('DEADLINE_EXPIRED'));
                continue;
            }
            this.running++;
            void Promise.resolve().then(j.run).then(j.resolve, j.reject).finally(() => { this.running--; this.drain(); });
        }
    }
}
