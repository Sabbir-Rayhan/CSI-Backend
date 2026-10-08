import {
    getConflictingDirections,
    getJunctionDirections,
    getPhaseForDirection,
    type JunctionConfig,
} from "./junctionConfig";
import { DIRECTIONS, type SignalMap, type SignalState } from "./types";

export class SafetyViolationError extends Error {
    readonly violations: string[];

    constructor(violations: string[]) {
        super(`Unsafe signal operation: ${violations.join("; ")}`);
        this.name = "SafetyViolationError";
        this.violations = violations;
    }
}

/** A signal may only move one step at a time: RED -> GREEN -> YELLOW -> RED. */
const ALLOWED_STEPS: Record<SignalState, readonly SignalState[]> = {
    RED: ["GREEN"],
    GREEN: ["YELLOW"],
    YELLOW: ["RED"],
};

export function allRedSignals(): SignalMap {
    return { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" };
}

/** Builds a signal map where the given phase shows `state` and everything else is RED. */
export function signalsFor(
    config: JunctionConfig,
    phaseId: string | null,
    state: SignalState
): SignalMap {
    const signals = allRedSignals();
    if (phaseId === null) return signals;

    const phase = config.phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Unknown phase ${phaseId} for junction ${config.id}`);

    for (const direction of phase.directions) signals[direction] = state;
    return signals;
}

/**
 * Rule: if any direction of a phase is not RED (GREEN or YELLOW), every direction of
 * every OTHER phase must be RED. This is stricter than "no two GREENs" on purpose:
 * it also forbids YELLOW + GREEN overlap, which is how an unsafe changeover looks.
 */
export function findSignalViolations(config: JunctionConfig, signals: SignalMap): string[] {
    const violations: string[] = [];
    const junctionDirections = getJunctionDirections(config);

    for (const direction of DIRECTIONS) {
        if (!junctionDirections.includes(direction) && signals[direction] !== "RED") {
            violations.push(`${direction} is not part of junction ${config.id} but is ${signals[direction]}`);
        }
    }

    for (const a of junctionDirections) {
        if (signals[a] === "RED") continue;
        for (const b of getConflictingDirections(config, a)) {
            if (signals[b] !== "RED" && a < b) {
                violations.push(`conflict: ${a}=${signals[a]} while ${b}=${signals[b]}`);
            }
        }
    }

    return violations;
}

/** Checks one step from `from` to `to`. The engine calls this before emitting any command. */
export function findTransitionViolations(
    config: JunctionConfig,
    from: SignalMap,
    to: SignalMap
): string[] {
    const violations = [...findSignalViolations(config, to)];

    for (const direction of DIRECTIONS) {
        const before = from[direction];
        const after = to[direction];
        if (before === after) continue;

        if (!ALLOWED_STEPS[before].includes(after)) {
            violations.push(`${direction}: ${before} -> ${after} is not an allowed step`);
            continue;
        }

        if (before === "RED" && after === "GREEN") {
            for (const conflicting of getConflictingDirections(config, direction)) {
                if (from[conflicting] !== "RED") {
                    violations.push(
                        `${direction} cannot turn GREEN while ${conflicting} was ${from[conflicting]} (clearance interval required)`
                    );
                }
            }
        }
    }

    return violations;
}

export function assertSafeSignalMap(config: JunctionConfig, signals: SignalMap): void {
    const violations = findSignalViolations(config, signals);
    if (violations.length > 0) throw new SafetyViolationError(violations);
}

export function assertSafeTransition(config: JunctionConfig, from: SignalMap, to: SignalMap): void {
    const violations = findTransitionViolations(config, from, to);
    if (violations.length > 0) throw new SafetyViolationError(violations);
}

/** Convenience: which phase (if any) is currently non-RED. */
export function activePhaseOf(config: JunctionConfig, signals: SignalMap): string | null {
    for (const direction of getJunctionDirections(config)) {
        if (signals[direction] !== "RED") return getPhaseForDirection(config, direction)?.id ?? null;
    }
    return null;
}