-- Phone case models are COMPANY products of a CASE category: grouped by device brand,
-- ordered by sort order, with an optional overlay drawn above the customer's artwork.
ALTER TABLE "products" ADD COLUMN "device_brand" TEXT;
ALTER TABLE "products" ADD COLUMN "overlay_image_key" TEXT;
ALTER TABLE "products" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
