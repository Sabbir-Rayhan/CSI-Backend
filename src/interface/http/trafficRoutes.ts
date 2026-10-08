import { Router } from "express";
import type { TrafficService } from "../../application/traffic/trafficService";
import type { SimulatorController } from "../../infrastructure/controller/simulatorController";
import { createTrafficController } from "./trafficController";

export function createTrafficRouter(service: TrafficService, simulator: SimulatorController): Router {
    const router = Router();
    const c = createTrafficController(service, simulator);

    router.get("/junctions", c.listJunctions);
    router.post("/junctions", c.createJunction);
    router.get("/junctions/:id", c.getJunction);
    router.get("/junctions/:id/status", c.getStatus);
    router.get("/junctions/:id/history", c.getHistory);
    router.post("/junctions/:id/commands", c.postCommand);

    router.post("/sensor-events", c.postSensorEvent);
    router.post("/controller-events", c.postControllerEvent);

    router.get("/simulator/controller", c.getSimulator);
    router.put("/simulator/controller", c.putSimulator);

    return router;
}