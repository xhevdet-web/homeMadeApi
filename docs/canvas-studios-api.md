# Bouquet & Gift studios (canvas builders)

Categories with `builderType` `BOUQUET` or `GIFT` are composed freely on one square canvas.

## Products

`POST /products` (multipart, like jewelry): one `items[]` entry per placed component.

| field | notes |
| --- | --- |
| `subCategoryId`, `quantity` | as before; the app sends `quantity: 1` per placed component |
| `position` | stacking order on the canvas (0 = back) |
| `x`, `y` | **required** for BOUQUET/GIFT: item centre, 0–1 of the canvas |
| `scale`, `rotation` | 0.1–5, −360–360 degrees |
| `side` | ignored (stored as null); only APPAREL is two-sided |

Price, stock and sizes work exactly like jewelry: `price = Σ quantity × SubCategory.price`,
`selectedSizeId` caps `itemCount` at the size's `maxItems`, and stock is only decremented
when an order is placed.

### Personalised text (GIFT only)

`textLayers` (multipart: `JSON.stringify`), up to 6:
`[{ id, text (1–80), x, y (0–1), scale (0.1–5), rotation (−360–360), color? "#RRGGBB", font? "SERIF" | "SANS" | "SCRIPT", weight? "LIGHT" | "REGULAR" | "BOLD", italic? boolean }]`. APPAREL text also needs `side` ("FRONT" | "BACK"). Customer artwork (`customDesigns`) must be PNG.
Free of charge, no stock. Rejected for every other builder. Copied into the order snapshot
(`order.product.textLayers`) so production sees the exact text.

## Admin setup (dashboard)

The studio groups SubCategories by keywords in `SubCategory.type` (case-insensitive):

- **BOUQUET:** `FLOWER` (Flowers), `GREENERY`/`LEAF`/`FOLIAGE`/`EUCALYPTUS` (Greenery),
  `FILLER` (Fillers), `WRAP`/`PAPER` (Wrapping, one per bouquet, replaces the drawn paper).
- **GIFT:** `ITEM`/`MUG`/`CHOCOLATE`/`COFFEE`… (Items), `DECORATION`/`RIBBON`/`CARD`/`HEART` (Decorations),
  `FILLER`/`SHRED` (Filler), `BAG`/`BOX`/`BASKET` (Bag & box, one per gift, replaces the drawn clear bag).

Unknown types still work: they appear under "All" and are placed like flowers/items.
Upload transparent PNGs (`removeBackground`) so components overlap naturally.
