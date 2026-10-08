import { createFourWayJunctionConfig } from "../../../domain/traffic/junctionConfig";
import { findSignalViolations, findTransitionViolations, allRedSignals } from "../../../domain/traffic/safety";
import type { ControllerCommand } from "../../../domain/traffic/engineTypes";
import type { SignalMap } from "../../../domain/traffic/types";
import { InMemoryTrafficRepository } from "../../../infrastructure/persistence/inMemoryTrafficRepository";
import type { Clock, ControllerPort, Logger } from "../ports";
import { TrafficService } from "../trafficService";

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export class FakeClock implements Clock {
    constructor(public t = 1_000_000) {}
    now() {
        return this.t;
    }
    advance(ms: number) {
        this.t += ms;
    }
}

export class RecordingController implements ControllerPort {
    readonly sent: ControllerCommand[] = [];
    async send(command: ControllerCommand) {
        this.sent.push(structuredClone(command));
    }
}

export function makeHarness(repo = new InMemoryTrafficRepository(), clock = new FakeClock()) {
    const controller = new RecordingController();
    const service = new TrafficService(repo, controller, clock, { staleEventMaxAgeMs: 0 }, silentLogger);
    return { repo, clock, controller, service };
}

export const config = createFourWayJunctionConfig("A");

/** Let fire-and-forget command dispatch settle. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Acknowledge the newest unacknowledged command exactly as a healthy controller would. */
export async function ackPending(h: ReturnType<typeof makeHarness>): Promise<boolean> {
    await flush();
    const status = await h.service.getStatus("A");
    const pending = status.pending_command;
    if (!pending) return false;
    await h.service.handleControllerAck({
        junctionId: "A",
        commandId: pending.command_id,
        status: "ACK",
        actualSignals: pending.requested_signals,
    });
    await flush();
    return true;
}

/** Runs the ticker + healthy controller forward in time. Returns every command sent. */
export async function runFor(h: ReturnType<typeof makeHarness>, totalMs: number, stepMs = 250) {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
        h.clock.advance(stepMs);
        await h.service.tick("A");
        await ackPending(h);
    }
}

/** Every command sent must be a safe signal map, and every consecutive pair a safe transition. */
export function assertAllCommandsSafe(commands: ControllerCommand[]) {
    let previous: SignalMap = allRedSignals();
    for (const command of commands) {
        const violations = findSignalViolations(config, command.signals);
        if (violations.length) throw new Error(`unsafe map in ${command.commandId}: ${violations.join("; ")}`);
        if (command.kind === "STEP" && command.attempt === 1) {
            const t = findTransitionViolations(config, previous, command.signals);
            if (t.length) throw new Error(`unsafe transition at ${command.commandId}: ${t.join("; ")}`);
        }
        if (command.attempt === 1) previous = command.signals;
    }
}

export function sensor(
    n: number,
    over: Partial<{
        eventId: string;
        direction: "NORTH" | "SOUTH" | "EAST" | "WEST";
        eventType: "VEHICLE_ARRIVED" | "VEHICLE_CLEARED";
        vehicleId: string;
        vehicleType: "EMERGENCY" | "TRUCK" | "FORKLIFT" | "EMPLOYEE_VEHICLE";
        sequenceNo: number;
    }> = {}
) {
    return {
        eventId: over.eventId ?? `evt-${n}`,
        junctionId: "A",
        direction: over.direction ?? "NORTH",
        eventType: over.eventType ?? "VEHICLE_ARRIVED",
        vehicleId: over.vehicleId ?? `VH-${n}`,
        vehicleType: over.vehicleType ?? "TRUCK",
        sequenceNo: over.sequenceNo ?? n,
        timestamp: 1_000_000,
    } as const;
}