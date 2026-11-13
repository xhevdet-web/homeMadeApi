# Bracelet regression fixture

`bracelet-on-textured-background.jpg` is the user's original bracelet photograph, supplied to reproduce background-removal failure. It contains a red, black, and amber beaded loop with a silver clasp on a textured tabletop (482 x 637 pixels).

The real-model tests verify that the open center and surrounding tabletop are transparent, while bead centers and the silver clasp remain foreground. The fixture also exercises portrait mask alignment. It is used only for opt-in local inference tests; no image is sent to external processing services or R2.

# Jewelry component fixture

`bead-on-transparent-canvas.png` is a generated 1200 x 1600 transparent PNG with a shaded red bead (~175 px across, slightly off-centre, anti-aliased edge) and a few 1–2 px specks near the corners. It mimics a component whose background was removed in a desktop editor that kept the original canvas size. The entity-image e2e tests check that jewelry component uploads are trimmed to a centred ~182 px square while the untouched file is kept in `originals`.
