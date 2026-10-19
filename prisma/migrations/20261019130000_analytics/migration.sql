-- CreateTable
CREATE TABLE "AnalyticsHit" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "visitor" TEXT NOT NULL,
    "referrer" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "device" TEXT,
    "bot" BOOLEAN NOT NULL DEFAULT false,
    "pageview" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AnalyticsHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AnalyticsHit_ts_idx" ON "AnalyticsHit"("ts");

-- CreateIndex
CREATE INDEX "AnalyticsHit_host_ts_idx" ON "AnalyticsHit"("host", "ts");

