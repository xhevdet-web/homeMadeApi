-- Every APPAREL category offers "Your own design": customers upload their artwork for
-- this design's price (charged once per design). Admins can edit or deactivate it.
INSERT INTO "sub_categories" (
  "id", "category_id", "name", "description", "type", "price", "stock", "track_stock",
  "is_active", "sort_order", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, c."id", 'Your own design',
  'Upload your own artwork to print on your piece.', 'CUSTOM_UPLOAD', 500, 0, false,
  true, 0, NOW(), NOW()
FROM "categories" c
WHERE c."builder_type" = 'APPAREL'
  AND NOT EXISTS (
    SELECT 1 FROM "sub_categories" s
    WHERE s."category_id" = c."id" AND s."type" = 'CUSTOM_UPLOAD'
  );
