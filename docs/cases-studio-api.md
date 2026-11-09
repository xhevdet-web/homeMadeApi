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
| `printAreas` | `{ front: { x, y, width, height, radius? }, camera?: { x, y, width, height, radius? } }` as fractions of the template; `radius` is a share (0–0.5) of the area's width |

`front` is the printable area: artwork is clipped to it (rounded by `radius`). `camera` is
the camera opening: there the template itself is shown again above the artwork, so each
model keeps its real camera and the image never covers it. Responses include `overlayImageUrl`; `baseProduct` (on designs and
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
