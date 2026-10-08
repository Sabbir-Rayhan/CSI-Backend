import express, { Application, NextFunction, Request, Response } from "express";
import path from "node:path";
import status from "http-status";
import type { TrafficService } from "./application/traffic/trafficService";
import type { SimulatorController } from "./infrastructure/controller/simulatorController";
import { createTrafficRouter } from "./interface/http/trafficRoutes";
import { globalErrorHandler } from "./app/middleware.ts/globalErrorHandler";
import { notFound } from "./app/middleware.ts/notFound";

export function createApp(service: TrafficService, simulator: SimulatorController): Application {
    const app: Application = express();

    app.use(express.json({ limit: "100kb" }));

    // Malformed JSON -> 400 instead of a generic 500.
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (err instanceof SyntaxError && "body" in err) {
            return res.status(status.BAD_REQUEST).json({ success: false, message: "Malformed JSON body", errorSources: [] });
        }
        next(err);
    });

    app.get("/health", (_req, res) => {
        res.json({ success: true, message: "ok" });
    });

    app.use("/api", createTrafficRouter(service, simulator));

    // Dashboard (plain HTML/JS, no build step). Same origin as the API, so no CORS needed.
    app.use(express.static(path.resolve(process.cwd(), "public")));

    app.use("/api", notFound);
    app.use(globalErrorHandler);
    return app;
}