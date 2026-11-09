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
  Returns a plain array. Add `page` for one page of results instead, see below.
- `GET /products/:id`, `PATCH /products/:id`, `DELETE /products/:id` (admin).
- `POST /products` — `origin: COMPANY` (admin, multipart with `file`, optional `backImage`),
  or a customer design (default). Apparel designs send `baseProductId` and `selectedSizeId`.
  Saving a design checks the size is in stock but never reserves it.
- `GET /sub-categories?categoryId=` — one category's components.
- `GET /orders?categoryId=&productId=&origin=&status=` — see `orders-api.md`.

Deleting a product that has orders or customer designs made on it is refused (409);
deactivate it instead.

## Listing with filters, sorting and pages (`GET /products?page=…`)

Without `page`, `GET /products` works exactly as before: a plain array of every match,
newest first. The mobile app and the studios rely on that. With `page`, the response is
one page, `{ data, meta }`, like `GET /orders`.

| Param | Values | Meaning |
|---|---|---|
| `page` | integer ≥ 1 | Turns on paginated mode. |
| `limit` | integer 1–48, default 12 | Page size. |
| `sort` | `newest` (default), `price_asc`, `price_desc` | Ordering. |
| `type` | `ready`, `custom` | Ready-made or made to order. |
| `inStock` | `true` / `false` | `true` hides sold-out products. |
| `search` | 1–100 chars | Name, description, colour **or category name**; case-insensitive, `%` and `_` match literally. |
| `categoryId`, `origin`, `createdById`, `isActive` | as before | |

`limit`, `sort`, `type` and `inStock` are ignored without `page`, and the array search
does not match category names. Invalid values return 400, e.g.
`"sort must be one of: newest, price_asc, price_desc"`.

Rules in paginated mode:

- **Made to order (`type=custom`)**: `printAreas.front` is set (not null), or the
  category's `builderType` is `APPAREL`, or it is a `CASE` product other than a ready-made
  case (a COMPANY product with `baseProductId`, see `cases-studio-api.md`).
  **Ready-made (`type=ready`)**: every other product.
- **Sold out**: with a non-empty `sizes` array, when no size has a `stock` above 0;
  otherwise (`sizes` empty, null or not an array) when `stock` ≤ 0.
- Only products of **active categories** are listed.
- **Sorting** always ends in the id, so pages never repeat or skip a product:
  `newest` = `createdAt` desc, `sortOrder` asc, `id` asc; `price_asc` / `price_desc` =
  `price`, then `createdAt` desc, then `id` asc.
- **Visibility** is unchanged: a customer's phone case designs are seen only by their
  creator and admins.
- A `page` past the end returns `data: []` with the correct `meta`.

```
GET /api/v1/products?origin=COMPANY&isActive=true&page=2&limit=12&sort=price_asc&type=custom&inStock=true&search=hoodie
```

```json
{
  "data": [{ "id": "…", "name": "Black Essential Hoodie", "price": 3500, "category": { … }, … }],
  "meta": {
    "page": 2,
    "limit": 12,
    "total": 17,
    "totalPages": 2,
    "counts": { "all": 17, "ready": 5, "custom": 12 }
  }
}
```

`data` holds the same product objects as the array mode. `total` and `totalPages` count
every filter. `counts` counts every filter **except `type`**, so a type filter can show
how many results it would give; `all = ready + custom`.

The counts and the page's ids are read in one transaction, with no rows loaded just to
count them. Migration `20261109090000_add_product_listing_indexes` adds
`(origin, is_active, created_at)` and `(origin, is_active, price)` indexes on `products`.

Tests: `test/products/product-listing.e2e-spec.ts`. Its database part creates a
throwaway database next to `DATABASE_URL`'s, runs the migrations, and drops the database
afterwards. It is skipped when no database is reachable or the user cannot create one.

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
