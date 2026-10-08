import { describe, expect, it } from "vitest";
import {
    assertValidJunctionConfig,
    createFourWayJunctionConfig,
    getConflictingDirections,
    validateJunctionConfig,
} from "../junctionConfig";
import {
    SafetyViolationError,
    allRedSignals,
    assertSafeTransition,
    findSignalViolations,
    findTransitionViolations,
    signalsFor,
} from "../safety";

const config = createFourWayJunctionConfig("A");

describe("junction config", () => {
    it("default four-way config is valid", () => {
        expect(() => assertValidJunctionConfig(config)).not.toThrow();
    });

    it("rejects a direction that appears in two phases", () => {
        const bad = {
            ...config,
            phases: [
                { id: "P1", directions: ["NORTH", "SOUTH"] as const },
                { id: "P2", directions: ["SOUTH", "EAST"] as const },
            ],
        };
        expect(validateJunctionConfig(bad).join(" ")).toContain("SOUTH");
    });

    it("rejects non-positive timings", () => {
        const bad = { ...config, timing: { ...config.timing, yellowMs: 0 } };
        expect(validateJunctionConfig(bad).join(" ")).toContain("yellowMs");
    });

    it("conflicts are directions in other phases", () => {
        expect(getConflictingDirections(config, "NORTH").sort()).toEqual(["EAST", "WEST"]);
    });
});

describe("signal map safety", () => {
    it("all red is safe", () => {
        expect(findSignalViolations(config, allRedSignals())).toEqual([]);
    });

    it("NORTH+SOUTH green with EAST+WEST red is safe", () => {
        expect(findSignalViolations(config, signalsFor(config, "NORTH_SOUTH", "GREEN"))).toEqual([]);
    });

    it("conflicting GREENs are unsafe", () => {
        const signals = { ...allRedSignals(), NORTH: "GREEN", EAST: "GREEN" } as const;
        expect(findSignalViolations(config, signals).length).toBeGreaterThan(0);
    });

    it("YELLOW overlapping a conflicting GREEN is unsafe", () => {
        const signals = { ...allRedSignals(), NORTH: "YELLOW", EAST: "GREEN" } as const;
        expect(findSignalViolations(config, signals).length).toBeGreaterThan(0);
    });
});

describe("transition safety", () => {
    const nsGreen = signalsFor(config, "NORTH_SOUTH", "GREEN");
    const nsYellow = signalsFor(config, "NORTH_SOUTH", "YELLOW");
    const red = allRedSignals();
    const ewGreen = signalsFor(config, "EAST_WEST", "GREEN");

    it("the full safe sequence passes every step", () => {
        expect(findTransitionViolations(config, nsGreen, nsYellow)).toEqual([]);
        expect(findTransitionViolations(config, nsYellow, red)).toEqual([]);
        expect(findTransitionViolations(config, red, ewGreen)).toEqual([]);
    });

    it("GREEN directly to a conflicting GREEN is rejected", () => {
        expect(findTransitionViolations(config, nsGreen, ewGreen).length).toBeGreaterThan(0);
    });

    it("GREEN directly to RED is rejected (must pass YELLOW)", () => {
        expect(findTransitionViolations(config, nsGreen, red).join(" ")).toContain("not an allowed step");
    });

    it("skipping the all-red clearance is rejected", () => {
        expect(findTransitionViolations(config, nsYellow, ewGreen).length).toBeGreaterThan(0);
    });

    it("assertSafeTransition throws SafetyViolationError", () => {
        expect(() => assertSafeTransition(config, nsGreen, ewGreen)).toThrow(SafetyViolationError);
    });
});