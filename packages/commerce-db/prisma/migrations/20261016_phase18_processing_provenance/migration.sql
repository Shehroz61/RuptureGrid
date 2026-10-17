-- Target-owned configuration provenance. Existing attempts remain unknown;
-- no historical effective processing mode is inferred or backfilled.
ALTER TABLE "commerce_settings"
  ADD COLUMN "processingRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "targetInstanceId" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "commerce_settings"
  ADD CONSTRAINT "commerce_settings_processingRevision_nonnegative"
  CHECK ("processingRevision" >= 0);

ALTER TABLE "processing_attempts"
  ADD COLUMN "processingModeUsed" "CommerceProcessingMode",
  ADD COLUMN "processingRevisionUsed" BIGINT,
  ADD COLUMN "targetInstanceIdUsed" UUID;
ALTER TABLE "processing_attempts"
  ADD CONSTRAINT "processing_attempts_configuration_tuple"
  CHECK (("processingModeUsed" IS NULL AND "processingRevisionUsed" IS NULL AND "targetInstanceIdUsed" IS NULL)
    OR ("processingModeUsed" IS NOT NULL AND "processingRevisionUsed" IS NOT NULL AND "processingRevisionUsed" >= 0 AND "targetInstanceIdUsed" IS NOT NULL));
