import { describe, expect, it } from "vitest";
import type { AuditEntry, ControllerCommand, EngineEvent, EngineResult, JunctionState } from "../engineTypes";
import { createInitialState, deriveAlerts, processEvent } from "../junctionEngine";
import { createFourWayJunctionConfig } from "../junctionConfig";
import { findSignalViolations } from "../safety";
import { DIRECTIONS, type Direction, type VehicleType } from "../types";

// green 30s, min green 10s, yellow 5s, all-red 2s, ack timeout 3s, manual 5min, emergency 60s
const config = createFourWayJunctionConfig("A");
const S = 1000;

/** A tiny simulator: a controllable clock plus an optional well-behaved controller. */
class Sim {
    state: JunctionState = createInitialState(config, 0);
    now = 0;
    autoAck = true;
    sent: { at: number; command: ControllerCommand }[] = [];
    audit: AuditEntry[] = [];
    last!: EngineResult;

    send(event: EngineEvent): EngineResult {
        const result = processEvent(config, this.state, event, this.now);
        this.state = result.state;
        this.last = result;
        // The core invariant, checked after EVERY event of EVERY test.
        expect(findSignalViolations(config, this.state.desired)).toEqual([]);

        const commands: ControllerCommand[] = [];
        for (const effect of result.effects) {
            if (effect.type === "SEND_COMMAND") {
                this.sent.push({ at: this.now, command: effect.command });
                commands.push(effect.command);
            } else {
                this.audit.push(effect.entry);
            }
        }
        if (this.autoAck) {
            for (const command of commands) {
                this.send({ type: "COMMAND_RESULT", commandId: command.commandId, status: "ACK" });
            }
        }
        return result;
    }

    at(seconds: number): this {
        this.now = seconds * S;
        return this;
    }

    /** Advance the clock in 500 ms ticks. */
    run(seconds: number): this {
        const end = this.now + seconds * S;
        while (this.now < end) {
            this.now += 500;
            this.send({ type: "TICK" });
        }
        return this;
    }

    arrive(direction: Direction, vehicleType: VehicleType, vehicleId: string): EngineResult {
        return this.send({ type: "VEHICLE_ARRIVED", vehicleId, vehicleType, direction });
    }

    clear(direction: Direction, vehicleId: string): EngineResult {
        return this.send({ type: "VEHICLE_CLEARED", vehicleId, direction });
    }

    /** Start-up: resync, then wait for the first green (NORTH_SOUTH when idle). */
    boot(): this {
        this.send({ type: "TICK" });
        this.run(10);
        return this;
    }

    greenPhase(): string | null {
        const ns = this.state.desired.NORTH === "GREEN";
        const ew = this.state.desired.EAST === "GREEN";
        return ns ? "NORTH_SOUTH" : ew ? "EAST_WEST" : null;
    }

    auditTypes(): string[] {
        return this.audit.map((a) => a.type);
    }
}

describe("start-up and the safe cycle", () => {
    it("first sends an all-red RESYNC, then starts the first phase after the clearance gap", () => {
        const sim = new Sim();
        sim.send({ type: "TICK" });
        expect(sim.sent[0]?.command.kind).toBe("RESYNC");
        expect(sim.state.mode).toBe("AUTOMATIC"); // acked, no longer degraded
        sim.run(10);
        expect(sim.greenPhase()).toBe("NORTH_SOUTH");
    });

    it("an idle junction keeps its green and does not switch for no reason", () => {
        const sim = new Sim().boot();
        const before = sim.sent.length;
        sim.run(300);
        expect(sim.sent.length).toBe(before);
    });

    it("an empty green gives way immediately, via YELLOW then ALL RED then GREEN with correct timing", () => {
        const sim = new Sim().boot();
        sim.sent.length = 0;
        sim.arrive("EAST", "EMPLOYEE_VEHICLE", "V1"); // nobody on NORTH_SOUTH
        const t0 = sim.now;

        expect(sim.sent[0]?.command.signals.NORTH).toBe("YELLOW");
        sim.run(10);

        const steps = sim.sent.map((s) => ({ t: (s.at - t0) / S, n: s.command.signals.NORTH, e: s.command.signals.EAST }));
        expect(steps).toEqual([
            { t: 0, n: "YELLOW", e: "RED" },
            { t: 5, n: "RED", e: "RED" }, // yellow lasts 5 s
            { t: 7, n: "RED", e: "GREEN" }, // all-red lasts 2 s
        ]);
    });

    it("does not leave a green before the minimum green while it still has traffic", () => {
        const sim = new Sim().boot();
        sim.sent.length = 0;
        sim.arrive("NORTH", "EMPLOYEE_VEHICLE", "N1");
        for (let i = 0; i < 5; i++) sim.arrive("EAST", "TRUCK", `E${i}`);
        sim.run(1.5); // the green is about 9.5 s old: still inside the 10 s minimum
        expect(sim.sent.length).toBe(0);
        sim.run(1); // minimum reached, and EAST is far busier
        expect(sim.sent[0]?.command.signals.NORTH).toBe("YELLOW");
    });
});

