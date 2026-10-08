import "dotenv/config";
import type { Server } from "node:http";
import { createApp } from "./app";
import { envVars } from "./config/env";
import { prisma } from "./app/lib/prisma";
import { consoleLogger, systemClock } from "./application/traffic/ports";
import { TrafficService } from "./application/traffic/trafficService";
import { TickScheduler } from "./application/traffic/tickScheduler";
import { SimulatorController } from "./infrastructure/controller/simulatorController";
import { PrismaTrafficRepository } from "./infrastructure/persistence/prismaTrafficRepository";

async function bootstrap(): Promise<void> {
    if (!envVars.DATABASE_URL) {
        throw new Error("DATABASE_URL is required (see .env.example)");
    }

    // ---- composition root: the only place concrete adapters are chosen ----
    const repository = new PrismaTrafficRepository(prisma);
    const simulator = new SimulatorController(
        { autoAck: envVars.SIM_AUTO_ACK, ackDelayMs: envVars.SIM_ACK_DELAY_MS },
        consoleLogger
    );
    const service = new TrafficService(
        repository,
        simulator,
        systemClock,
        { staleEventMaxAgeMs: envVars.STALE_EVENT_MAX_AGE_MS },
        consoleLogger
    );
    simulator.onAutoAck((ack) =>
        service.handleControllerAck({
            junctionId: ack.junctionId,
            commandId: ack.commandId,
            status: "ACK",
            actualSignals: ack.actualSignals,
        })
    );

    // ---- recovery: persisted state is kept, physical signal state is NOT trusted ----
    await service.recoverAll();

    if (envVars.SEED_JUNCTION_A && !(await repository.getJunction("A"))) {
        await service.createJunction({ id: "A", name: "Junction A" });
    }

    const ticker = new TickScheduler(service, envVars.TICK_INTERVAL_MS, consoleLogger);
    ticker.start();

    const app = createApp(service, simulator);
    const server: Server = app.listen(envVars.PORT, () => {
        console.log(`Traffic backend running on http://localhost:${envVars.PORT}`);
    });

    const shutdown = (signal: string) => {
        console.log(`${signal} received, shutting down`);
        ticker.stop();
        server.close(() => {
            prisma.$disconnect().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
});