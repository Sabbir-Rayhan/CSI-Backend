import type { Request, Response } from "express";
import status from "http-status";
import AppError from "../../app/errorHelpers/appError";
import { catchAsync } from "../../app/shared/catchAsync";
import { sendResponse } from "../../app/shared/sendResponse";
import {
    InvalidJunctionConfigError,
    JunctionAlreadyExistsError,
    JunctionNotFoundError,
} from "../../application/traffic/errors";
import type { ServiceResult, TrafficService } from "../../application/traffic/trafficService";
import type { SimulatorController } from "../../infrastructure/controller/simulatorController";
import type { StoredAuditEntry } from "../../application/traffic/ports";
import {
    commandSchema,
    controllerAckSchema,
    createJunctionSchema,
    deviceStatusSchema,
    historyQuerySchema,
    sensorEventSchema,
    simulatorSettingsSchema,
} from "./trafficSchemas";

/** Domain outcome code -> HTTP status. The engine never knows about HTTP; this table does. */
function httpStatusFor(result: ServiceResult, kind: "event" | "command"): number {
    if (result.duplicate) return status.OK;
    switch (result.code) {
        case "OK":
            return kind === "command" ? status.ACCEPTED : status.CREATED;
        case "ACCEPTED_SUSPENDED_BY_EMERGENCY":
            return status.ACCEPTED;
        case "ALREADY_AUTOMATIC":
        case "UNCHANGED":
        case "ACK_IGNORED":
        case "DUPLICATE_IGNORED":
            return status.OK;
        case "UNKNOWN_VEHICLE": // cleared-before-arrival: recorded so a late arrival can be recognised as stale
        case "STALE_OUT_OF_ORDER":
        case "STALE_EVENT":
            return status.ACCEPTED;
        case "DIRECTION_MISMATCH":
            return status.CONFLICT;
        case "CONTROLLER_UNAVAILABLE":
            return status.SERVICE_UNAVAILABLE;
        default:
            return result.accepted ? status.OK : status.UNPROCESSABLE_ENTITY;
    }
}

/** Application errors -> AppError (carries the HTTP status). */
function translate(error: unknown): never {
    if (error instanceof JunctionNotFoundError) throw new AppError(status.NOT_FOUND, error.message);
    if (error instanceof JunctionAlreadyExistsError) throw new AppError(status.CONFLICT, error.message);
    if (error instanceof InvalidJunctionConfigError) throw new AppError(status.BAD_REQUEST, error.message);
    throw error;
}

const iso = (ms: number) => new Date(ms).toISOString();

function historyDto(entry: StoredAuditEntry) {
    return {
        id: entry.id,
        junction_id: entry.junctionId,
        event_type: entry.type,
        direction: entry.direction ?? null,
        previous_state: entry.previousState ?? null,
        new_state: entry.newState ?? null,
        command_id: entry.commandId ?? null,
        details: entry.details ?? null,
        timestamp: iso(entry.at),
    };
}

function resultDto(r: ServiceResult) {
    return {
        accepted: r.accepted,
        code: r.code,
        message: r.message,
        duplicate: r.duplicate ?? false,
        junction_id: r.junctionId,
        event_id: r.eventId,
        mode: r.mode,
        queues: r.queues,
    };
}

