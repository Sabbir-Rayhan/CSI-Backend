import dotenv from "dotenv";

dotenv.config();

function readNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Environment variable ${name} must be a non-negative number (got "${raw}")`);
    }
    return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const envVars = {
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: readNumber("PORT", 5000),
    DATABASE_URL: process.env.DATABASE_URL ?? "",

    /** How often the ticker advances every junction's state machine. */
    TICK_INTERVAL_MS: readNumber("TICK_INTERVAL_MS", 500),

    /** REST controller simulator: acknowledge commands automatically? */
    SIM_AUTO_ACK: readBoolean("SIM_AUTO_ACK", true),
    SIM_ACK_DELAY_MS: readNumber("SIM_ACK_DELAY_MS", 300),

    /** Reject VEHICLE_ARRIVED events whose sensor timestamp is older than this. 0 = disabled. */
    STALE_EVENT_MAX_AGE_MS: readNumber("STALE_EVENT_MAX_AGE_MS", 0),

    /** Create Junction A on first start if it does not exist. */
    SEED_JUNCTION_A: readBoolean("SEED_JUNCTION_A", true),
};