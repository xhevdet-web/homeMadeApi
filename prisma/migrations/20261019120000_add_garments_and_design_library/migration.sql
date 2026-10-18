-- AlterTable
ALTER TABLE "categories" DROP COLUMN "base_price",
DROP COLUMN "stock",
ADD COLUMN     "design_category_id" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "garment_variant_id" TEXT;

-- AlterTable
ALTER TABLE "sub_categories" ADD COLUMN     "original_image_key" TEXT,
ADD COLUMN     "track_stock" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "garments" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_price" INTEGER NOT NULL,
    "image_key" TEXT,
    "front_image_key" TEXT,
    "back_image_key" TEXT,
    "front_print_area" JSONB,
    "back_print_area" JSONB,
    "silhouette" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "garments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garment_variants" (
    "id" TEXT NOT NULL,
    "garment_id" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "color_name" TEXT NOT NULL,
    "color_value" TEXT NOT NULL,
    "sku" TEXT,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "price" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "garment_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "garments_category_id_idx" ON "garments"("category_id");

-- CreateIndex
CREATE INDEX "garments_is_active_idx" ON "garments"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "garment_variants_sku_key" ON "garment_variants"("sku");

-- CreateIndex
CREATE INDEX "garment_variants_garment_id_idx" ON "garment_variants"("garment_id");

-- CreateIndex
CREATE UNIQUE INDEX "garment_variants_garment_id_size_color_value_key" ON "garment_variants"("garment_id", "size", "color_value");

-- CreateIndex
CREATE INDEX "categories_design_category_id_idx" ON "categories"("design_category_id");

-- CreateIndex
CREATE INDEX "products_garment_variant_id_idx" ON "products"("garment_variant_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_design_category_id_fkey" FOREIGN KEY ("design_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_variants" ADD CONSTRAINT "garment_variants_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_garment_variant_id_fkey" FOREIGN KEY ("garment_variant_id") REFERENCES "garment_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Inventory and prices can never go negative, even under concurrent orders.
ALTER TABLE "garments"
ADD CONSTRAINT "garments_base_price_nonnegative" CHECK ("base_price" >= 0);

ALTER TABLE "garment_variants"
ADD CONSTRAINT "garment_variants_stock_nonnegative" CHECK ("stock" >= 0),
ADD CONSTRAINT "garment_variants_price_nonnegative" CHECK ("price" IS NULL OR "price" >= 0);

-- A category cannot use itself as its design library.
ALTER TABLE "categories"
ADD CONSTRAINT "categories_design_category_not_self" CHECK ("design_category_id" IS NULL OR "design_category_id" <> "id");
