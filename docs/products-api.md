# Products API (product-centred catalog)

Product is the central entity. A Category groups products and decides which Creative
Studio opens (`builderType`); it holds no price or stock.

```
Category 1 ── N Product ── N ProductItem ── 1 SubCategory (component)
                  │
                  ├─ origin COMPANY   admin catalog: price, stock or stock per size
                  └─ origin CUSTOMER  Creative Studio design: components, preview,
                                      calculated price, optional baseProduct
Order N ── 1 Product
```

## Product fields

| Field | COMPANY | CUSTOMER |
| --- | --- | --- |
| `price` (cents) | set by the admin | base product price + components |
| `stock` | unsized products | — |
| `sizes` `[{ size, stock }]` | sized products (stock per size) | — |
| `color`, `colorHex` | apparel: one product is one colour | — |
| `imageKey`, `backImageKey`, `printAreas` | apparel studio canvas | — |
| `baseProductId`, `baseProduct` | — | the company product a design is made on |
| `selectedSize` | optional category size preset | base size `{ id: "L", name: "L" }` or a preset |
| `items`, `designPreviewKey` | optional | the design |

A different colour of the same garment is a separate company product, e.g. "Black
Essential Hoodie" and "White Essential Hoodie".

## Endpoints

- `GET /products?categoryId=&origin=COMPANY|CUSTOMER&createdById=&isActive=true&search=` —
  filtered in the database. The mobile app requests one category's company products.
- `GET /products/:id`, `PATCH /products/:id`, `DELETE /products/:id` (admin).
- `POST /products` — `origin: COMPANY` (admin, multipart with `file`, optional `backImage`),
  or a customer design (default). Apparel designs send `baseProductId` and `selectedSizeId`.
  Saving a design checks the size is in stock but never reserves it.
- `GET /sub-categories?categoryId=` — one category's components.
- `GET /orders?categoryId=&productId=&origin=&status=` — see `orders-api.md`.

Deleting a product that has orders or customer designs made on it is refused (409);
deactivate it instead.

## Stock

Stock changes only when an order is placed, inside the order transaction:
unsized company product → `stock - 1`; sized company product → the chosen size `- 1`;
customer design → its components, plus one unit of its base product (in the design's size).

## Migration `20261024120000_product_centered_catalog`

- `ProductType { CUSTOM_DESIGN, READY_MADE }` was renamed in place to
  `ProductOrigin { CUSTOMER, COMPANY }` (`products.product_type` → `products.origin`).
- Each garment × colour became one COMPANY product (active variants → `sizes`, front
  mockup → image, back mockup → `back_image_key`, print areas → `print_areas`);
  designs printed on a variant now reference that product (`base_product_id`) with the
  variant's size as `selected_size`. The garment silhouette moved to the category's
  `builder_config`. The migration verifies all of this before dropping
  `garments`, `garment_variants`, `products.garment_variant_id`,
  `products.selected_options` and `categories.options`.
