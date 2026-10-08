import { DIRECTIONS, type Direction } from "./types";

export interface PhaseConfig {
    id: string;
    directions: readonly Direction[];
}

export interface TimingConfig {
    greenMs: number;            // normal green duration (~30s)
    minGreenMs: number;         // do not switch away before this (avoids thrashing)
    yellowMs: number;           // yellow duration (~5s)
    allRedMs: number;           // clearance interval between conflicting phases
    ackTimeoutMs: number;       // how long to wait for a controller ACK
    maxWaitMs: number;          // starvation guard: a waiting direction is served by then
    manualTimeoutMs: number;    // manual override auto-expires after this
    emergencyTimeoutMs: number; // stale emergency events expire after this
}

export interface JunctionConfig {
    id: string;
    name: string;
    phases: readonly PhaseConfig[];
    timing: TimingConfig;
}

export const DEFAULT_TIMING: TimingConfig = {
    greenMs: 30_000,
    minGreenMs: 10_000,
    yellowMs: 5_000,
    allRedMs: 2_000,
    ackTimeoutMs: 3_000,
    maxWaitMs: 90_000,
    manualTimeoutMs: 5 * 60_000,
    emergencyTimeoutMs: 60_000,
};

/** Standard 4-way junction: two phases, NORTH+SOUTH and EAST+WEST. */
export function createFourWayJunctionConfig(
    id: string,
    name: string = `Junction ${id}`,
    timing: Partial<TimingConfig> = {}
): JunctionConfig {
    return {
        id,
        name,
        phases: [
            { id: "NORTH_SOUTH", directions: ["NORTH", "SOUTH"] },
            { id: "EAST_WEST", directions: ["EAST", "WEST"] },
        ],
        timing: { ...DEFAULT_TIMING, ...timing },
    };
}

/** Returns a list of problems. Empty list = config is valid. */
export function validateJunctionConfig(config: JunctionConfig): string[] {
    const problems: string[] = [];

    if (config.id.trim() === "") problems.push("junction id must not be empty");
    if (config.phases.length < 2) problems.push("a junction needs at least two phases");

    const phaseIds = new Set<string>();
    const directionOwner = new Map<Direction, string>();

    for (const phase of config.phases) {
        if (phaseIds.has(phase.id)) problems.push(`duplicate phase id ${phase.id}`);
        phaseIds.add(phase.id);

        if (phase.directions.length === 0) problems.push(`phase ${phase.id} has no directions`);

        for (const direction of phase.directions) {
            if (!DIRECTIONS.includes(direction)) {
                problems.push(`unknown direction ${String(direction)} in phase ${phase.id}`);
                continue;
            }
            const owner = directionOwner.get(direction);
            if (owner !== undefined) {
                problems.push(`direction ${direction} appears in both ${owner} and ${phase.id}`);
            } else {
                directionOwner.set(direction, phase.id);
            }
        }
    }

    for (const [key, value] of Object.entries(config.timing)) {
        if (!(value > 0)) problems.push(`timing.${key} must be greater than 0`);
    }
    if (config.timing.minGreenMs > config.timing.greenMs) {
        problems.push("timing.minGreenMs must not be greater than timing.greenMs");
    }

    return problems;
}

export function assertValidJunctionConfig(config: JunctionConfig): void {
    const problems = validateJunctionConfig(config);
    if (problems.length > 0) {
        throw new Error(`Invalid junction config "${config.id}": ${problems.join("; ")}`);
    }
}

export function getJunctionDirections(config: JunctionConfig): Direction[] {
    return config.phases.flatMap((phase) => [...phase.directions]);
}

export function getPhaseForDirection(
    config: JunctionConfig,
    direction: Direction
): PhaseConfig | undefined {
    return config.phases.find((phase) => phase.directions.includes(direction));
}

/** Two movements conflict when they belong to DIFFERENT phases. */
export function getConflictingDirections(
    config: JunctionConfig,
    direction: Direction
): Direction[] {
    const own = getPhaseForDirection(config, direction);
    if (!own) return [];
    return config.phases
        .filter((phase) => phase.id !== own.id)
        .flatMap((phase) => [...phase.directions]);
}