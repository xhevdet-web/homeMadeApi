# Garments, variants and apparel designs

APPAREL categories (e.g. "Hoodies") group **garments** (e.g. "Classic Hoodie"). Each
garment has **variants**: one row per size × colour with its own stock. Customers
design on a variant; stock is reserved on that exact variant when the order is placed.

## Model

| Entity | Key fields |
|---|---|
| `Garment` | `categoryId`, `name`, `description`, `basePrice` (cents), `imageKey` (product photo), `frontImageKey` / `backImageKey` (studio mockups), `frontPrintArea` / `backPrintArea`, `silhouette` (`HOODIE`, `TSHIRT` fallback drawing), `isActive`, `sortOrder` |
| `GarmentVariant` | `garmentId`, `size`, `colorName`, `colorValue` (swatch, e.g. `#C0392B`), `sku` (unique, optional), `stock`, `price` (optional override, cents), `isActive`, `sortOrder` |

`backImageKey` is optional: when it is empty, clients reuse the front mockup for the back
side (dashboard and app both do).

`(garmentId, size, colorValue)` is unique. Responses add `imageUrl`, `frontImageUrl`
and `backImageUrl` for every `*ImageKey`.

A **print area** is a fraction of the mockup, with an optional real print size:

```json
{ "x": 0.3, "y": 0.28, "width": 0.4, "height": 0.42, "widthCm": 30, "heightCm": 40 }
```

`x + width` and `y + height` must be ≤ 1; `widthCm`/`heightCm` are 0–200.

## Endpoints

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/categories/:categoryId/garments` | public | Active garments with their **active** variants |
| GET | `/garments?categoryId=` | admin | Every garment of the category, **including inactive** garments and variants (dashboard) |
| GET | `/garments/:id` | public | Garment with all variants |
| POST | `/garments` | admin | Multipart or JSON. Files: `image`, `frontImage`, `backImage`. JSON fields in multipart: `frontPrintArea`, `backPrintArea` as `JSON.stringify(...)`. Category must be `APPAREL`. |
| PATCH | `/garments/:id` | admin | Same fields, all optional; replaced images are deleted after the update succeeds. Send a print area as `null` to clear it. |
| PUT | `/garments/:id/variants` | admin | `{ "variants": [{ size, colorName, colorValue, sku?, stock, price?, isActive?, sortOrder? }] }` — the **complete** matrix. Rows match by size + colour (case-insensitive colour), so ids are kept; omitted rows are deleted, or deactivated when a customer design uses them. Duplicate size × colour or SKU → 400. |
| DELETE | `/garments/:id` | admin | 409 when customer designs use the garment (deactivate it instead). |

## Design library and designs

- `Category.designCategoryId` (nullable UUID): an APPAREL category also offers the
  sub-categories (designs) of this library category. `GET /categories/:id/sub-categories`
  returns the category's own designs followed by the library's. A library cannot be
  the category itself or chain to another library.
- `SubCategory.type`: apparel designs use `ICON`, `LOGO`, `LETTERING` or `ILLUSTRATION`.
- `SubCategory.trackStock` (default `true`): `false` for unlimited printed designs —
  orders never decrement them.
- Upload option `removeBackground` (default `true`): `false` keeps fine logos and
  lettering untouched. When the background *is* removed, the untouched upload is also
  stored and returned as `originalImageUrl` for production printing.

## Customer designs (Product)

`POST /products` for an APPAREL category:

- requires `garmentVariantId` (active, in stock, garment active and in this category);
- every item needs a placement: `side` (`FRONT`/`BACK`), `x`, `y` (0–1 within the
  side's print area, design centre), optional `scale` (0.1–5) and `rotation`
  (−360–360°);
- optional files `designPreview` (front) and `backDesignPreview`;
- price = (variant `price` ?? garment `basePrice`) + designs; the garment price is
  snapshotted as `Product.basePrice`.

Responses include `garmentVariant { id, size, colorName, colorValue, sku, price,
garment { id, name, basePrice, imageUrl, frontImageUrl, backImageUrl, frontPrintArea,
backPrintArea, silhouette } }`, `backDesignPreviewUrl` and item placements.
Non-APPAREL products reject `garmentVariantId` and never store placements.

## Orders

Placing an order for an APPAREL design atomically decrements the variant's stock
(`Classic Hoodie in Red / S just sold out` when it is gone) and the stock of tracked
designs only. The order snapshot keeps the garment variant, placements and both
previews, so order history never changes when the catalog does. The snapshot garment
also keeps `frontPrintArea`, `backPrintArea`, `silhouette` and copies of the mockups
(`frontImageUrl`, `backImageUrl`), and each design keeps `originalImageUrl`, so the
production sheet can convert placements to centimetres from the order alone.

## Migration

`20261019120000_add_garments_and_design_library` adds the tables and columns above
and **drops `categories.base_price` and `categories.stock`** (moved to garments and
variants). Apply with `npx prisma migrate dev`.

## Customer uploads ("Your own design")

Customers can place their own artwork on apparel for a fixed, admin-set price.

- **Setup (dashboard):** create one SubCategory in the APPAREL category (or its design
  library) with `type: "CUSTOM_UPLOAD"`, e.g. name "Your own design", `price: 500`,
  `trackStock: false`. Deactivate it to switch uploads off; change its price anytime.
- **Create:** `POST /products` multipart adds up to 4 files `customDesigns`. Each
  CUSTOM_UPLOAD item references one with `customDesignIndex` (0–3), plus its placement.
- **Price:** the CUSTOM_UPLOAD price is charged **once per design**, however many own
  images are placed (first item `unitPrice` = price, the rest 0).
- **Rules (400):** an own-design item needs exactly one upload (quantity 1); every
  uploaded file must be placed exactly once; catalog designs cannot carry uploads;
  only APPAREL designs accept uploads; clients cannot send storage keys. Rejected
  requests delete the files they uploaded.
- **Storage:** files are stored untouched (no background removal) under
  `custom-designs/`; responses expose `items[].customImageUrl`. Orders copy them into
  the order, and deleting a product deletes its uploads.
