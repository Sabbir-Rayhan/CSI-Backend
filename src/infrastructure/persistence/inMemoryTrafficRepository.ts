import type { JunctionConfig } from "../../domain/traffic/junctionConfig";
import type { AuditEntry, JunctionState } from "../../domain/traffic/engineTypes";
import { ConcurrencyError } from "../../application/traffic/errors";
import type {
    CommitInput,
    HistoryQuery,
    JunctionRecord,
    ProcessedEventRecord,
    StoredAuditEntry,
    TrafficRepository,
} from "../../application/traffic/ports";

/** Same contract as the Postgres repository. Used by tests and for running without a database. */
export class InMemoryTrafficRepository implements TrafficRepository {
    private readonly junctions = new Map<string, JunctionRecord>();
    private readonly processed = new Map<string, ProcessedEventRecord>();
    private readonly audit: StoredAuditEntry[] = [];
    private nextAuditId = 1;

    async listJunctionIds(): Promise<string[]> {
        return [...this.junctions.keys()].sort();
    }

    async listJunctions(): Promise<JunctionRecord[]> {
        return [...this.junctions.values()].map(clone).sort((a, b) => a.config.id.localeCompare(b.config.id));
    }

    async getJunction(id: string): Promise<JunctionRecord | null> {
        const record = this.junctions.get(id);
        return record ? clone(record) : null;
    }

    async createJunction(config: JunctionConfig, state: JunctionState, audit: AuditEntry[]): Promise<boolean> {
        if (this.junctions.has(config.id)) return false;
        this.junctions.set(config.id, clone({ config, state, version: 0 }));
        this.appendAudit(config.id, audit);
        return true;
    }

    async findProcessedEvent(junctionId: string, eventId: string): Promise<ProcessedEventRecord | null> {
        const found = this.processed.get(`${junctionId}|${eventId}`);
        return found ? { ...found } : null;
    }

    async latestClearedSequence(junctionId: string, vehicleId: string): Promise<number | null> {
        let best: number | null = null;
        for (const event of this.processed.values()) {
            if (event.junctionId !== junctionId || event.vehicleId !== vehicleId) continue;
            if (event.kind !== "VEHICLE_CLEARED" || event.sequenceNo === null) continue;
            if (best === null || event.sequenceNo > best) best = event.sequenceNo;
        }
        return best;
    }

    async commit(input: CommitInput): Promise<void> {
        const record = this.junctions.get(input.junctionId);
        if (!record) throw new Error(`junction ${input.junctionId} not found`);

        // validate everything first so the commit is all-or-nothing
        if (input.state && record.version !== input.expectedVersion) {
            throw new ConcurrencyError(input.junctionId);
        }
        const key = input.processedEvent ? `${input.junctionId}|${input.processedEvent.eventId}` : null;
        if (key && this.processed.has(key)) throw new ConcurrencyError(input.junctionId);

        if (input.state) {
            this.junctions.set(input.junctionId, clone({ config: record.config, state: input.state, version: record.version + 1 }));
        }
        this.appendAudit(input.junctionId, input.audit);
        if (key && input.processedEvent) this.processed.set(key, { ...input.processedEvent });
    }

    async listHistory(junctionId: string, query: HistoryQuery): Promise<StoredAuditEntry[]> {
        return this.audit
            .filter((e) => e.junctionId === junctionId)
            .filter((e) => query.beforeId === undefined || e.id < query.beforeId)
            .filter((e) => query.type === undefined || e.type === query.type)
            .sort((a, b) => b.id - a.id)
            .slice(0, query.limit)
            .map((e) => structuredClone(e));
    }

    private appendAudit(junctionId: string, entries: AuditEntry[]): void {
        for (const entry of entries) {
            this.audit.push({ ...structuredClone(entry), id: this.nextAuditId++, junctionId });
        }
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}