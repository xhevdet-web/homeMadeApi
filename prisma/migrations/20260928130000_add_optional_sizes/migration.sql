ALTER TABLE "categories" ADD COLUMN "sizes" JSONB;
ALTER TABLE "products" ADD COLUMN "selected_size" JSONB;
