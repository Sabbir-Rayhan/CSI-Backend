import {
    createFourWayJunctionConfig,
    validateJunctionConfig,
    type JunctionConfig,
    type PhaseConfig,
    type TimingConfig,
} from "../../domain/traffic/junctionConfig";
import { createInitialState, processEvent } from "../../domain/traffic/junctionEngine";
import type {
    AuditEntry,
    ControllerCommand,
    DeviceType,
    EngineEffect,
    EngineEvent,
    EngineResult,
    JunctionState,
} from "../../domain/traffic/engineTypes";
import {
    DIRECTIONS,
    type DeviceStatus,
    type Direction,
    type SignalMap,
    type SignalState,
    type VehicleType,
} from "../../domain/traffic/types";
import {
    ConcurrencyError,
    InvalidJunctionConfigError,
    JunctionAlreadyExistsError,
    JunctionNotFoundError,
} from "./errors";
import {
    consoleLogger,
    type Clock,
    type ControllerPort,
    type HistoryQuery,
    type JunctionRecord,
    type Logger,
    type ProcessedEventKind,
    type ProcessedEventRecord,
    type StoredAuditEntry,
    type TrafficRepository,
} from "./ports";
import { toStatusDto, type JunctionStatusDto } from "./statusPresenter";

const MAX_CONCURRENCY_RETRIES = 3;

export interface TrafficServiceOptions {
    /** VEHICLE_ARRIVED events older than this (sensor clock vs server clock) are ignored. 0 = off. */
    staleEventMaxAgeMs: number;
}

export interface SensorEventInput {
    eventId: string;
    junctionId: string;
    direction: Direction;
    eventType: "VEHICLE_ARRIVED" | "VEHICLE_CLEARED";
    vehicleId: string;
    vehicleType?: VehicleType;
    sequenceNo: number;
    /** Sensor clock, epoch ms. Used for audit/staleness only, never for scheduling. */
    timestamp: number;
}

export interface DeviceStatusInput {
    eventId: string;
    junctionId: string;
    deviceType: DeviceType;
    direction?: Direction;
    status: DeviceStatus;
    timestamp: number;
}

export interface ControllerAckInput {
    junctionId: string;
    commandId: string;
    status: "ACK" | "NACK" | "FAILED";
    actualSignals?: SignalMap;
    /** Single-value form used in the spec example. Cross-checked against the pending command. */
    actualState?: SignalState;
}

export type JunctionCommandInput =
    | { command: "MANUAL_GREEN_REQUEST"; direction: Direction }
    | { command: "RETURN_TO_AUTOMATIC" };

export interface CreateJunctionInput {
    id: string;
    name?: string;
    timing?: Partial<TimingConfig>;
    phases?: PhaseConfig[];
}

export interface ServiceResult {
    accepted: boolean;
    code: string;
    message?: string;
    duplicate?: boolean;
    junctionId: string;
    eventId?: string;
    mode: string;
    queues: Record<Direction, number>;
}

interface Done<T> {
    value: T;
    commands: ControllerCommand[];
}

/**
 * Application layer. It is the ONLY place that touches both the pure engine and the outside world.
 *
 * Consistency strategy:
 *  1. Serialized per-junction processing: every operation for a junction runs through one
 *     promise chain, so two requests can never interleave on the same junction.
 *  2. Optimistic concurrency in the database (version column) as a second line of defence,
 *     e.g. if a second backend instance ever writes the same junction.
 *  3. State + audit + processed-event are committed in ONE transaction, then commands are sent.
 *     A crash between commit and send is safe: on restart the pending command is abandoned
 *     and the junction is re-synchronised to ALL RED before anything else happens.
 */
export class TrafficService {
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(
        private readonly repo: TrafficRepository,
        private readonly controller: ControllerPort,
        private readonly clock: Clock,
        private readonly options: TrafficServiceOptions = { staleEventMaxAgeMs: 0 },
        private readonly log: Logger = consoleLogger
    ) {}

    // ------------------------------------------------------------------ junctions

