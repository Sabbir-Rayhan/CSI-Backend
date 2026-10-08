export const DIRECTIONS = ["NORTH", "SOUTH", "EAST", "WEST"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const SIGNAL_STATES = ["RED", "YELLOW", "GREEN"] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

/** The signal every direction should show. Used for BOTH desired state and the
 *  state the backend wants to send to the controller. */
export type SignalMap = Record<Direction, SignalState>;

/** What the physical controller has actually confirmed.
 *  UNKNOWN = never confirmed, or the controller went offline. */
export type ActualSignalState = SignalState | "UNKNOWN";
export type ActualSignalMap = Record<Direction, ActualSignalState>;

export const VEHICLE_TYPES = ["EMERGENCY", "TRUCK", "FORKLIFT", "EMPLOYEE_VEHICLE"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** EMERGENCY > TRUCK > FORKLIFT > EMPLOYEE_VEHICLE (as required by the brief). */
export const DEFAULT_VEHICLE_PRIORITY: Record<VehicleType, number> = {
    EMERGENCY: 4,
    TRUCK: 3,
    FORKLIFT: 2,
    EMPLOYEE_VEHICLE: 1,
};

export const JUNCTION_MODES = ["AUTOMATIC", "MANUAL", "EMERGENCY", "DEGRADED"] as const;
export type JunctionMode = (typeof JUNCTION_MODES)[number];

/** Position inside the safe switching sequence:
 *  GREEN -> YELLOW -> ALL_RED -> (next phase) GREEN */
export const STAGES = ["GREEN", "YELLOW", "ALL_RED"] as const;
export type Stage = (typeof STAGES)[number];

export const DEVICE_STATUSES = ["ONLINE", "OFFLINE", "DEGRADED", "WARNING", "UNKNOWN"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];