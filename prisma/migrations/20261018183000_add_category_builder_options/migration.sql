ALTER TABLE "categories"
ADD COLUMN "builder_type" TEXT,
ADD COLUMN "options" JSONB;

ALTER TABLE "products"
ADD COLUMN "selected_options" JSONB;
