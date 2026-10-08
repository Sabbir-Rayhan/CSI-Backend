import type { Logger } from "./ports";
import type { TrafficService } from "./trafficService";

/**
 * Drives time. No sleep() inside request handlers: signal timing is checked by this
 * ticker, which just asks every junction's state machine "has enough time passed?".
 * A tick that is still running when the next one is due is skipped, never stacked.
 */
export class TickScheduler {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        private readonly service: TrafficService,
        private readonly intervalMs: number,
        private readonly log: Logger
    ) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.running) return;
            this.running = true;
            this.service
                .tickAll()
                .catch((error) => this.log.error("tick loop failed", error))
                .finally(() => {
                    this.running = false;
                });
        }, this.intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}