    async createJunction(input: CreateJunctionInput): Promise<JunctionStatusDto> {
        const base = createFourWayJunctionConfig(input.id.trim(), input.name, input.timing);
        const config: JunctionConfig = input.phases ? { ...base, phases: input.phases } : base;

        const problems = validateJunctionConfig(config);
        if (problems.length > 0) throw new InvalidJunctionConfigError(problems);

        const done = await this.runExclusive(config.id, async (): Promise<Done<JunctionStatusDto>> => {
            if (await this.repo.getJunction(config.id)) throw new JunctionAlreadyExistsError(config.id);

            const now = this.clock.now();
            // A new junction starts DEGRADED / physical state unknown. The first tick issues
            // the all-red resync command; only after it is confirmed does normal control begin.
            const result = processEvent(config, createInitialState(config, now), { type: "TICK" }, now);
            const { audit, commands } = splitEffects(result.effects);

            const created = await this.repo.createJunction(config, result.state, audit);
            if (!created) throw new JunctionAlreadyExistsError(config.id);

            this.log.info(`junction ${config.id} created`);
            return { value: toStatusDto(config, result.state, now), commands };
        });

        this.dispatch(done.commands);
        return done.value;
    }

    async listStatuses(): Promise<JunctionStatusDto[]> {
        const now = this.clock.now();
        const records = await this.repo.listJunctions();
        return records.map((r) => toStatusDto(r.config, r.state, now));
    }

    async getStatus(junctionId: string): Promise<JunctionStatusDto> {
        const record = await this.repo.getJunction(junctionId);
        if (!record) throw new JunctionNotFoundError(junctionId);
        return toStatusDto(record.config, record.state, this.clock.now());
    }

    async getHistory(junctionId: string, query: HistoryQuery): Promise<StoredAuditEntry[]> {
        if (!(await this.repo.getJunction(junctionId))) throw new JunctionNotFoundError(junctionId);
        return this.repo.listHistory(junctionId, query);
    }

    // ------------------------------------------------------------------ sensor events

    async ingestSensorEvent(input: SensorEventInput): Promise<ServiceResult> {
        const kind: ProcessedEventKind = input.eventType;
        const engineEvent: EngineEvent =
            input.eventType === "VEHICLE_ARRIVED"
                ? {
                      type: "VEHICLE_ARRIVED",
                      vehicleId: input.vehicleId,
                      // validated at the API boundary; EMPLOYEE_VEHICLE is the lowest-priority safe default
                      vehicleType: input.vehicleType ?? "EMPLOYEE_VEHICLE",
                      direction: input.direction,
                  }
                : { type: "VEHICLE_CLEARED", vehicleId: input.vehicleId, direction: input.direction };

        return this.ingest(input.junctionId, input.eventId, kind, engineEvent, {
            vehicleId: input.vehicleId,
            direction: input.direction,
            sequenceNo: input.sequenceNo,
            sensorTimestamp: input.timestamp,
        });
    }

    async ingestDeviceStatus(input: DeviceStatusInput): Promise<ServiceResult> {
        return this.ingest(
            input.junctionId,
            input.eventId,
            "DEVICE_STATUS",
            { type: "DEVICE_STATUS", deviceType: input.deviceType, direction: input.direction, status: input.status },
            { vehicleId: null, direction: input.direction ?? null, sequenceNo: null, sensorTimestamp: input.timestamp }
        );
    }

