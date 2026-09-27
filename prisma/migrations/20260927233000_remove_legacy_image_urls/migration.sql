-- R2 image_key is now the only stored image reference.
ALTER TABLE "categories" DROP COLUMN "image_url";
ALTER TABLE "sub_categories" DROP COLUMN "image_url";
ALTER TABLE "products" DROP COLUMN "image_url";
