import { getPhaseForDirection, type JunctionConfig } from "./junctionConfig";
import { decideNextPhase } from "./scheduler";
import {
    allRedSignals,
    assertSafeSignalMap,
    assertSafeTransition,
    signalsFor,
} from "./safety";
import {
    DIRECTIONS,
    type ActualSignalMap,
    type DeviceStatus,
    type Direction,
    type JunctionMode,
    type SignalMap,
    type Stage,
} from "./types";
import type {
    Alert,
    AuditEntry,
    CommandKind,
    ControllerCommand,
    DeviceType,
    EngineEffect,
    EngineEvent,
    EngineOutcome,
    EngineResult,
    JunctionState,
} from "./engineTypes";

/** First send + one retry. After that the controller is treated as OFFLINE. */
export const MAX_COMMAND_ATTEMPTS = 2;

interface Ctx {
    config: JunctionConfig;
    state: JunctionState;
    now: number;
    effects: EngineEffect[];
}

const OK: EngineOutcome = { accepted: true, code: "OK" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInitialState(config: JunctionConfig, now: number): JunctionState {
    return {
        junctionId: config.id,
        mode: "DEGRADED",
        stage: "ALL_RED",
        activePhaseId: null,
        targetPhaseId: null,
        desired: allRedSignals(),
        actual: unknownSignals(),
        stageConfirmedAt: null,
        pendingCommand: null,
        commandSeq: 0,
        controllerStatus: "UNKNOWN",
        needsResync: true,
        deviceStatuses: {},
        queue: [],
        emergencies: [],
        manual: null,
        updatedAt: now,
    };
}

/**
 * The only way state changes. Pure and deterministic: same (config, state, event, now)
 * always gives the same result. No clock, no database, no I/O. Time is passed in.
 */
export function processEvent(
    config: JunctionConfig,
    previous: JunctionState,
    event: EngineEvent,
    now: number
): EngineResult {
    const ctx: Ctx = { config, state: structuredClone(previous), now, effects: [] };

    let outcome: EngineOutcome = OK;
    switch (event.type) {
        case "TICK":
            break;
        case "VEHICLE_ARRIVED":
            outcome = onVehicleArrived(ctx, event);
            break;
        case "VEHICLE_CLEARED":
            outcome = onVehicleCleared(ctx, event);
            break;
        case "MANUAL_GREEN_REQUEST":
            outcome = onManualGreenRequest(ctx, event.direction);
            break;
        case "RETURN_TO_AUTOMATIC":
            outcome = onReturnToAutomatic(ctx);
            break;
        case "COMMAND_RESULT":
            outcome = onCommandResult(ctx, event);
            break;
        case "DEVICE_STATUS":
            outcome = onDeviceStatus(ctx, event.deviceType, event.status, event.direction);
            break;
        case "RESTARTED":
            outcome = onRestarted(ctx);
            break;
    }

    // After every event, let the machine move: this is what makes emergency
    // preemption begin at the same instant the emergency is detected.
    advance(ctx);
    updateMode(ctx);
    ctx.state.updatedAt = now;

    return { state: ctx.state, effects: ctx.effects, outcome };
}

/** Degraded = we cannot trust the physical state, so automatic switching is frozen. */
export function isDegraded(state: JunctionState): boolean {
    return (
        state.needsResync ||
        state.controllerStatus === "OFFLINE" ||
        state.controllerStatus === "UNKNOWN"
    );
}

export function deriveMode(state: JunctionState): JunctionMode {
    if (isDegraded(state)) return "DEGRADED";
    if (state.emergencies.length > 0) return "EMERGENCY";
    if (state.manual) return "MANUAL";
    return "AUTOMATIC";
}

/** Alerts are derived from state, never stored, so they can never go stale. */
export function deriveAlerts(state: JunctionState): Alert[] {
    const alerts: Alert[] = [];

    if (state.controllerStatus === "OFFLINE") {
        alerts.push({ code: "CONTROLLER_OFFLINE", severity: "CRITICAL", message: "Controller is offline. Signal state cannot be confirmed." });
    } else if (state.controllerStatus === "UNKNOWN") {
        alerts.push({ code: "CONTROLLER_UNKNOWN", severity: "WARNING", message: "Controller status is unknown." });
    } else if (state.controllerStatus !== "ONLINE") {
        alerts.push({ code: "CONTROLLER_DEGRADED", severity: "WARNING", message: `Controller status is ${state.controllerStatus}.` });
    }

    if (state.needsResync && state.controllerStatus !== "OFFLINE") {
        alerts.push({ code: "RESYNC_REQUIRED", severity: "WARNING", message: "Physical state unknown. Waiting for an all-red resync to be confirmed." });
    }

    if (state.pendingCommand) {
        alerts.push({ code: "COMMAND_PENDING", severity: "INFO", message: `Waiting for controller to confirm ${state.pendingCommand.commandId} (attempt ${state.pendingCommand.attempt}).` });
    } else if (!state.needsResync) {
        for (const direction of DIRECTIONS) {
            const actual = state.actual[direction];
            if (actual !== "UNKNOWN" && actual !== state.desired[direction]) {
                alerts.push({ code: "STATE_MISMATCH", severity: "CRITICAL", message: `${direction}: desired ${state.desired[direction]} but controller reports ${actual}.`, direction });
            }
        }
    }

    if (DIRECTIONS.some((d) => state.actual[d] === "UNKNOWN")) {
        alerts.push({ code: "UNKNOWN_DEVICE_STATE", severity: "WARNING", message: "At least one signal has no confirmed state." });
    }

    if (state.emergencies.length > 0) {
        const first = state.emergencies[0];
        alerts.push({ code: "EMERGENCY_ACTIVE", severity: "CRITICAL", message: `Emergency vehicle ${first?.vehicleId ?? ""} from ${first?.direction ?? ""}.`, direction: first?.direction });
    }
    if (state.manual) {
        alerts.push({ code: "MANUAL_OVERRIDE_ACTIVE", severity: "WARNING", message: `Manual override active for ${state.manual.phaseId}.` });
    }

    for (const [key, status] of Object.entries(state.deviceStatuses)) {
        if (status === "ONLINE") continue;
        const [deviceType, where] = key.split(":");
        alerts.push({
            code: deviceType === "SENSOR" ? "SENSOR_FAILURE" : "SIGNAL_FAILURE",
            severity: status === "OFFLINE" ? "CRITICAL" : "WARNING",
            message: `${deviceType} ${where} is ${status}.`,
        });
    }

    return alerts;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onVehicleArrived(
    ctx: Ctx,
    e: Extract<EngineEvent, { type: "VEHICLE_ARRIVED" }>
): EngineOutcome {
    const { state, config, now } = ctx;

    const phase = getPhaseForDirection(config, e.direction);
    if (!phase) {
        audit(ctx, { type: "EVENT_REJECTED", direction: e.direction, details: { reason: "UNKNOWN_DIRECTION", vehicleId: e.vehicleId } });
        return { accepted: false, code: "UNKNOWN_DIRECTION" };
    }

    // Second line of defence against double counting (the first is event_id dedup at the API).
    if (state.queue.some((v) => v.vehicleId === e.vehicleId)) {
        audit(ctx, { type: "EVENT_REJECTED", direction: e.direction, details: { reason: "DUPLICATE_VEHICLE", vehicleId: e.vehicleId } });
        return { accepted: true, code: "DUPLICATE_IGNORED" };
    }

    state.queue.push({ vehicleId: e.vehicleId, vehicleType: e.vehicleType, direction: e.direction, arrivedAt: now });
    audit(ctx, { type: "VEHICLE_DETECTED", direction: e.direction, details: { vehicleId: e.vehicleId, vehicleType: e.vehicleType } });

    if (e.vehicleType === "EMERGENCY") {
        state.emergencies.push({ vehicleId: e.vehicleId, direction: e.direction, phaseId: phase.id, detectedAt: now });
        audit(ctx, { type: "EMERGENCY_DETECTED", direction: e.direction, details: { vehicleId: e.vehicleId, phaseId: phase.id } });
    }
    return OK;
}

function onVehicleCleared(
    ctx: Ctx,
    e: Extract<EngineEvent, { type: "VEHICLE_CLEARED" }>
): EngineOutcome {
    const { state } = ctx;

    const index = state.queue.findIndex((v) => v.vehicleId === e.vehicleId);
    const queued = state.queue[index];
    if (index < 0 || !queued) {
        // A queue is a list, not a counter, so it can never go below zero.
        audit(ctx, { type: "EVENT_REJECTED", direction: e.direction, details: { reason: "CLEARED_WITHOUT_ARRIVAL", vehicleId: e.vehicleId } });
        return { accepted: false, code: "UNKNOWN_VEHICLE" };
    }
    if (queued.direction !== e.direction) {
        audit(ctx, { type: "EVENT_REJECTED", direction: e.direction, details: { reason: "DIRECTION_MISMATCH", vehicleId: e.vehicleId, queuedDirection: queued.direction } });
        return { accepted: false, code: "DIRECTION_MISMATCH" };
    }

    state.queue.splice(index, 1);
    audit(ctx, { type: "VEHICLE_CLEARED", direction: e.direction, details: { vehicleId: e.vehicleId } });

    const emergencyIndex = state.emergencies.findIndex((r) => r.vehicleId === e.vehicleId);
    if (emergencyIndex >= 0) {
        state.emergencies.splice(emergencyIndex, 1);
        audit(ctx, { type: "EMERGENCY_CLEARED", direction: e.direction, details: { vehicleId: e.vehicleId } });
    }
    return OK;
}

function onManualGreenRequest(ctx: Ctx, direction: Direction): EngineOutcome {
    const { state, config, now } = ctx;

    const phase = getPhaseForDirection(config, direction);
    if (!phase) {
        audit(ctx, { type: "COMMAND_REJECTED", direction, details: { reason: "UNKNOWN_DIRECTION" } });
        return { accepted: false, code: "UNKNOWN_DIRECTION" };
    }
    if (isDegraded(state)) {
        // Never pretend to execute something we cannot confirm.
        audit(ctx, { type: "COMMAND_REJECTED", direction, details: { reason: "CONTROLLER_UNAVAILABLE" } });
        return { accepted: false, code: "CONTROLLER_UNAVAILABLE", message: "Controller state is unknown; manual control is unavailable." };
    }

    const replaced = state.manual?.phaseId ?? null;
    const suspended = state.emergencies.length > 0;
    state.manual = { phaseId: phase.id, direction, requestedAt: now, expiresAt: now + config.timing.manualTimeoutMs };
    audit(ctx, { type: "MANUAL_OVERRIDE_STARTED", direction, details: { phaseId: phase.id, expiresAt: state.manual.expiresAt, replacedPhaseId: replaced, suspendedByEmergency: suspended } });

    return suspended
        ? { accepted: true, code: "ACCEPTED_SUSPENDED_BY_EMERGENCY" }
        : OK;
}

function onReturnToAutomatic(ctx: Ctx): EngineOutcome {
    if (!ctx.state.manual) return { accepted: true, code: "ALREADY_AUTOMATIC" };
    ctx.state.manual = null;
    audit(ctx, { type: "MANUAL_OVERRIDE_ENDED", details: { reason: "RETURN_TO_AUTOMATIC" } });
    return OK;
}

function onCommandResult(
    ctx: Ctx,
    e: Extract<EngineEvent, { type: "COMMAND_RESULT" }>
): EngineOutcome {
    const { state, now } = ctx;
    const pending = state.pendingCommand;

    // Duplicate, late (after timeout) or unknown ACK: never trusted, never applied.
    if (!pending || pending.commandId !== e.commandId) {
        audit(ctx, { type: "COMMAND_ACK_IGNORED", commandId: e.commandId, details: { reason: pending ? "NOT_THE_PENDING_COMMAND" : "NO_PENDING_COMMAND" } });
        return { accepted: true, code: "ACK_IGNORED" };
    }

    if (e.status !== "ACK") {
        failPendingCommand(ctx, e.status);
        return OK;
    }

    if (e.actualSignals && !sameSignals(e.actualSignals, pending.signals)) {
        // The controller says it did something different from what we asked.
        state.actual = { ...e.actualSignals };
        state.pendingCommand = null;
        state.needsResync = true;
        state.controllerStatus = "DEGRADED";
        audit(ctx, { type: "COMMAND_FAILED", commandId: pending.commandId, details: { reason: "STATE_MISMATCH", expected: pending.signals, reported: e.actualSignals } });
        return OK;
    }

    for (const direction of DIRECTIONS) {
        if (state.actual[direction] !== pending.signals[direction]) {
            audit(ctx, { type: "SIGNAL_STATE_CONFIRMED", direction, previousState: state.actual[direction], newState: pending.signals[direction], commandId: pending.commandId });
        }
    }
    state.actual = { ...pending.signals };
    state.stageConfirmedAt = now;
    state.pendingCommand = null;
    state.controllerStatus = "ONLINE";
    if (pending.kind === "RESYNC") state.needsResync = false;
    return OK;
}

function onDeviceStatus(
    ctx: Ctx,
    deviceType: DeviceType,
    status: DeviceStatus,
    direction?: Direction
): EngineOutcome {
    const { state } = ctx;

    if (deviceType === "SIGNAL_CONTROLLER") {
        // One controller per junction: a direction on a controller event is informational.
        const before = state.controllerStatus;
        if (before === status) return { accepted: true, code: "UNCHANGED" };

        state.controllerStatus = status;
        audit(ctx, { type: "CONTROLLER_STATUS_CHANGED", previousState: before, newState: status, direction });

        const lost = status === "OFFLINE" || status === "UNKNOWN";
        const reconnected = status === "ONLINE" && (before === "OFFLINE" || before === "UNKNOWN");
        if (lost || reconnected) {
            // Whenever we lose or regain the controller, earlier physical state is not trusted.
            abandonPendingCommand(ctx, lost ? "CONTROLLER_LOST" : "CONTROLLER_RECONNECTED");
            state.actual = unknownSignals();
            state.needsResync = true;
        }
        return OK;
    }

    const key = `${deviceType}:${direction ?? "ALL"}`;
    const before = state.deviceStatuses[key] ?? "ONLINE";
    if (before === status) return { accepted: true, code: "UNCHANGED" };
    state.deviceStatuses[key] = status;
    audit(ctx, { type: "DEVICE_STATUS_CHANGED", direction, previousState: before, newState: status, details: { deviceType } });
    return OK;
}

function onRestarted(ctx: Ctx): EngineOutcome {
    const { state } = ctx;

    // We do not know what the hardware did while we were down, so nothing is assumed:
    // queue, emergencies and manual override are kept; signal state is re-established.
    abandonPendingCommand(ctx, "BACKEND_RESTART");
    state.actual = unknownSignals();
    state.controllerStatus = "UNKNOWN";
    state.needsResync = true;
    state.stage = "ALL_RED";
    state.activePhaseId = null;
    state.targetPhaseId = null;
    state.desired = allRedSignals();
    state.stageConfirmedAt = null;

    audit(ctx, { type: "SYSTEM_RESTARTED", details: { queueSize: state.queue.length, emergencies: state.emergencies.length, manualActive: state.manual !== null } });
    return OK;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

function advance(ctx: Ctx): void {
    const { state, config, now } = ctx;

    expireEmergencies(ctx);
    expireManual(ctx);

    if (state.pendingCommand) {
        if (now - state.pendingCommand.issuedAt >= config.timing.ackTimeoutMs) {
            failPendingCommand(ctx, "TIMEOUT");
        }
        return; // never stack a new command on top of an unconfirmed one
    }

    if (isDegraded(state)) {
        // UNKNOWN status: a resync doubles as a probe. OFFLINE: wait to be told it is back.
        if (state.needsResync && state.controllerStatus !== "OFFLINE") {
            const signals = allRedSignals();
            issueCommand(ctx, "RESYNC", signals, "ALL_RED", null, null, "RESYNC");
        }
        return;
    }

    step(ctx);
}

function step(ctx: Ctx): void {
    const { state, config, now } = ctx;
    const timing = config.timing;
    const confirmedAt = state.stageConfirmedAt ?? now;
    const elapsed = now - confirmedAt;

    switch (state.stage) {
        case "GREEN": {
            if (state.activePhaseId === null) return;
            const goal = chooseGoalWhileGreen(ctx, state.activePhaseId, confirmedAt);
            if (goal && goal.phaseId !== state.activePhaseId) {
                issueCommand(ctx, "STEP", signalsFor(config, state.activePhaseId, "YELLOW"), "YELLOW", state.activePhaseId, goal.phaseId, goal.reason);
            }
            return;
        }
        case "YELLOW": {
            if (elapsed >= timing.yellowMs) {
                issueCommand(ctx, "STEP", allRedSignals(), "ALL_RED", null, state.targetPhaseId, "YELLOW_COMPLETE");
            }
            return;
        }
        case "ALL_RED": {
            if (elapsed >= timing.allRedMs) {
                const target = chooseTargetAfterClearance(ctx);
                issueCommand(ctx, "STEP", signalsFor(config, target.phaseId, "GREEN"), "GREEN", target.phaseId, null, target.reason);
            }
            return;
        }
    }
}

/** Which phase should be green now? Emergency beats manual beats the scheduler. */
function chooseGoalWhileGreen(
    ctx: Ctx,
    activePhaseId: string,
    confirmedAt: number
): { phaseId: string; reason: string } | null {
    const { state, config, now } = ctx;

    const emergency = state.emergencies[0];
    if (emergency) return { phaseId: emergency.phaseId, reason: "EMERGENCY_PREEMPTION" };
    if (state.manual) return { phaseId: state.manual.phaseId, reason: "MANUAL_OVERRIDE" };

    const decision = decideNextPhase({
        config,
        waiting: state.queue,
        now,
        active: { phaseId: activePhaseId, since: confirmedAt },
    });
    if (decision.action === "SWITCH") {
        audit(ctx, { type: "SCHEDULER_DECISION", details: { from: activePhaseId, to: decision.targetPhaseId, reason: decision.reason, scores: decision.scores } });
        return { phaseId: decision.targetPhaseId, reason: decision.reason };
    }
    return null;
}

/** Called at the end of the all-red gap: choose the phase that gets GREEN, using fresh data. */
function chooseTargetAfterClearance(ctx: Ctx): { phaseId: string; reason: string } {
    const { state, config, now } = ctx;

    const emergency = state.emergencies[0];
    if (emergency) return { phaseId: emergency.phaseId, reason: "EMERGENCY_PREEMPTION" };
    if (state.manual) return { phaseId: state.manual.phaseId, reason: "MANUAL_OVERRIDE" };

    const decision = decideNextPhase({ config, waiting: state.queue, now, active: null });
    if (decision.action === "SWITCH") return { phaseId: decision.targetPhaseId, reason: decision.reason };

    const fallback = state.targetPhaseId ?? config.phases[0]?.id;
    if (!fallback) throw new Error(`Junction ${config.id} has no phases`);
    return { phaseId: fallback, reason: "FALLBACK" };
}

function issueCommand(
    ctx: Ctx,
    kind: CommandKind,
    signals: SignalMap,
    stage: Stage,
    activePhaseId: string | null,
    targetPhaseId: string | null,
    reason: string
): void {
    const { state, config, now } = ctx;

    // The safety net. If any bug upstream asks for something unsafe, we throw here,
    // before anything reaches the controller. RESYNC is the single exception to the
    // step-by-step rule, because physical state is unknown; all-red is still checked.
    if (kind === "STEP") assertSafeTransition(config, state.desired, signals);
    else assertSafeSignalMap(config, signals);

    state.commandSeq += 1;
    const command: ControllerCommand = {
        commandId: `cmd-${config.id}-${String(state.commandSeq).padStart(6, "0")}`,
        junctionId: config.id,
        kind,
        signals,
        issuedAt: now,
        attempt: 1,
    };

    audit(ctx, { type: "SIGNAL_TRANSITION_STARTED", commandId: command.commandId, details: { kind, fromStage: state.stage, toStage: stage, activePhaseId, targetPhaseId, reason } });
    for (const direction of DIRECTIONS) {
        if (state.desired[direction] !== signals[direction]) {
            audit(ctx, { type: "SIGNAL_STATE_REQUESTED", direction, previousState: state.desired[direction], newState: signals[direction], commandId: command.commandId });
        }
    }

    state.stage = stage;
    state.activePhaseId = activePhaseId;
    state.targetPhaseId = targetPhaseId;
    state.desired = { ...signals };
    state.stageConfirmedAt = null;
    state.pendingCommand = command;
    ctx.effects.push({ type: "SEND_COMMAND", command });
}

function failPendingCommand(ctx: Ctx, reason: "TIMEOUT" | "NACK" | "FAILED"): void {
    const { state, now } = ctx;
    const pending = state.pendingCommand;
    if (!pending) return;

    audit(ctx, { type: reason === "TIMEOUT" ? "COMMAND_TIMEOUT" : "COMMAND_FAILED", commandId: pending.commandId, details: { reason, attempt: pending.attempt } });

    if (pending.attempt < MAX_COMMAND_ATTEMPTS) {
        // Same commandId: the controller can recognise a retry of something it already did.
        const retry: ControllerCommand = { ...pending, attempt: pending.attempt + 1, issuedAt: now };
        state.pendingCommand = retry;
        ctx.effects.push({ type: "SEND_COMMAND", command: retry });
        audit(ctx, { type: "COMMAND_RETRY", commandId: retry.commandId, details: { attempt: retry.attempt } });
        return;
    }

    // Gave up. A controller that does not confirm is NEVER assumed to have executed.
    state.pendingCommand = null;
    state.controllerStatus = "OFFLINE";
    state.actual = unknownSignals();
    state.needsResync = true;
    audit(ctx, { type: "CONTROLLER_STATUS_CHANGED", previousState: "ONLINE", newState: "OFFLINE", details: { reason: "COMMAND_NOT_CONFIRMED", commandId: pending.commandId } });
}

function abandonPendingCommand(ctx: Ctx, reason: string): void {
    const pending = ctx.state.pendingCommand;
    if (!pending) return;
    ctx.state.pendingCommand = null;
    audit(ctx, { type: "COMMAND_ABANDONED", commandId: pending.commandId, details: { reason } });
}

function expireEmergencies(ctx: Ctx): void {
    const { state, config, now } = ctx;
    const stale = state.emergencies.filter((r) => now - r.detectedAt >= config.timing.emergencyTimeoutMs);
    if (stale.length === 0) return;

    for (const record of stale) {
        audit(ctx, { type: "EMERGENCY_TIMED_OUT", direction: record.direction, details: { vehicleId: record.vehicleId } });
        // A vehicle that never reported "cleared" must not keep its priority forever.
        state.queue = state.queue.filter((v) => v.vehicleId !== record.vehicleId);
    }
    state.emergencies = state.emergencies.filter((r) => !stale.includes(r));
}

function expireManual(ctx: Ctx): void {
    const { state, now } = ctx;
    if (state.manual && now >= state.manual.expiresAt) {
        state.manual = null;
        audit(ctx, { type: "MANUAL_OVERRIDE_ENDED", details: { reason: "EXPIRED" } });
    }
}

function updateMode(ctx: Ctx): void {
    const next = deriveMode(ctx.state);
    if (next !== ctx.state.mode) {
        audit(ctx, { type: "MODE_CHANGED", previousState: ctx.state.mode, newState: next });
        ctx.state.mode = next;
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function audit(ctx: Ctx, entry: Omit<AuditEntry, "at">): void {
    ctx.effects.push({ type: "AUDIT", entry: { ...entry, at: ctx.now } });
}

function unknownSignals(): ActualSignalMap {
    return { NORTH: "UNKNOWN", SOUTH: "UNKNOWN", EAST: "UNKNOWN", WEST: "UNKNOWN" };
}

function sameSignals(a: SignalMap, b: SignalMap): boolean {
    return DIRECTIONS.every((direction) => a[direction] === b[direction]);
}