describe("vehicle events", () => {
    it("ignores a repeated arrival of the same vehicle", () => {
        const sim = new Sim().boot();
        sim.arrive("NORTH", "TRUCK", "V1");
        const second = sim.arrive("NORTH", "TRUCK", "V1");
        expect(sim.state.queue.length).toBe(1);
        expect(second.outcome.code).toBe("DUPLICATE_IGNORED");
    });

    it("rejects a clear with no matching arrival and never lets a queue go below zero", () => {
        const sim = new Sim().boot();
        expect(sim.clear("NORTH", "GHOST").outcome).toMatchObject({ accepted: false, code: "UNKNOWN_VEHICLE" });
        sim.arrive("NORTH", "FORKLIFT", "V1");
        sim.clear("NORTH", "V1");
        expect(sim.clear("NORTH", "V1").outcome.accepted).toBe(false); // double clear
        expect(sim.state.queue.length).toBe(0);
    });

    it("rejects a clear that names the wrong direction", () => {
        const sim = new Sim().boot();
        sim.arrive("NORTH", "FORKLIFT", "V1");
        expect(sim.clear("EAST", "V1").outcome.code).toBe("DIRECTION_MISMATCH");
        expect(sim.state.queue.length).toBe(1);
    });

    it("rejects an unknown direction", () => {
        const sim = new Sim().boot();
        const result = sim.send({ type: "VEHICLE_ARRIVED", vehicleId: "X", vehicleType: "TRUCK", direction: "UP" as Direction });
        expect(result.outcome.code).toBe("UNKNOWN_DIRECTION");
        expect(sim.state.queue.length).toBe(0);
    });
});

describe("emergency handling", () => {
    it("starts a safe preemption immediately: YELLOW now, never EAST green while NORTH is not red", () => {
        const sim = new Sim().boot();
        sim.sent.length = 0;
        sim.arrive("NORTH", "TRUCK", "T1");
        sim.arrive("EAST", "EMERGENCY", "AMB1");

        expect(sim.state.mode).toBe("EMERGENCY");
        expect(sim.sent[0]?.command.signals).toMatchObject({ NORTH: "YELLOW", SOUTH: "YELLOW", EAST: "RED", WEST: "RED" });
        sim.run(8);
        expect(sim.greenPhase()).toBe("EAST_WEST");
    });

    it("a repeated emergency event does not create a second emergency", () => {
        const sim = new Sim().boot();
        sim.arrive("EAST", "EMERGENCY", "AMB1");
        sim.arrive("EAST", "EMERGENCY", "AMB1");
        expect(sim.state.emergencies.length).toBe(1);
    });

    it("returns to AUTOMATIC when the emergency vehicle clears", () => {
        const sim = new Sim().boot();
        sim.arrive("EAST", "EMERGENCY", "AMB1");
        sim.run(10);
        sim.clear("EAST", "AMB1");
        expect(sim.state.mode).toBe("AUTOMATIC");
        expect(sim.auditTypes()).toContain("EMERGENCY_CLEARED");
    });

    it("conflicting emergencies are served first-come-first-served, with no flip-flopping", () => {
        const sim = new Sim().boot();
        sim.arrive("EAST", "EMERGENCY", "AMB-E");
        sim.run(10);
        expect(sim.greenPhase()).toBe("EAST_WEST");

        sim.arrive("NORTH", "EMERGENCY", "AMB-N"); // conflicts with the one being served
        sim.run(40);
        expect(sim.greenPhase()).toBe("EAST_WEST"); // still serving the first

        sim.clear("EAST", "AMB-E");
        sim.run(10);
        expect(sim.greenPhase()).toBe("NORTH_SOUTH"); // now the second
    });

    it("a stale emergency that never clears times out and stops holding the junction", () => {
        const sim = new Sim().boot();
        sim.arrive("EAST", "EMERGENCY", "AMB1");
        sim.run(65);
        expect(sim.auditTypes()).toContain("EMERGENCY_TIMED_OUT");
        expect(sim.state.emergencies.length).toBe(0);
        expect(sim.state.queue.length).toBe(0);
        expect(sim.state.mode).toBe("AUTOMATIC");
    });
});