    private async ingest(
        junctionId: string,
        eventId: string,
        kind: ProcessedEventKind,
        engineEvent: EngineEvent,
        meta: {
            vehicleId: string | null;
            direction: string | null;
            sequenceNo: number | null;
            sensorTimestamp: number | null;
        }
    ): Promise<ServiceResult> {
        return this.locked(junctionId, async (record): Promise<Done<ServiceResult>> => {
            const now = this.clock.now();
            const ledger = (outcome: string): ProcessedEventRecord => ({
                junctionId,
                eventId,
                kind,
                vehicleId: meta.vehicleId,
                direction: meta.direction,
                sequenceNo: meta.sequenceNo,
                sensorTimestamp: meta.sensorTimestamp,
                receivedAt: now,
                outcome,
            });
            const rejectedAudit = (reason: string, extra: Record<string, unknown> = {}): AuditEntry => ({
                type: "EVENT_REJECTED",
                at: now,
                direction: (meta.direction ?? undefined) as Direction | undefined,
                details: { reason, eventId, vehicleId: meta.vehicleId, sequenceNo: meta.sequenceNo, ...extra },
            });

            // 1. Idempotency: the same event_id never changes state twice.
            const existing = await this.repo.findProcessedEvent(junctionId, eventId);
            if (existing) {
                await this.repo.commit({
                    junctionId,
                    state: null,
                    expectedVersion: record.version,
                    audit: [rejectedAudit("DUPLICATE_EVENT", { originalOutcome: existing.outcome })],
                    processedEvent: null,
                });
                return {
                    value: resultFrom(record.state, { accepted: true, code: "DUPLICATE_EVENT", duplicate: true }, eventId),
                    commands: [],
                };
            }

            // 2. Ordering / staleness guards for arrivals.
            if (kind === "VEHICLE_ARRIVED" && meta.vehicleId !== null && meta.sequenceNo !== null) {
                const clearedAt = await this.repo.latestClearedSequence(junctionId, meta.vehicleId);
                if (clearedAt !== null && clearedAt > meta.sequenceNo) {
                    // The vehicle already left (higher sequence); this arrival is a late, reordered message.
                    await this.repo.commit({
                        junctionId,
                        state: null,
                        expectedVersion: record.version,
                        audit: [rejectedAudit("STALE_OUT_OF_ORDER", { clearedAtSequence: clearedAt })],
                        processedEvent: ledger("STALE_OUT_OF_ORDER"),
                    });
                    return {
                        value: resultFrom(record.state, { accepted: false, code: "STALE_OUT_OF_ORDER" }, eventId),
                        commands: [],
                    };
                }
                const max = this.options.staleEventMaxAgeMs;
                if (max > 0 && meta.sensorTimestamp !== null && now - meta.sensorTimestamp > max) {
                    await this.repo.commit({
                        junctionId,
                        state: null,
                        expectedVersion: record.version,
                        audit: [rejectedAudit("STALE_EVENT", { ageMs: now - meta.sensorTimestamp, maxAgeMs: max })],
                        processedEvent: ledger("STALE_EVENT"),
                    });
                    return {
                        value: resultFrom(record.state, { accepted: false, code: "STALE_EVENT" }, eventId),
                        commands: [],
                    };
                }
            }

            // 3. Hand to the pure engine, persist atomically (state + audit + ledger).
            const result = processEvent(record.config, record.state, engineEvent, now);
            const commands = await this.persist(record, result, now, ledger(result.outcome.code));
            return {
                value: resultFrom(result.state, result.outcome, eventId),
                commands,
            };
        });
    }

    /** Best-effort audit row for a payload that failed validation (only if the junction is known). */
    async recordInvalidPayload(junctionId: unknown, issues: unknown, eventId?: unknown): Promise<void> {
        if (typeof junctionId !== "string" || junctionId.trim() === "") return;
        try {
            if (!(await this.repo.getJunction(junctionId))) return;
            await this.repo.commit({
                junctionId,
                state: null,
                expectedVersion: 0,
                audit: [
                    {
                        type: "EVENT_REJECTED",
                        at: this.clock.now(),
                        details: { reason: "INVALID_PAYLOAD", eventId: typeof eventId === "string" ? eventId : null, issues },
                    },
                ],
                processedEvent: null,
            });
        } catch (error) {
            this.log.warn("could not record invalid payload", error);
        }
    }

    // ------------------------------------------------------------------ operator commands

    async submitCommand(junctionId: string, input: JunctionCommandInput): Promise<ServiceResult> {
        const engineEvent: EngineEvent =
            input.command === "MANUAL_GREEN_REQUEST"
                ? { type: "MANUAL_GREEN_REQUEST", direction: input.direction }
                : { type: "RETURN_TO_AUTOMATIC" };
        return this.runEngineEvent(junctionId, engineEvent);
    }

    // ------------------------------------------------------------------ controller events

    async handleControllerAck(input: ControllerAckInput): Promise<ServiceResult> {
        return this.locked(input.junctionId, async (record): Promise<Done<ServiceResult>> => {
            const now = this.clock.now();
            let actualSignals = input.actualSignals;

            // Spec-style single "actual_state": only believable if the pending command could produce it.
            if (!actualSignals && input.actualState && record.state.pendingCommand?.commandId === input.commandId) {
                const requested = Object.values(record.state.pendingCommand.signals);
                if (!requested.includes(input.actualState)) {
                    actualSignals = { NORTH: input.actualState, SOUTH: input.actualState, EAST: input.actualState, WEST: input.actualState };
                }
            }

            const result = processEvent(
                record.config,
                record.state,
                { type: "COMMAND_RESULT", commandId: input.commandId, status: input.status, actualSignals },
                now
            );
            const commands = await this.persist(record, result, now, null);
            return { value: resultFrom(result.state, result.outcome), commands };
        });
    }

    // ------------------------------------------------------------------ time & recovery

    async tick(junctionId: string): Promise<void> {
        await this.runEngineEvent(junctionId, { type: "TICK" });
    }

