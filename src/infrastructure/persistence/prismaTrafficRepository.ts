import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { JunctionConfig } from "../../domain/traffic/junctionConfig";
import type { AuditEntry, JunctionState } from "../../domain/traffic/engineTypes";
import { ConcurrencyError } from "../../application/traffic/errors";
import type {
    CommitInput,
    HistoryQuery,
    JunctionRecord,
    ProcessedEventKind,
    ProcessedEventRecord,
    StoredAuditEntry,
    TrafficRepository,
} from "../../application/traffic/ports";
import type { Direction } from "../../domain/traffic/types";

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class PrismaTrafficRepository implements TrafficRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async listJunctionIds(): Promise<string[]> {
        const rows = await this.prisma.junction.findMany({ select: { id: true }, orderBy: { id: "asc" } });
        return rows.map((r) => r.id);
    }

    async listJunctions(): Promise<JunctionRecord[]> {
        const rows = await this.prisma.junction.findMany({ orderBy: { id: "asc" } });
        return rows.map(toRecord);
    }

    async getJunction(id: string): Promise<JunctionRecord | null> {
        const row = await this.prisma.junction.findUnique({ where: { id } });
        return row ? toRecord(row) : null;
    }

    async createJunction(config: JunctionConfig, state: JunctionState, audit: AuditEntry[]): Promise<boolean> {
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.junction.create({
                    data: { id: config.id, name: config.name, config: asJson(config), state: asJson(state), version: 0 },
                });
                if (audit.length > 0) {
                    await tx.auditLog.createMany({ data: audit.map((entry) => toAuditRow(config.id, entry)) });
                }
            });
            return true;
        } catch (error) {
            if (isUniqueViolation(error)) return false;
            throw error;
        }
    }

    async findProcessedEvent(junctionId: string, eventId: string): Promise<ProcessedEventRecord | null> {
        const row = await this.prisma.processedEvent.findUnique({
            where: { junctionId_eventId: { junctionId, eventId } },
        });
        if (!row) return null;
        return {
            junctionId: row.junctionId,
            eventId: row.eventId,
            kind: row.kind as ProcessedEventKind,
            vehicleId: row.vehicleId,
            direction: row.direction,
            sequenceNo: row.sequenceNo,
            sensorTimestamp: row.sensorTimestamp ? row.sensorTimestamp.getTime() : null,
            receivedAt: row.receivedAt.getTime(),
            outcome: row.outcome,
        };
    }

    async latestClearedSequence(junctionId: string, vehicleId: string): Promise<number | null> {
        const row = await this.prisma.processedEvent.findFirst({
            where: { junctionId, vehicleId, kind: "VEHICLE_CLEARED", sequenceNo: { not: null } },
            orderBy: { sequenceNo: "desc" },
            select: { sequenceNo: true },
        });
        return row?.sequenceNo ?? null;
    }

    async commit(input: CommitInput): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                if (input.state) {
                    const updated = await tx.junction.updateMany({
                        where: { id: input.junctionId, version: input.expectedVersion },
                        data: { state: asJson(input.state), version: { increment: 1 } },
                    });
                    if (updated.count !== 1) throw new ConcurrencyError(input.junctionId);
                }
                if (input.audit.length > 0) {
                    await tx.auditLog.createMany({ data: input.audit.map((e) => toAuditRow(input.junctionId, e)) });
                }
                if (input.processedEvent) {
                    const p = input.processedEvent;
                    await tx.processedEvent.create({
                        data: {
                            junctionId: p.junctionId,
                            eventId: p.eventId,
                            kind: p.kind,
                            vehicleId: p.vehicleId,
                            direction: p.direction,
                            sequenceNo: p.sequenceNo,
                            sensorTimestamp: p.sensorTimestamp === null ? null : new Date(p.sensorTimestamp),
                            receivedAt: new Date(p.receivedAt),
                            outcome: p.outcome,
                        },
                    });
                }
            });
        } catch (error) {
            // Another writer got the same event_id in first: treat like an optimistic-lock conflict.
            if (isUniqueViolation(error)) throw new ConcurrencyError(input.junctionId);
            throw error;
        }
    }

    async listHistory(junctionId: string, query: HistoryQuery): Promise<StoredAuditEntry[]> {
        const rows = await this.prisma.auditLog.findMany({
            where: {
                junctionId,
                ...(query.beforeId !== undefined ? { id: { lt: query.beforeId } } : {}),
                ...(query.type !== undefined ? { type: query.type } : {}),
            },
            orderBy: { id: "desc" },
            take: query.limit,
        });
        return rows.map((row) => ({
            id: row.id,
            junctionId: row.junctionId,
            type: row.type as StoredAuditEntry["type"],
            at: row.at.getTime(),
            direction: (row.direction ?? undefined) as Direction | undefined,
            previousState: row.previousState ?? undefined,
            newState: row.newState ?? undefined,
            commandId: row.commandId ?? undefined,
            details: (row.details ?? undefined) as Record<string, unknown> | undefined,
        }));
    }
}

function toRecord(row: { config: unknown; state: unknown; version: number }): JunctionRecord {
    return {
        config: row.config as JunctionConfig,
        state: row.state as JunctionState,
        version: row.version,
    };
}

function toAuditRow(junctionId: string, entry: AuditEntry) {
    return {
        junctionId,
        type: entry.type,
        direction: entry.direction ?? null,
        previousState: entry.previousState ?? null,
        newState: entry.newState ?? null,
        commandId: entry.commandId ?? null,
        details: entry.details === undefined ? Prisma.JsonNull : asJson(entry.details),
        at: new Date(entry.at),
    };
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}