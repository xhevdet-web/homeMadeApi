# Bracelet regression fixture

`bracelet-on-textured-background.jpg` is the user's original bracelet photograph, supplied to reproduce background-removal failure. It contains a red, black, and amber beaded loop with a silver clasp on a textured tabletop (482 x 637 pixels).

The real-model tests verify that the open center and surrounding tabletop are transparent, while bead centers and the silver clasp remain foreground. The fixture also exercises portrait mask alignment. It is used only for opt-in local inference tests; no image is sent to external processing services or R2.
