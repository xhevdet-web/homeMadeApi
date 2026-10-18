ALTER TABLE "categories"
ADD COLUMN "base_price" INTEGER,
ADD COLUMN "stock" INTEGER;

ALTER TABLE "categories"
ADD CONSTRAINT "categories_base_price_nonnegative"
CHECK ("base_price" IS NULL OR "base_price" >= 0),
ADD CONSTRAINT "categories_stock_nonnegative"
CHECK ("stock" IS NULL OR "stock" >= 0);
