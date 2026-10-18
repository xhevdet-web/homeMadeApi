UPDATE "categories"
SET "builder_type" = CASE
  WHEN LOWER("name") IN ('bracelet', 'necklace') THEN 'JEWELRY'
  WHEN LOWER("name") = 'flowers' THEN 'BOUQUET'
  WHEN LOWER("name") = 'gifts' THEN 'GIFT'
  WHEN LOWER("name") IN ('hoodie', 't-shirt') THEN 'APPAREL'
  ELSE "builder_type"
END
WHERE LOWER("name") IN (
  'bracelet',
  'necklace',
  'flowers',
  'gifts',
  'hoodie',
  't-shirt'
);
