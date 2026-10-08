import type { JunctionConfig } from "../../domain/traffic/junctionConfig";
import type { AuditEntry, ControllerCommand, JunctionState } from "../../domain/traffic/engineTypes";

/** A junction as stored: config + engine state + optimistic-concurrency version. */
export interface JunctionRecord {
    config: JunctionConfig;
    state: JunctionState;
    version: number;
}

export type ProcessedEventKind = "VEHICLE_ARRIVED" | "VEHICLE_CLEARED" | "DEVICE_STATUS";

/** Idempotency / ordering ledger entry. (junctionId, eventId) is unique. */
export interface ProcessedEventRecord {
    junctionId: string;
    eventId: string;
    kind: ProcessedEventKind;
    vehicleId: string | null;
    direction: string | null;
    sequenceNo: number | null;
    sensorTimestamp: number | null;
    receivedAt: number;
    outcome: string;
}

export interface StoredAuditEntry extends AuditEntry {
    id: number;
    junctionId: string;
}

export interface CommitInput {
    junctionId: string;
    /** null = leave the junction row untouched (e.g. a duplicate event). */
    state: JunctionState | null;
    /** The version that was read. The write fails with ConcurrencyError if it moved. */
    expectedVersion: number;
    audit: AuditEntry[];
    processedEvent: ProcessedEventRecord | null;
}

export interface HistoryQuery {
    limit: number;
    beforeId?: number;
    type?: string;
}

/** Persistence port. The domain engine never sees this; only the application layer does. */
export interface TrafficRepository {
    listJunctionIds(): Promise<string[]>;
    listJunctions(): Promise<JunctionRecord[]>;
    getJunction(id: string): Promise<JunctionRecord | null>;
    /** Returns false when a junction with this id already exists. */
    createJunction(config: JunctionConfig, state: JunctionState, audit: AuditEntry[]): Promise<boolean>;
    findProcessedEvent(junctionId: string, eventId: string): Promise<ProcessedEventRecord | null>;
    /** Highest sequence_no of an already-processed VEHICLE_CLEARED for this vehicle, if any. */
    latestClearedSequence(junctionId: string, vehicleId: string): Promise<number | null>;
    /** Atomic: state update (version-guarded) + audit rows + processed-event row. */
    commit(input: CommitInput): Promise<void>;
    listHistory(junctionId: string, query: HistoryQuery): Promise<StoredAuditEntry[]>;
}

/** Physical-controller port. REST simulator today, MQTT adapter later. */
export interface ControllerPort {
    send(command: ControllerCommand): Promise<void>;
}

export interface Clock {
    now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
}

export const consoleLogger: Logger = {
    info: (m, meta) => console.log(`[traffic] ${m}`, meta ?? ""),
    warn: (m, meta) => console.warn(`[traffic] ${m}`, meta ?? ""),
    error: (m, meta) => console.error(`[traffic] ${m}`, meta ?? ""),
};