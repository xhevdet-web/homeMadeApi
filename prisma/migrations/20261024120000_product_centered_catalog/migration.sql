-- Product-centred catalog.
--
-- Product becomes the central entity: COMPANY products are the admin catalog, CUSTOMER
-- products are Creative Studio designs. Apparel no longer has its own Garment /
-- GarmentVariant domain: one COMPANY Product is one colour with stock per size, and a
-- customer design references it through base_product_id.
--
-- Order: (1) rename product type to origin in place, (2) add the new columns,
-- (3) migrate garments and the designs printed on them, (4) verify, (5) drop the
-- obsolete structures. Everything runs in the migration's single transaction.

-- 1. ProductType → ProductOrigin, keeping every row's value.
ALTER TYPE "ProductType" RENAME TO "ProductOrigin";
ALTER TYPE "ProductOrigin" RENAME VALUE 'READY_MADE' TO 'COMPANY';
ALTER TYPE "ProductOrigin" RENAME VALUE 'CUSTOM_DESIGN' TO 'CUSTOMER';
ALTER TABLE "products" RENAME COLUMN "product_type" TO "origin";
ALTER TABLE "products" ALTER COLUMN "origin" SET DEFAULT 'CUSTOMER';
ALTER TABLE "products" DROP CONSTRAINT "products_ready_made_price_nonnegative";
ALTER TABLE "products"
ADD CONSTRAINT "products_company_price_nonnegative" CHECK ("origin" <> 'COMPANY' OR "price" >= 0);

-- 2. New product columns. All nullable, so jewelry, bouquet and gift products are unaffected.
ALTER TABLE "products"
ADD COLUMN "base_product_id" TEXT,
ADD COLUMN "back_image_key" TEXT,
ADD COLUMN "color" TEXT,
ADD COLUMN "color_hex" TEXT,
ADD COLUMN "print_areas" JSONB,
ADD COLUMN "sizes" JSONB;

ALTER TABLE "products"
ADD CONSTRAINT "products_base_product_not_self" CHECK ("base_product_id" IS NULL OR "base_product_id" <> "id"),
ADD CONSTRAINT "products_sizes_array" CHECK ("sizes" IS NULL OR jsonb_typeof("sizes") = 'array');

-- 3a. One COMPANY product per garment × colour. A garment sold in one colour keeps its
-- name, and a multi-colour garment becomes "<name> – <colour>" per colour. Only active
-- variants become sizes. Variant prices were all equal per colour, and the highest is kept
-- so no size is undersold.
CREATE TEMP TABLE "garment_colour_products" AS
SELECT
  gen_random_uuid()::text AS "product_id",
  g."id" AS "garment_id",
  v."color_value",
  MIN(v."color_name") AS "color_name",
  COUNT(*) OVER (PARTITION BY g."id") AS "colour_count"
FROM "garments" g
JOIN "garment_variants" v ON v."garment_id" = g."id"
GROUP BY g."id", v."color_value";

-- Checks are plain SQL (some runners split scripts on semicolons, which breaks DO
-- blocks): a failed check casts its message to INTEGER, aborting with that message.
SELECT CAST('Migrating garments needs an ADMIN user to own the new COMPANY products: ' || m."garment_id" AS INTEGER)
FROM "garment_colour_products" m
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "role" = 'ADMIN')
LIMIT 1;

