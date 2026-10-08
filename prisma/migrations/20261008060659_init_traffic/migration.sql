-- CreateTable
CREATE TABLE "junctions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "junctions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "junctionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vehicleId" TEXT,
    "direction" TEXT,
    "sequenceNo" INTEGER,
    "sensorTimestamp" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("junctionId","eventId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "junctionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "direction" TEXT,
    "previousState" TEXT,
    "newState" TEXT,
    "commandId" TEXT,
    "details" JSONB,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_events_junctionId_vehicleId_kind_idx" ON "processed_events"("junctionId", "vehicleId", "kind");

-- CreateIndex
CREATE INDEX "audit_logs_junctionId_id_idx" ON "audit_logs"("junctionId", "id");

-- CreateIndex
CREATE INDEX "audit_logs_junctionId_type_idx" ON "audit_logs"("junctionId", "type");

-- AddForeignKey
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_junctionId_fkey" FOREIGN KEY ("junctionId") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_junctionId_fkey" FOREIGN KEY ("junctionId") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
