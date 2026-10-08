import z from "zod";
import { DEVICE_STATUSES, DIRECTIONS, SIGNAL_STATES, VEHICLE_TYPES } from "../../domain/traffic/types";

const direction = z.enum(DIRECTIONS);
const id = (max = 128) => z.string().trim().min(1).max(max);

export const sensorEventSchema = z
    .object({
        event_id: id(),
        junction_id: id(64),
        direction,
        event_type: z.enum(["VEHICLE_ARRIVED", "VEHICLE_CLEARED"]),
        vehicle_id: id(),
        vehicle_type: z.enum(VEHICLE_TYPES).optional(),
        sequence_no: z.number().int().nonnegative(),
        timestamp: z.iso.datetime({ offset: true }),
    })
    .superRefine((value, ctx) => {
        if (value.event_type === "VEHICLE_ARRIVED" && !value.vehicle_type) {
            ctx.addIssue({ code: "custom", path: ["vehicle_type"], message: "vehicle_type is required for VEHICLE_ARRIVED" });
        }
    });

const signalMap = z.object({
    NORTH: z.enum(SIGNAL_STATES),
    SOUTH: z.enum(SIGNAL_STATES),
    EAST: z.enum(SIGNAL_STATES),
    WEST: z.enum(SIGNAL_STATES),
});

export const controllerAckSchema = z.object({
    command_id: id(),
    junction_id: id(64),
    status: z.enum(["ACK", "NACK", "FAILED"]),
    /** Full per-direction state reported by the controller (recommended). */
    actual_signals: signalMap.optional(),
    /** Single-value form from the assignment example. Accepted, cross-checked against the pending command. */
    actual_state: z.enum(SIGNAL_STATES).optional(),
    timestamp: z.iso.datetime({ offset: true }).optional(),
});

export const deviceStatusSchema = z.object({
    event_id: id(),
    junction_id: id(64),
    device_type: z.enum(["SIGNAL_CONTROLLER", "SENSOR", "SIGNAL"]),
    direction: direction.optional(),
    status: z.enum(DEVICE_STATUSES),
    timestamp: z.iso.datetime({ offset: true }),
});

export const commandSchema = z.discriminatedUnion("command", [
    z.object({ command: z.literal("MANUAL_GREEN_REQUEST"), direction }),
    z.object({ command: z.literal("RETURN_TO_AUTOMATIC") }),
]);

export const createJunctionSchema = z.object({
    id: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, _ and -"),
    name: z.string().trim().min(1).max(100).optional(),
    timing: z
        .object({
            greenMs: z.number().positive().optional(),
            minGreenMs: z.number().positive().optional(),
            yellowMs: z.number().positive().optional(),
            allRedMs: z.number().positive().optional(),
            ackTimeoutMs: z.number().positive().optional(),
            maxWaitMs: z.number().positive().optional(),
            manualTimeoutMs: z.number().positive().optional(),
            emergencyTimeoutMs: z.number().positive().optional(),
        })
        .optional(),
    phases: z
        .array(z.object({ id: id(64), directions: z.array(direction).min(1) }))
        .min(2)
        .optional(),
});

export const historyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    before: z.coerce.number().int().positive().optional(),
    type: z.string().trim().min(1).max(64).optional(),
});

export const simulatorSettingsSchema = z.object({
    autoAck: z.boolean().optional(),
    ackDelayMs: z.number().int().min(0).max(60_000).optional(),
});