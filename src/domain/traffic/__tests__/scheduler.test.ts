import { describe, expect, it } from "vitest";
import { createFourWayJunctionConfig } from "../junctionConfig";
import {
    decideNextPhase,
    scorePhases,
    type SchedulerInput,
    type WaitingVehicle,
} from "../scheduler";
import type { Direction, VehicleType } from "../types";

const config = createFourWayJunctionConfig("A"); // min 10s, green 30s, maxWait 90s
const NOW = 1_000_000_000;
const SECOND = 1000;

let counter = 0;
function vehicle(
    direction: Direction,
    vehicleType: VehicleType,
    waitedSeconds = 0
): WaitingVehicle {
    counter += 1;
    return {
        vehicleId: `V-${counter}`,
        vehicleType,
        direction,
        arrivedAt: NOW - waitedSeconds * SECOND,
    };
}

function input(
    waiting: WaitingVehicle[],
    active: { phaseId: string; sinceSecondsAgo: number } | null
): SchedulerInput {
    return {
        config,
        waiting,
        now: NOW,
        active: active ? { phaseId: active.phaseId, since: NOW - active.sinceSecondsAgo * SECOND } : null,
    };
}

describe("scoring", () => {
    it("a truck outweighs two employee vehicles", () => {
        const [ns, ew] = scorePhases(config, [vehicle("NORTH", "TRUCK"), vehicle("EAST", "EMPLOYEE_VEHICLE"), vehicle("WEST", "EMPLOYEE_VEHICLE")], NOW);
        expect(ns!.score).toBeGreaterThan(ew!.score);
    });

    it("an employee vehicle that has waited long enough outranks a fresh truck (aging)", () => {
        const [ns, ew] = scorePhases(config, [vehicle("NORTH", "EMPLOYEE_VEHICLE", 120), vehicle("EAST", "TRUCK")], NOW);
        expect(ns!.score).toBeGreaterThan(ew!.score);
    });

    it("flags a phase that contains an emergency vehicle", () => {
        const [ns, ew] = scorePhases(config, [vehicle("EAST", "EMERGENCY")], NOW);
        expect(ew!.hasEmergency).toBe(true);
        expect(ns!.hasEmergency).toBe(false);
    });
});

describe("decideNextPhase", () => {
    it("stays when nobody else is waiting", () => {
        const d = decideNextPhase(input([vehicle("NORTH", "TRUCK")], { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 100 }));
        expect(d).toMatchObject({ action: "STAY", reason: "NO_COMPETING_TRAFFIC" });
    });

    it("stays during minimum green even if another phase is much busier", () => {
        const waiting = [vehicle("NORTH", "EMPLOYEE_VEHICLE"), ...Array.from({ length: 10 }, () => vehicle("EAST", "TRUCK"))];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 5 }));
        expect(d).toMatchObject({ action: "STAY", reason: "MIN_GREEN_NOT_REACHED" });
    });

    it("gaps out immediately when the green phase is empty, even inside minimum green", () => {
        const d = decideNextPhase(input([vehicle("EAST", "EMPLOYEE_VEHICLE")], { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 2 }));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "EAST_WEST", reason: "ACTIVE_QUEUE_EMPTY" });
    });

    it("switches after normal green time is used up", () => {
        const waiting = [vehicle("NORTH", "EMPLOYEE_VEHICLE"), vehicle("EAST", "EMPLOYEE_VEHICLE")];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 31 }));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "EAST_WEST", reason: "MAX_GREEN_REACHED" });
    });

    it("switches early when another phase is clearly more urgent", () => {
        const waiting = [vehicle("NORTH", "EMPLOYEE_VEHICLE"), vehicle("EAST", "TRUCK"), vehicle("WEST", "TRUCK"), vehicle("EAST", "TRUCK")];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 15 }));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "EAST_WEST", reason: "HIGHER_SCORE" });
    });

    it("does not switch for a marginal lead (hysteresis)", () => {
        // active = 2 employees (2.0); challenger = 1 forklift (3.0); 3.0 is not > 2.0 * 1.5
        const waiting = [vehicle("NORTH", "EMPLOYEE_VEHICLE"), vehicle("SOUTH", "EMPLOYEE_VEHICLE"), vehicle("EAST", "FORKLIFT")];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 15 }));
        expect(d).toMatchObject({ action: "STAY", reason: "ACTIVE_PHASE_STILL_BEST" });
    });

    it("starvation protection forces a switch no matter how busy the active phase is", () => {
        const waiting = [
            ...Array.from({ length: 5 }, () => vehicle("NORTH", "TRUCK")),
            vehicle("EAST", "EMPLOYEE_VEHICLE", 95),
        ];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 20 }));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "EAST_WEST", reason: "STARVATION_PROTECTION" });
    });

    it("the same situation just under the limit does not trigger starvation protection", () => {
        const waiting = [
            ...Array.from({ length: 5 }, () => vehicle("NORTH", "TRUCK")),
            vehicle("EAST", "EMPLOYEE_VEHICLE", 80),
        ];
        const d = decideNextPhase(input(waiting, { phaseId: "NORTH_SOUTH", sinceSecondsAgo: 20 }));
        expect(d).toMatchObject({ action: "STAY", reason: "ACTIVE_PHASE_STILL_BEST" });
    });

    it("with no active phase, starts with the busiest phase", () => {
        const d = decideNextPhase(input([vehicle("EAST", "TRUCK")], null));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "EAST_WEST", reason: "NO_ACTIVE_PHASE" });
    });

    it("with no active phase and no traffic, starts with the first configured phase", () => {
        const d = decideNextPhase(input([], null));
        expect(d).toMatchObject({ action: "SWITCH", targetPhaseId: "NORTH_SOUTH" });
    });

    it("is deterministic on an exact tie (config order wins)", () => {
        const waiting = [vehicle("NORTH", "TRUCK"), vehicle("EAST", "TRUCK")];
        const d = decideNextPhase(input(waiting, null));
        expect(d).toMatchObject({ targetPhaseId: "NORTH_SOUTH" });
    });
});