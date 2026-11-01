import { MUG_BUILDER, STICKER_BUILDER } from '../categories/builder-config.js';
import { MAX_MUGS_PER_ORDER } from '../categories/mug-config.js';
import {
  MAX_STICKERS_PER_DESIGN,
  MIN_STICKERS_PER_ORDER,
} from '../categories/sticker-sizes.js';

/**
 * How many of a product one order may hold, or null when it is ordered one at a time.
 * Ready-made stickers are sold from five; mugs (ready-made or designed) by the piece. A
 * sticker set carries its own quantities in its designs, so it is ordered once.
 */
export function orderQuantityRule(
  builderType: string | null | undefined,
  company: boolean,
): { min: number; max: number } | null {
  if (builderType === STICKER_BUILDER && company)
    return { min: MIN_STICKERS_PER_ORDER, max: MAX_STICKERS_PER_DESIGN };
  if (builderType === MUG_BUILDER) return { min: 1, max: MAX_MUGS_PER_ORDER };
  return null;
}
