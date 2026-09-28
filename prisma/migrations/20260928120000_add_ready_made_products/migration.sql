CREATE TYPE "ProductType" AS ENUM ('CUSTOM_DESIGN', 'READY_MADE');
ALTER TABLE "products" ADD COLUMN "product_type" "ProductType" NOT NULL DEFAULT 'CUSTOM_DESIGN', ADD COLUMN "stock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD CONSTRAINT "products_stock_nonnegative" CHECK ("stock" >= 0), ADD CONSTRAINT "products_ready_made_price_nonnegative" CHECK ("product_type" <> 'READY_MADE' OR "price" >= 0);
