-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "SalesforceConnection" (
    "shop" TEXT NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "authMode" TEXT NOT NULL DEFAULT 'client_credentials',
    "clientIdEnc" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "lastErrorClass" TEXT,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesforceConnection_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "PipelineSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "weightedQty" DOUBLE PRECISION NOT NULL,
    "rawQty" DOUBLE PRECISION NOT NULL,
    "openDealCount" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "openDealCount" INTEGER NOT NULL,
    "rawQty" DOUBLE PRECISION NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnmatchedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageProbabilityOverride" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "StageProbabilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineSetting" (
    "shop" TEXT NOT NULL,
    "haircut" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "shipOffsetDays" INTEGER NOT NULL DEFAULT 7,
    "horizonDays" INTEGER NOT NULL DEFAULT 90,

    CONSTRAINT "PipelineSetting_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineSnapshot_shop_idx" ON "PipelineSnapshot"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineSnapshot_shop_sku_weekStart_key" ON "PipelineSnapshot"("shop", "sku", "weekStart");

-- CreateIndex
CREATE INDEX "UnmatchedProduct_shop_idx" ON "UnmatchedProduct"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedProduct_shop_productCode_key" ON "UnmatchedProduct"("shop", "productCode");

-- CreateIndex
CREATE UNIQUE INDEX "StageProbabilityOverride_shop_stageName_key" ON "StageProbabilityOverride"("shop", "stageName");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