INSERT INTO "products" (
  "id", "origin", "category_id", "created_by_id", "name", "description",
  "image_key", "back_image_key", "color", "color_hex", "print_areas", "sizes",
  "stock", "price", "base_price", "item_count", "is_active", "created_at", "updated_at"
)
SELECT
  m."product_id",
  'COMPANY',
  g."category_id",
  (SELECT "id" FROM "users" WHERE "role" = 'ADMIN' ORDER BY "created_at", "id" LIMIT 1),
  CASE WHEN m."colour_count" > 1 THEN g."name" || ' – ' || m."color_name" ELSE g."name" END,
  g."description",
  -- The front mockup is the studio canvas, falling back to the product photo.
  COALESCE(g."front_image_key", g."image_key"),
  g."back_image_key",
  m."color_name",
  m."color_value",
  NULLIF(jsonb_strip_nulls(jsonb_build_object('front', g."front_print_area", 'back', g."back_print_area")), '{}'::jsonb),
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('size', v."size", 'stock', v."stock") ORDER BY v."sort_order", v."size")
    FROM "garment_variants" v
    WHERE v."garment_id" = g."id" AND v."color_value" = m."color_value" AND v."is_active"
  ), '[]'::jsonb),
  0,
  (SELECT MAX(COALESCE(v."price", g."base_price")) FROM "garment_variants" v
   WHERE v."garment_id" = g."id" AND v."color_value" = m."color_value"),
  0,
  0,
  g."is_active" AND EXISTS (
    SELECT 1 FROM "garment_variants" v
    WHERE v."garment_id" = g."id" AND v."color_value" = m."color_value" AND v."is_active"
  ),
  g."created_at",
  NOW()
FROM "garment_colour_products" m
JOIN "garments" g ON g."id" = m."garment_id";

-- 3b. Designs printed on a garment variant now reference the colour's COMPANY product
-- and keep the chosen size as their size snapshot.
UPDATE "products" p
SET "base_product_id" = m."product_id",
    "selected_size" = jsonb_build_object('id', v."size", 'name', v."size")
FROM "garment_variants" v
JOIN "garment_colour_products" m
  ON m."garment_id" = v."garment_id" AND m."color_value" = v."color_value"
WHERE p."garment_variant_id" = v."id";

-- 3c. The garment silhouette (app-drawn fallback) is a category-wide studio setting.
UPDATE "categories" c
SET "builder_config" = COALESCE(c."builder_config", '{}'::jsonb) || jsonb_build_object('silhouette', g."silhouette")
FROM (
  SELECT DISTINCT ON ("category_id") "category_id", "silhouette"
  FROM "garments"
  WHERE "silhouette" IS NOT NULL
  ORDER BY "category_id", "sort_order", "created_at"
) g
WHERE c."id" = g."category_id"
  AND (c."builder_config" IS NULL OR NOT c."builder_config" ? 'silhouette');

-- 4. Verify before anything is dropped.
SELECT CAST('A design printed on a garment was not linked to a base product: ' || "id" AS INTEGER)
FROM "products"
WHERE "garment_variant_id" IS NOT NULL AND "base_product_id" IS NULL
LIMIT 1;

SELECT CAST('Garment sizes were not all migrated: expected ' || e."count" || ', migrated ' || m."count" AS INTEGER)
FROM (SELECT COUNT(*) AS "count" FROM "garment_variants" WHERE "is_active") e,
     (SELECT COALESCE(SUM(jsonb_array_length("sizes")), 0) AS "count" FROM "products"
      WHERE "id" IN (SELECT "product_id" FROM "garment_colour_products")) m
WHERE e."count" <> m."count";

SELECT CAST('Garment colour was not migrated to a COMPANY product: ' || m."garment_id" || ' ' || m."color_value" AS INTEGER)
FROM "garment_colour_products" m
WHERE NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = m."product_id")
LIMIT 1;

-- 5. Drop the obsolete structures.
DROP TABLE "garment_colour_products";
-- Garments and variants: replaced by COMPANY products with per-size stock.
ALTER TABLE "products" DROP CONSTRAINT "products_garment_variant_id_fkey";
DROP INDEX "products_garment_variant_id_idx";
ALTER TABLE "products" DROP COLUMN "garment_variant_id";
DROP TABLE "garment_variants";
DROP TABLE "garments";
-- Category options duplicated colour/size now held by the product (all stored values were empty).
ALTER TABLE "products" DROP COLUMN "selected_options";
ALTER TABLE "categories" DROP COLUMN "options";

-- Indexes and the base product relation.
DROP INDEX "products_category_id_idx";
CREATE INDEX "products_category_id_origin_idx" ON "products"("category_id", "origin");
CREATE INDEX "products_base_product_id_idx" ON "products"("base_product_id");
ALTER TABLE "products" ADD CONSTRAINT "products_base_product_id_fkey" FOREIGN KEY ("base_product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