export function createTrafficController(service: TrafficService, simulator: SimulatorController) {
    const param = (req: Request, name: string): string => String(req.params[name]);

    return {
        listJunctions: catchAsync(async (_req, res) => {
            const data = await service.listStatuses();
            sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Junctions retrieved", data });
        }),

        getJunction: catchAsync(async (req, res) => {
            const data = await service.getStatus(param(req, "id")).catch(translate);
            sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Junction retrieved", data });
        }),

        createJunction: catchAsync(async (req, res) => {
            const body = createJunctionSchema.parse(req.body);
            const data = await service.createJunction(body).catch(translate);
            sendResponse(res, { httpStatusCode: status.CREATED, success: true, message: "Junction created", data });
        }),

        getStatus: catchAsync(async (req, res) => {
            const data = await service.getStatus(param(req, "id")).catch(translate);
            sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Junction status", data });
        }),

        getHistory: catchAsync(async (req, res) => {
            const query = historyQuerySchema.parse(req.query);
            const rows = await service
                .getHistory(param(req, "id"), { limit: query.limit, beforeId: query.before, type: query.type })
                .catch(translate);
            const data = {
                entries: rows.map(historyDto),
                next_before: rows.length === query.limit ? rows[rows.length - 1]?.id ?? null : null,
            };
            sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Junction history", data });
        }),

        postCommand: catchAsync(async (req, res) => {
            const body = commandSchema.parse(req.body);
            const result = await service.submitCommand(param(req, "id"), body).catch(translate);
            sendResponse(res, {
                httpStatusCode: httpStatusFor(result, "command"),
                success: result.accepted,
                message: result.message ?? result.code,
                data: resultDto(result),
            });
        }),

        postSensorEvent: catchAsync(async (req, res) => {
            const parsed = sensorEventSchema.safeParse(req.body);
            if (!parsed.success) {
                // Invalid events are rejected with 400 AND leave an audit trail if the junction is known.
                await service.recordInvalidPayload(req.body?.junction_id, parsed.error.issues, req.body?.event_id);
                throw parsed.error;
            }
            const b = parsed.data;
            const result = await service
                .ingestSensorEvent({
                    eventId: b.event_id,
                    junctionId: b.junction_id,
                    direction: b.direction,
                    eventType: b.event_type,
                    vehicleId: b.vehicle_id,
                    vehicleType: b.vehicle_type,
                    sequenceNo: b.sequence_no,
                    timestamp: Date.parse(b.timestamp),
                })
                .catch(translate);
            sendResponse(res, {
                httpStatusCode: httpStatusFor(result, "event"),
                success: result.accepted,
                message: result.code,
                data: resultDto(result),
            });
        }),

        /** Controller -> backend: command ACKs (has command_id) and device status events (has device_type). */
        postControllerEvent: catchAsync(async (req, res) => {
            const isAck = typeof req.body === "object" && req.body !== null && "command_id" in req.body;

            if (isAck) {
                const b = controllerAckSchema.parse(req.body);
                const result = await service
                    .handleControllerAck({
                        junctionId: b.junction_id,
                        commandId: b.command_id,
                        status: b.status,
                        actualSignals: b.actual_signals,
                        actualState: b.actual_state,
                    })
                    .catch(translate);
                return sendResponse(res, {
                    httpStatusCode: status.OK,
                    success: result.accepted,
                    message: result.code,
                    data: resultDto(result),
                });
            }

            const parsed = deviceStatusSchema.safeParse(req.body);
            if (!parsed.success) {
                await service.recordInvalidPayload(req.body?.junction_id, parsed.error.issues, req.body?.event_id);
                throw parsed.error;
            }
            const b = parsed.data;
            const result = await service
                .ingestDeviceStatus({
                    eventId: b.event_id,
                    junctionId: b.junction_id,
                    deviceType: b.device_type,
                    direction: b.direction,
                    status: b.status,
                    timestamp: Date.parse(b.timestamp),
                })
                .catch(translate);
            sendResponse(res, {
                httpStatusCode: httpStatusFor(result, "event") === status.CREATED ? status.OK : httpStatusFor(result, "event"),
                success: result.accepted,
                message: result.code,
                data: resultDto(result),
            });
        }),

        getSimulator: catchAsync(async (_req: Request, res: Response) => {
            sendResponse(res, {
                httpStatusCode: status.OK,
                success: true,
                message: "Controller simulator",
                data: {
                    settings: simulator.getSettings(),
                    recent_commands: simulator.recentCommands().map((entry) => ({
                        command_id: entry.command.commandId,
                        junction_id: entry.command.junctionId,
                        kind: entry.command.kind,
                        attempt: entry.command.attempt,
                        requested_signals: entry.command.signals,
                        sent_at: iso(entry.sentAt),
                    })),
                },
            });
        }),

        putSimulator: catchAsync(async (req, res) => {
            const body = simulatorSettingsSchema.parse(req.body);
            const settings = simulator.configure(body);
            sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Simulator updated", data: { settings } });
        }),
    };
}