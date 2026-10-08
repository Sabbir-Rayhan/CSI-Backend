import type { ControllerCommand } from "../../domain/traffic/engineTypes";
import type { SignalMap } from "../../domain/traffic/types";
import type { ControllerPort, Logger } from "../../application/traffic/ports";

export interface AutoAck {
    junctionId: string;
    commandId: string;
    actualSignals: SignalMap;
}

export interface SimulatorSettings {
    /** true: every command is acknowledged automatically after ackDelayMs. false: it waits for a manual ACK (or times out). */
    autoAck: boolean;
    ackDelayMs: number;
}

export interface SentCommandLog {
    command: ControllerCommand;
    sentAt: number;
}

/**
 * REST-simulated physical controller. Implements ControllerPort, so an MQTT adapter can
 * replace or sit next to it without touching the application layer or the domain engine.
 */
export class SimulatorController implements ControllerPort {
    private settings: SimulatorSettings;
    private readonly sent: SentCommandLog[] = [];
    private ackHandler: ((ack: AutoAck) => Promise<unknown>) | null = null;

    constructor(settings: SimulatorSettings, private readonly log: Logger) {
        this.settings = { ...settings };
    }

    onAutoAck(handler: (ack: AutoAck) => Promise<unknown>): void {
        this.ackHandler = handler;
    }

    getSettings(): SimulatorSettings {
        return { ...this.settings };
    }

    configure(patch: Partial<SimulatorSettings>): SimulatorSettings {
        this.settings = { ...this.settings, ...patch };
        return this.getSettings();
    }

    recentCommands(limit = 30): SentCommandLog[] {
        return this.sent.slice(-limit).reverse();
    }

    async send(command: ControllerCommand): Promise<void> {
        this.sent.push({ command, sentAt: Date.now() });
        if (this.sent.length > 200) this.sent.shift();

        if (!this.settings.autoAck || !this.ackHandler) return;
        const handler = this.ackHandler;
        const timer = setTimeout(() => {
            handler({
                junctionId: command.junctionId,
                commandId: command.commandId,
                actualSignals: command.signals,
            }).catch((error) => this.log.error(`auto-ack failed for ${command.commandId}`, error));
        }, this.settings.ackDelayMs);
        timer.unref?.();
    }
}