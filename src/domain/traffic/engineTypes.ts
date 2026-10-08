import type { WaitingVehicle } from "./scheduler";
import type {
    ActualSignalMap,
    DeviceStatus,
    Direction,
    JunctionMode,
    SignalMap,
    Stage,
    VehicleType,
} from "./types";

export type CommandKind = "STEP" | "RESYNC";

/** One atomic instruction to the physical controller: "show exactly this signal map". */
export interface ControllerCommand {
    commandId: string;
    junctionId: string;
    kind: CommandKind;
    signals: SignalMap;
    /** Time of the most recent send (updated on retry). */
    issuedAt: number;
    attempt: number;
}

export interface EmergencyRecord {
    vehicleId: string;
    direction: Direction;
    phaseId: string;
    detectedAt: number;
}

export interface ManualOverride {
    phaseId: string;
    direction: Direction;
    requestedAt: number;
    expiresAt: number;
}

export type DeviceType = "SIGNAL_CONTROLLER" | "SENSOR" | "SIGNAL";

export interface JunctionState {
    junctionId: string;
    mode: JunctionMode;

    /** Where we are in GREEN -> YELLOW -> ALL_RED -> GREEN. Describes what we have COMMANDED. */
    stage: Stage;
    /** Phase that is GREEN (stage GREEN) or being yellowed out (stage YELLOW). */
    activePhaseId: string | null;
    /** Phase we are heading to while transitioning. */
    targetPhaseId: string | null;

    /** What the backend wants. */
    desired: SignalMap;
    /** What the controller has CONFIRMED. UNKNOWN until proven. */
    actual: ActualSignalMap;
    /** When the controller confirmed the current stage. null while unconfirmed. */
    stageConfirmedAt: number | null;

    pendingCommand: ControllerCommand | null;
    commandSeq: number;

    controllerStatus: DeviceStatus;
    /** True while the physical state is unknown and an all-red resync must be confirmed. */
    needsResync: boolean;
    deviceStatuses: Record<string, DeviceStatus>;

    queue: WaitingVehicle[];
    /** In arrival order: the first one is the one being served. */
    emergencies: EmergencyRecord[];
    manual: ManualOverride | null;

    updatedAt: number;
}

export type EngineEvent =
    | { type: "TICK" }
    | { type: "VEHICLE_ARRIVED"; vehicleId: string; vehicleType: VehicleType; direction: Direction }
    | { type: "VEHICLE_CLEARED"; vehicleId: string; direction: Direction }
    | { type: "MANUAL_GREEN_REQUEST"; direction: Direction }
    | { type: "RETURN_TO_AUTOMATIC" }
    | {
          type: "COMMAND_RESULT";
          commandId: string;
          status: "ACK" | "NACK" | "FAILED";
          actualSignals?: SignalMap;
      }
    | { type: "DEVICE_STATUS"; deviceType: DeviceType; direction?: Direction; status: DeviceStatus }
    | { type: "RESTARTED" };

export type AuditType =
    | "VEHICLE_DETECTED"
    | "VEHICLE_CLEARED"
    | "EVENT_REJECTED"
    | "SCHEDULER_DECISION"
    | "SIGNAL_TRANSITION_STARTED"
    | "SIGNAL_STATE_REQUESTED"
    | "SIGNAL_STATE_CONFIRMED"
    | "EMERGENCY_DETECTED"
    | "EMERGENCY_CLEARED"
    | "EMERGENCY_TIMED_OUT"
    | "MANUAL_OVERRIDE_STARTED"
    | "MANUAL_OVERRIDE_ENDED"
    | "COMMAND_REJECTED"
    | "COMMAND_ACK_IGNORED"
    | "COMMAND_TIMEOUT"
    | "COMMAND_FAILED"
    | "COMMAND_RETRY"
    | "COMMAND_ABANDONED"
    | "CONTROLLER_STATUS_CHANGED"
    | "DEVICE_STATUS_CHANGED"
    | "MODE_CHANGED"
    | "SYSTEM_RESTARTED";

export interface AuditEntry {
    type: AuditType;
    at: number;
    direction?: Direction;
    previousState?: string;
    newState?: string;
    commandId?: string;
    details?: Record<string, unknown>;
}

export type EngineEffect =
    | { type: "SEND_COMMAND"; command: ControllerCommand }
    | { type: "AUDIT"; entry: AuditEntry };

/** Tells the API layer how to answer. The engine never knows about HTTP. */
export interface EngineOutcome {
    accepted: boolean;
    code: string;
    message?: string;
}

export interface EngineResult {
    state: JunctionState;
    effects: EngineEffect[];
    outcome: EngineOutcome;
}

export interface Alert {
    code: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    message: string;
    direction?: Direction;
}