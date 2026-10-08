import { deriveAlerts } from "../../domain/traffic/junctionEngine";
import type { JunctionConfig } from "../../domain/traffic/junctionConfig";
import type { Alert, JunctionState } from "../../domain/traffic/engineTypes";
import { DIRECTIONS, type ActualSignalMap, type Direction, type SignalMap } from "../../domain/traffic/types";

export interface JunctionStatusDto {
    junction_id: string;
    name: string;
    mode: string;
    phase: string | null;
    target_phase: string | null;
    stage: string;
    controller_status: string;
    desired_signals: SignalMap;
    actual_signals: ActualSignalMap;
    queues: Record<Direction, number>;
    queue_total: number;
    waiting_vehicles: Array<{ vehicle_id: string; vehicle_type: string; direction: Direction; waiting_ms: number }>;
    emergency: {
        active: boolean;
        vehicles: Array<{ vehicle_id: string; direction: Direction; phase: string; detected_at: string }>;
    };
    manual: null | {
        active: boolean;
        phase: string;
        direction: Direction;
        requested_at: string;
        expires_at: string;
        suspended_by_emergency: boolean;
    };
    pending_command: null | {
        command_id: string;
        kind: string;
        attempt: number;
        requested_signals: SignalMap;
        issued_at: string;
    };
    needs_resync: boolean;
    device_statuses: Record<string, string>;
    alerts: Alert[];
    seconds_in_stage: number | null;
    updated_at: string;
    server_time: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Pure mapping: engine state -> API shape. Everything the UI shows comes from here. */
export function toStatusDto(config: JunctionConfig, state: JunctionState, now: number): JunctionStatusDto {
    const queues = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 } as Record<Direction, number>;
    for (const vehicle of state.queue) queues[vehicle.direction] += 1;
    for (const direction of DIRECTIONS) {
        // keep the shape stable for the UI even if a direction is not part of this junction
        queues[direction] = queues[direction] ?? 0;
    }

    return {
        junction_id: state.junctionId,
        name: config.name,
        mode: state.mode,
        phase: state.activePhaseId,
        target_phase: state.targetPhaseId,
        stage: state.stage,
        controller_status: state.controllerStatus,
        desired_signals: state.desired,
        actual_signals: state.actual,
        queues,
        queue_total: state.queue.length,
        waiting_vehicles: state.queue.map((v) => ({
            vehicle_id: v.vehicleId,
            vehicle_type: v.vehicleType,
            direction: v.direction,
            waiting_ms: Math.max(0, now - v.arrivedAt),
        })),
        emergency: {
            active: state.emergencies.length > 0,
            vehicles: state.emergencies.map((e) => ({
                vehicle_id: e.vehicleId,
                direction: e.direction,
                phase: e.phaseId,
                detected_at: iso(e.detectedAt),
            })),
        },
        manual: state.manual
            ? {
                  active: true,
                  phase: state.manual.phaseId,
                  direction: state.manual.direction,
                  requested_at: iso(state.manual.requestedAt),
                  expires_at: iso(state.manual.expiresAt),
                  suspended_by_emergency: state.emergencies.length > 0,
              }
            : null,
        pending_command: state.pendingCommand
            ? {
                  command_id: state.pendingCommand.commandId,
                  kind: state.pendingCommand.kind,
                  attempt: state.pendingCommand.attempt,
                  requested_signals: state.pendingCommand.signals,
                  issued_at: iso(state.pendingCommand.issuedAt),
              }
            : null,
        needs_resync: state.needsResync,
        device_statuses: state.deviceStatuses,
        alerts: deriveAlerts(state),
        seconds_in_stage:
            state.stageConfirmedAt === null ? null : Math.max(0, Math.round((now - state.stageConfirmedAt) / 1000)),
        updated_at: iso(state.updatedAt),
        server_time: iso(now),
    };
}