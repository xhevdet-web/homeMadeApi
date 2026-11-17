# Cases studio (phone cases)

Categories with `builderType` `CASE` open the Case Studio: the customer picks a phone model,
then puts **one** image on it, either a library design or their own photo, and fits it
inside the case.

## Phone models: COMPANY products

Each model is one COMPANY product of the CASE category (`POST /products`, admin only, multipart):

| field | notes |
| --- | --- |
| `name` | display name, e.g. `iPhone 14` |
| `deviceBrand` | uppercase maker, e.g. `APPLE`, `SAMSUNG`; the app groups models by it |
| `sortOrder` | order within the brand, lower first |
| `price`, `stock` | the case itself; stock is taken only when an order is placed |
| `file` | the **template**: the empty back of this exact model, ideally a transparent PNG |
| `overlayImage` | optional transparent PNG drawn above the artwork (edges, camera island), same size as the template; always stored untouched |
| `removeBackground` | send `false` with a template so it is stored untouched and stays aligned with its overlay |
| `printAreas` | `{ front: { x, y, width, height, radius?, radii?, bleed?, safe? }, camera?: { x, y, width, height, radius?, radii? } }` as fractions of the template (see below) |

`front` is the printable area: artwork is clipped to it (rounded by its corners). `camera` is
the camera opening: there the template itself is shown again above the artwork, so each
model keeps its real camera and the image never covers it, even where the camera reaches
past the printable edge.

### Template geometry

Positions and sizes are fractions (0–1) of the template image, never screen pixels. Every
other distance is a fraction of the **area's width**, so corners stay round and each side gets
the same physical distance on any screen:

| field | where | notes |
| --- | --- | --- |
| `radius` | front, camera | one radius for all corners, 0–0.5 |
| `radii` | front, camera | `{ tl, tr, br, bl }`, each 0–0.5; wins over `radius` (e.g. a case whose bottom curves less than its top). The admin also sends `radius` (= `tl`) for clients that only know one radius |
| `bleed` | front only | 0–0.1: how far artwork extends past every edge of the printable area, so no unprinted rim shows. The studio makes artwork cover it automatically |
| `safe` | front only | `{ top, right, bottom, left }`, each 0–0.45: where important content (faces, text, logos) should stay. Shown to customers as a dotted guide while editing; never crops artwork and is never part of a saved preview or print |

The API rejects negative or empty sizes, areas outside the template, radii outside 0–0.5,
incomplete `radii`/`safe` objects, bleed above 0.1, bleed or `safe` on the camera, and a camera
that doesn't overlap the printable area. Templates saved before these fields keep their look:
corners fall back to `radius`, bleed is 0 and there is no safe area. Nothing is migrated: the
fields live in the existing `printAreas` JSON column.

Customer designs keep their meaning: `x`, `y` are fractions of the printable area and scale 1
still means "just covers the printable area", so with bleed new designs start slightly above 1.
The geometry is one module, `HomeMadeWeb/src/studios/cases/geometry.ts`, copied as
`initial-project-front/src/views/cases/caseGeometry.js` for the admin; both test suites check the
same expected outlines. A future custom mask (SVG path) would replace the printable outline
there and keep the rest (camera cut, bleed, guides). Responses include `overlayImageUrl`; `baseProduct` (on designs and
order snapshots) carries `deviceBrand` and `overlayImageKey/Url` too.

## Ready-made cases: COMPANY products linked to a phone model

A finished printed case sold as it is (e.g. "iPhone 15 – Marble") is also a COMPANY
product of the CASE category. It has **no `printAreas`** and **`baseProductId`** set to
the phone model it fits. Every COMPANY product of a CASE category is exactly one of the
two kinds, and the API rejects anything else:

| | `printAreas.front` | `baseProductId` |
| --- | --- | --- |
| Phone model (studio step 1) | set | `null` |
| Ready-made case ("Or pick one we made") | `null` | the phone model's id |

So clients tell them apart with `baseProductId`: `null` → phone model, set → ready-made.

- `POST /products` (admin, multipart): `origin=COMPANY`, `categoryId`, `name`, `price`,
  `stock`, `file` (the photo of the finished case; `backImage` optional),
  `baseProductId`, no `printAreas`. `deviceBrand`, `sortOrder` and `description` are
  optional.
- `PATCH /products/:id` (admin): `baseProductId` moves it to another model; `""` (or
  `null`) unlinks it, together with a `printAreas.front` to make it a phone model.
- The linked product must be an active phone model (COMPANY, same category, with
  `printAreas.front`, no base product of its own). A phone model that designs or
  ready-made cases are made on cannot stop being one or leave its category.
- Only CASE products can be linked; any other COMPANY product with `baseProductId` is
  rejected.
- Responses include `baseProduct` (name, `deviceBrand`, `imageUrl`, …) as for designs.
- Ordering one works like any COMPANY product: its own `price`, one taken from its own
  `stock`, no design step, and the phone model's stock is untouched.
- Customers cannot design on a ready-made case: it is rejected as a base product.
- In `GET /products?page=…`, ready-made cases count as `type=ready`; phone models and
  customer case designs stay `custom`.

## Designs: SubCategories

Library artwork is ordinary SubCategories of the category (`price` is an optional premium,
usually `trackStock: false`). Every CASE category gets a `CUSTOM_UPLOAD` SubCategory,
"Your own photo", free by default; the admin may reprice or deactivate it.

## Customer designs

`POST /products` with `baseProductId` (the model, required) and exactly one item:

```json
[{ "subCategoryId": "…", "quantity": 1, "position": 0, "x": 0.5, "y": 0.48, "scale": 1.25, "rotation": 0 }]
```

- `x`, `y`: image centre, 0–1 of the printable area. `scale`: 1 = the image just covers the
  area ("cover"). `rotation`: degrees. `side` is ignored.
- Own photo: the item has `customDesignIndex: 0` and the file is sent as `customDesigns`.
  JPEG, PNG and WebP are accepted (the file signature is checked, not just its type), at
  most 5 MB, stored untouched under `custom-designs/`.
- `designPreview`: the flattened case (template + artwork + overlay), PNG.
- Price = model price + item price (backend-calculated). Text layers are not supported yet.
- Saving never changes stock; an order takes one of the model, like apparel base products.

## Privacy

CUSTOMER products of a CASE category usually hold a personal photo. They are returned only
to their creator and to admins: `GET /products/:id` answers 404 to anyone else, list routes
(`/products`, `/users/:id/products`, `/categories/:id/products`,
`/sub-categories/:id/products`) leave them out, and they never appear in
`/products/creations/from-others`. These routes read an optional Bearer token for this.
