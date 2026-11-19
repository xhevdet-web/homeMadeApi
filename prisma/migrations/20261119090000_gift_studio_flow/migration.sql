-- Gift Studio: what fits in a packaging, its suggested bundles, and the gift card note.
-- Every column is optional or defaulted, so existing packaging and designs stay valid.
ALTER TABLE "gift_packaging"
  ADD COLUMN "capacity" INTEGER,
  ADD COLUMN "allowed_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "suggested_bundles" JSONB;

ALTER TABLE "gift_packaging"
  ADD CONSTRAINT "gift_packaging_capacity_check" CHECK ("capacity" IS NULL OR "capacity" >= 1);

ALTER TABLE "products"
  ADD COLUMN "gift_recipient" TEXT,
  ADD COLUMN "gift_message" TEXT;