describe("manual control", () => {
    it("takes control through the safe sequence, holds past normal green, and returns on command", () => {
        const sim = new Sim().boot();
        sim.sent.length = 0;
        sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        expect(sim.state.mode).toBe("MANUAL");
        expect(sim.sent[0]?.command.signals.NORTH).toBe("YELLOW"); // not an instant flip
        sim.run(10);
        expect(sim.greenPhase()).toBe("EAST_WEST");

        sim.arrive("NORTH", "TRUCK", "T1");
        sim.run(120); // far beyond the 30 s normal green
        expect(sim.greenPhase()).toBe("EAST_WEST"); // manual holds

        sim.send({ type: "RETURN_TO_AUTOMATIC" });
        expect(sim.state.mode).toBe("AUTOMATIC");
        sim.run(10);
        expect(sim.greenPhase()).toBe("NORTH_SOUTH"); // scheduler serves the waiting truck
    });

    it("manual control expires by itself (covers an administrator who disconnects)", () => {
        const sim = new Sim().boot();
        sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        sim.run(5 * 60 + 1);
        expect(sim.state.mode).toBe("AUTOMATIC");
        expect(sim.auditTypes()).toContain("MANUAL_OVERRIDE_ENDED");
    });

    it("two administrators: commands are serialised and the last accepted one wins", () => {
        const sim = new Sim().boot();
        sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "NORTH" });
        expect(sim.state.manual?.phaseId).toBe("NORTH_SOUTH");
        const started = sim.audit.filter((a) => a.type === "MANUAL_OVERRIDE_STARTED");
        expect(started[1]?.details?.replacedPhaseId).toBe("EAST_WEST");
    });

    it("emergency overrides manual, and manual resumes afterwards", () => {
        const sim = new Sim().boot();
        sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        sim.run(10);
        expect(sim.greenPhase()).toBe("EAST_WEST");

        sim.arrive("NORTH", "EMERGENCY", "AMB1");
        expect(sim.state.mode).toBe("EMERGENCY");
        sim.run(10);
        expect(sim.greenPhase()).toBe("NORTH_SOUTH");

        sim.clear("NORTH", "AMB1");
        expect(sim.state.mode).toBe("MANUAL");
        sim.run(10);
        expect(sim.greenPhase()).toBe("EAST_WEST");
    });

    it("refuses manual control while the controller state is unknown", () => {
        const sim = new Sim();
        sim.autoAck = false;
        const result = sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        expect(result.outcome).toMatchObject({ accepted: false, code: "CONTROLLER_UNAVAILABLE" });
    });
});

