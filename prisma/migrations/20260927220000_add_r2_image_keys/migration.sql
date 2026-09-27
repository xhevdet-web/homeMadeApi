-- Additive migration: preserve all existing image URLs and rows.
ALTER TABLE "categories" ADD COLUMN "image_key" TEXT;
ALTER TABLE "sub_categories" ADD COLUMN "image_key" TEXT;
ALTER TABLE "products" ADD COLUMN "image_key" TEXT;
