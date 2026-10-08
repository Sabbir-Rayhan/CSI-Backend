import { getPhaseForDirection, type JunctionConfig } from "./junctionConfig";
import type { Direction, VehicleType } from "./types";

export interface WaitingVehicle {
    vehicleId: string;
    vehicleType: VehicleType;
    direction: Direction;
    /**
     * When the backend RECEIVED the arrival (ms since epoch). Deliberately the server
     * clock, not the sensor clock: sensor clocks drift, and waiting time must be
     * measured on one trusted clock.
     */
    arrivedAt: number;
}

export interface ActivePhase {
    phaseId: string;
    /** When this phase became GREEN (ms since epoch). */
    since: number;
}

export interface SchedulerInput {
    config: JunctionConfig;
    waiting: readonly WaitingVehicle[];
    now: number;
    /** null = no phase is currently green (e.g. start-up, or all-red). */
    active: ActivePhase | null;
}

export interface SchedulerPolicy {
    vehicleWeight: Record<VehicleType, number>;
    /** Extra points each waiting vehicle earns per second it has waited. */
    agingPerSecond: number;
    /** Another phase must beat the active phase by this factor to take over early. */
    switchMargin: number;
}

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = {
    vehicleWeight: { EMERGENCY: 100, TRUCK: 4, FORKLIFT: 3, EMPLOYEE_VEHICLE: 1 },
    agingPerSecond: 0.1,
    switchMargin: 1.5,
};

export interface PhaseScore {
    phaseId: string;
    score: number;
    vehicleCount: number;
    longestWaitMs: number;
    hasEmergency: boolean;
}

export type StayReason =
    | "NO_COMPETING_TRAFFIC"
    | "MIN_GREEN_NOT_REACHED"
    | "ACTIVE_PHASE_STILL_BEST";

export type SwitchReason =
    | "NO_ACTIVE_PHASE"
    | "STARVATION_PROTECTION"
    | "ACTIVE_QUEUE_EMPTY"
    | "MAX_GREEN_REACHED"
    | "HIGHER_SCORE";

export type SchedulerDecision =
    | { action: "STAY"; reason: StayReason; scores: PhaseScore[] }
    | { action: "SWITCH"; targetPhaseId: string; reason: SwitchReason; scores: PhaseScore[] };

export function scoreVehicle(
    vehicle: WaitingVehicle,
    now: number,
    policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY
): number {
    const waitedSeconds = Math.max(0, now - vehicle.arrivedAt) / 1000;
    return policy.vehicleWeight[vehicle.vehicleType] + waitedSeconds * policy.agingPerSecond;
}

/** One score per phase, in the same order as config.phases. */
export function scorePhases(
    config: JunctionConfig,
    waiting: readonly WaitingVehicle[],
    now: number,
    policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY
): PhaseScore[] {
    const entries: PhaseScore[] = config.phases.map((phase) => ({
        phaseId: phase.id,
        score: 0,
        vehicleCount: 0,
        longestWaitMs: 0,
        hasEmergency: false,
    }));
    const byId = new Map(entries.map((entry) => [entry.phaseId, entry]));

    for (const vehicle of waiting) {
        const phase = getPhaseForDirection(config, vehicle.direction);
        const entry = phase ? byId.get(phase.id) : undefined;
        if (!entry) continue; // direction not part of this junction: ignore

        entry.score += scoreVehicle(vehicle, now, policy);
        entry.vehicleCount += 1;
        entry.longestWaitMs = Math.max(entry.longestWaitMs, Math.max(0, now - vehicle.arrivedAt));
        if (vehicle.vehicleType === "EMERGENCY") entry.hasEmergency = true;
    }

    for (const entry of entries) entry.score = Math.round(entry.score * 100) / 100;
    return entries;
}

/** Highest score first; ties go to the longest wait, then to config order (sort is stable). */
function rank(candidates: PhaseScore[]): PhaseScore[] {
    return [...candidates].sort(
        (a, b) => b.score - a.score || b.longestWaitMs - a.longestWaitMs
    );
}

export function decideNextPhase(
    input: SchedulerInput,
    policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY
): SchedulerDecision {
    const { config, waiting, now, active } = input;
    const timing = config.timing;
    const scores = scorePhases(config, waiting, now, policy);

    // Nothing is green yet: start with the busiest phase, or the first one if all are empty.
    if (active === null) {
        const best = rank(scores.filter((s) => s.vehicleCount > 0))[0] ?? scores[0];
        if (!best) throw new Error(`Junction ${config.id} has no phases`);
        return { action: "SWITCH", targetPhaseId: best.phaseId, reason: "NO_ACTIVE_PHASE", scores };
    }

    const activeScore = scores.find((s) => s.phaseId === active.phaseId);
    if (!activeScore) throw new Error(`Unknown active phase ${active.phaseId} for junction ${config.id}`);

    const competitors = rank(
        scores.filter((s) => s.phaseId !== active.phaseId && s.vehicleCount > 0)
    );
    const best = competitors[0];

    // 1. Nobody else is waiting: switching would only waste time.
    if (!best) return { action: "STAY", reason: "NO_COMPETING_TRAFFIC", scores };

    const greenElapsed = now - active.since;

    // 2. Respect the minimum green, unless nobody is waiting on the current green.
    if (activeScore.vehicleCount > 0 && greenElapsed < timing.minGreenMs) {
        return { action: "STAY", reason: "MIN_GREEN_NOT_REACHED", scores };
    }

    // 3. Starvation protection: a hard guarantee, independent of scores.
    const starved = competitors
        .filter((s) => s.longestWaitMs >= timing.maxWaitMs)
        .sort((a, b) => b.longestWaitMs - a.longestWaitMs)[0];
    if (starved) {
        return { action: "SWITCH", targetPhaseId: starved.phaseId, reason: "STARVATION_PROTECTION", scores };
    }

    // 4. Current green is empty but others are waiting: give the time away.
    if (activeScore.vehicleCount === 0) {
        return { action: "SWITCH", targetPhaseId: best.phaseId, reason: "ACTIVE_QUEUE_EMPTY", scores };
    }

    // 5. Normal green time is used up.
    if (greenElapsed >= timing.greenMs) {
        return { action: "SWITCH", targetPhaseId: best.phaseId, reason: "MAX_GREEN_REACHED", scores };
    }

    // 6. Another phase is clearly more urgent (margin prevents flip-flopping).
    if (best.score > activeScore.score * policy.switchMargin) {
        return { action: "SWITCH", targetPhaseId: best.phaseId, reason: "HIGHER_SCORE", scores };
    }

    // 7. Keep the current green.
    return { action: "STAY", reason: "ACTIVE_PHASE_STILL_BEST", scores };
}