describe("controller failures", () => {
    it("retries once with the SAME command id, then declares the controller OFFLINE and stops sending", () => {
        const sim = new Sim();
        sim.autoAck = false;
        sim.send({ type: "TICK" });
        const first = sim.sent[0]!.command;

        sim.run(3.5);
        expect(sim.sent.length).toBe(2);
        expect(sim.sent[1]!.command.commandId).toBe(first.commandId);
        expect(sim.sent[1]!.command.attempt).toBe(2);

        sim.run(3.5);
        expect(sim.state.controllerStatus).toBe("OFFLINE");
        expect(sim.state.mode).toBe("DEGRADED");
        expect(sim.state.actual).toEqual({ NORTH: "UNKNOWN", SOUTH: "UNKNOWN", EAST: "UNKNOWN", WEST: "UNKNOWN" });
        expect(deriveAlerts(sim.state).map((a) => a.code)).toContain("CONTROLLER_OFFLINE");

        const count = sim.sent.length;
        sim.run(60);
        expect(sim.sent.length).toBe(count);
    });

    it("a timed-out command is never assumed to have been executed", () => {
        const sim = new Sim().boot();
        sim.autoAck = false;
        sim.arrive("EAST", "TRUCK", "E1"); // empty green gives way: YELLOW command goes unanswered
        sim.run(8);
        expect(sim.state.desired.NORTH).toBe("YELLOW");
        expect(sim.state.actual.NORTH).toBe("UNKNOWN"); // never "confirmed"
    });

    it("ignores duplicate and unknown acknowledgements", () => {
        const sim = new Sim();
        sim.send({ type: "TICK" });
        const id = sim.sent[0]!.command.commandId;
        const confirmedAt = sim.state.stageConfirmedAt;
        sim.now += 1000;
        const dup = sim.send({ type: "COMMAND_RESULT", commandId: id, status: "ACK" });
        const ghost = sim.send({ type: "COMMAND_RESULT", commandId: "cmd-999", status: "ACK" });
        expect(dup.outcome.code).toBe("ACK_IGNORED");
        expect(ghost.outcome.code).toBe("ACK_IGNORED");
        expect(sim.state.stageConfirmedAt).toBe(confirmedAt);
    });

    it("an ACK that reports a different state than requested triggers a resync, not trust", () => {
        const sim = new Sim().boot();
        sim.autoAck = false;
        sim.arrive("EAST", "TRUCK", "E1");
        const yellow = sim.sent[sim.sent.length - 1]!.command;
        sim.send({ type: "COMMAND_RESULT", commandId: yellow.commandId, status: "ACK", actualSignals: { NORTH: "GREEN", SOUTH: "GREEN", EAST: "RED", WEST: "RED" } });
        expect(sim.state.needsResync).toBe(true);
        expect(sim.state.mode).toBe("DEGRADED");
        sim.autoAck = true;
        sim.run(1);
        expect(sim.sent[sim.sent.length - 1]!.command.kind).toBe("RESYNC");
    });

    it("when the controller reconnects, it is resynced to all-red before the cycle resumes", () => {
        const sim = new Sim().boot();
        sim.send({ type: "DEVICE_STATUS", deviceType: "SIGNAL_CONTROLLER", status: "OFFLINE" });
        expect(sim.state.mode).toBe("DEGRADED");
        const before = sim.sent.length;
        sim.run(10);
        expect(sim.sent.length).toBe(before); // nothing sent to an offline controller

        sim.send({ type: "DEVICE_STATUS", deviceType: "SIGNAL_CONTROLLER", status: "ONLINE" });
        expect(sim.sent[sim.sent.length - 1]!.command.kind).toBe("RESYNC");
        sim.run(10);
        expect(sim.state.mode).toBe("AUTOMATIC");
        expect(sim.greenPhase()).not.toBeNull();
    });

    it("sensor and signal failures are recorded and raised as alerts", () => {
        const sim = new Sim().boot();
        sim.send({ type: "DEVICE_STATUS", deviceType: "SENSOR", direction: "EAST", status: "OFFLINE" });
        expect(deriveAlerts(sim.state).map((a) => a.code)).toContain("SENSOR_FAILURE");
    });
});