    async tickAll(): Promise<void> {
        const ids = await this.repo.listJunctionIds();
        await Promise.all(
            ids.map((id) =>
                this.tick(id).catch((error) => this.log.error(`tick failed for junction ${id}`, error))
            )
        );
    }

    /**
     * Call once at start-up. For every junction: keep queue / emergencies / manual override,
     * but throw away every assumption about the physical signals and force an all-red resync.
     */
    async recoverAll(): Promise<void> {
        const ids = await this.repo.listJunctionIds();
        for (const id of ids) {
            await this.runEngineEvent(id, { type: "RESTARTED" });
            this.log.info(`junction ${id} recovered: signal state reset, resync requested`);
        }
    }

    // ------------------------------------------------------------------ internals

    private async runEngineEvent(junctionId: string, event: EngineEvent): Promise<ServiceResult> {
        return this.locked(junctionId, async (record): Promise<Done<ServiceResult>> => {
            const now = this.clock.now();
            const result = processEvent(record.config, record.state, event, now);
            const commands = await this.persist(record, result, now, null);
            return { value: resultFrom(result.state, result.outcome), commands };
        });
    }

    private async persist(
        record: JunctionRecord,
        result: EngineResult,
        _now: number,
        processedEvent: ProcessedEventRecord | null
    ): Promise<ControllerCommand[]> {
        const { audit, commands } = splitEffects(result.effects);
        const changed = stateChanged(record.state, result.state);

        if (!changed && audit.length === 0 && processedEvent === null) return commands;

        await this.repo.commit({
            junctionId: record.state.junctionId,
            state: changed ? result.state : null,
            expectedVersion: record.version,
            audit,
            processedEvent,
        });
        return commands;
    }

    /** Runs `fn` exclusively for the junction, with reload-and-retry on optimistic-lock conflicts. */
    private async locked<T>(junctionId: string, fn: (record: JunctionRecord) => Promise<Done<T>>): Promise<T> {
        const done = await this.runExclusive(junctionId, async () => {
            for (let attempt = 1; ; attempt++) {
                const record = await this.repo.getJunction(junctionId);
                if (!record) throw new JunctionNotFoundError(junctionId);
                try {
                    return await fn(record);
                } catch (error) {
                    if (error instanceof ConcurrencyError && attempt < MAX_CONCURRENCY_RETRIES) {
                        this.log.warn(`concurrency conflict on ${junctionId}, retry ${attempt}`);
                        continue;
                    }
                    throw error;
                }
            }
        });
        this.dispatch(done.commands);
        return done.value;
    }

    private runExclusive<T>(junctionId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.chains.get(junctionId) ?? Promise.resolve();
        const run = previous.then(fn, fn);
        const tail = run.then(
            () => undefined,
            () => undefined
        );
        this.chains.set(junctionId, tail);
        void tail.then(() => {
            if (this.chains.get(junctionId) === tail) this.chains.delete(junctionId);
        });
        return run;
    }

    /** Sent AFTER commit and AFTER the junction lock is released. A failed send is not fatal: the ACK timeout handles it. */
    private dispatch(commands: ControllerCommand[]): void {
        for (const command of commands) {
            void this.controller.send(command).catch((error) => {
                this.log.error(`failed to send ${command.commandId} to controller`, error);
            });
        }
    }
}

// ---------------------------------------------------------------------- helpers

function splitEffects(effects: EngineEffect[]): { audit: AuditEntry[]; commands: ControllerCommand[] } {
    const audit: AuditEntry[] = [];
    const commands: ControllerCommand[] = [];
    for (const effect of effects) {
        if (effect.type === "AUDIT") audit.push(effect.entry);
        else commands.push(effect.command);
    }
    return { audit, commands };
}

function stateChanged(before: JunctionState, after: JunctionState): boolean {
    return JSON.stringify({ ...before, updatedAt: 0 }) !== JSON.stringify({ ...after, updatedAt: 0 });
}

function resultFrom(
    state: JunctionState,
    outcome: { accepted: boolean; code: string; message?: string; duplicate?: boolean },
    eventId?: string
): ServiceResult {
    const queues = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 } as Record<Direction, number>;
    for (const vehicle of state.queue) queues[vehicle.direction] += 1;
    for (const direction of DIRECTIONS) queues[direction] ??= 0;
    return {
        accepted: outcome.accepted,
        code: outcome.code,
        message: outcome.message,
        duplicate: outcome.duplicate,
        junctionId: state.junctionId,
        eventId,
        mode: state.mode,
        queues,
    };
}