describe("restart recovery", () => {
    it("keeps queue and emergencies, abandons the pending command, and resyncs before trusting anything", () => {
        const sim = new Sim().boot();
        sim.autoAck = false;
        sim.arrive("NORTH", "TRUCK", "T1");
        sim.arrive("EAST", "EMERGENCY", "AMB1"); // YELLOW goes out, unconfirmed
        expect(sim.state.pendingCommand).not.toBeNull();

        sim.send({ type: "RESTARTED" });
        expect(sim.auditTypes()).toContain("COMMAND_ABANDONED");
        expect(sim.state.queue.length).toBe(2);
        expect(sim.state.emergencies.length).toBe(1);
        expect(sim.state.actual.NORTH).toBe("UNKNOWN");
        expect(sim.sent[sim.sent.length - 1]!.command.kind).toBe("RESYNC");

        sim.autoAck = true;
        const resync = sim.sent[sim.sent.length - 1]!.command;
        sim.send({ type: "COMMAND_RESULT", commandId: resync.commandId, status: "ACK" });
        sim.run(10);
        expect(sim.greenPhase()).toBe("EAST_WEST"); // the persisted emergency is still honoured
    });
});

describe("concurrent events (the sequence from the brief)", () => {
    it("never produces conflicting greens and counts the duplicate emergency once", () => {
        const sim = new Sim().boot();
        sim.at(100); sim.arrive("NORTH", "TRUCK", "T1");
        sim.at(100.004); sim.arrive("EAST", "EMERGENCY", "AMB1");
        sim.at(100.008); sim.send({ type: "MANUAL_GREEN_REQUEST", direction: "WEST" });
        sim.at(100.012); sim.arrive("EAST", "EMERGENCY", "AMB1"); // duplicate
        sim.at(100.017); sim.send({ type: "TICK" });
        sim.run(15);

        expect(sim.state.emergencies.length).toBe(1);
        expect(sim.state.queue.length).toBe(2);
        expect(sim.greenPhase()).toBe("EAST_WEST");
    });
});

describe("randomised safety property", () => {
    // Small deterministic PRNG so a failure is reproducible.
    function mulberry32(seed: number) {
        return () => {
            seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    for (const seed of [1, 2, 3, 4, 5]) {
        it(`holds every invariant under 3000 random events (seed ${seed})`, () => {
            const rand = mulberry32(seed);
            const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
            const sim = new Sim();
            const vehicles: { id: string; direction: Direction }[] = [];
            const types: VehicleType[] = ["EMPLOYEE_VEHICLE", "FORKLIFT", "TRUCK", "EMERGENCY"];
            let counter = 0;

            for (let i = 0; i < 3000; i++) {
                sim.autoAck = rand() > 0.15; // sometimes the controller stays silent
                const roll = rand();
                if (roll < 0.25) {
                    const direction = pick(DIRECTIONS);
                    const id = `V${counter++}`;
                    vehicles.push({ id, direction });
                    sim.arrive(direction, rand() < 0.06 ? "EMERGENCY" : pick(types.slice(0, 3)), id);
                } else if (roll < 0.4 && vehicles.length > 0) {
                    const v = vehicles.splice(Math.floor(rand() * vehicles.length), 1)[0]!;
                    sim.clear(v.direction, v.id);
                } else if (roll < 0.45) {
                    sim.send({ type: "MANUAL_GREEN_REQUEST", direction: pick(DIRECTIONS) });
                } else if (roll < 0.5) {
                    sim.send({ type: "RETURN_TO_AUTOMATIC" });
                } else if (roll < 0.52) {
                    sim.send({ type: "DEVICE_STATUS", deviceType: "SIGNAL_CONTROLLER", status: pick(["ONLINE", "OFFLINE", "ONLINE"] as const) });
                } else if (roll < 0.53) {
                    sim.send({ type: "RESTARTED" });
                } else if (roll < 0.58 && sim.state.pendingCommand) {
                    sim.send({ type: "COMMAND_RESULT", commandId: sim.state.pendingCommand.commandId, status: "ACK" });
                } else {
                    sim.now += Math.floor(rand() * 4000);
                    sim.send({ type: "TICK" });
                }

                // sim.send already asserts "desired is safe". Also:
                const ids = sim.state.queue.map((v) => v.vehicleId);
                expect(new Set(ids).size).toBe(ids.length); // no double counting
                expect(sim.state.mode).toBeDefined();
            }
        });
    }
});