import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  giftPackagingFields,
  takeGiftPackagingStock,
} from './gift-packaging.selection.js';

const transparentId = 'a0000000-0000-4000-8000-000000000001';
const boxId = 'b0000000-0000-4000-8000-000000000002';
const pinkId = 'c0000000-0000-4000-8000-000000000003';
const beigeId = 'd0000000-0000-4000-8000-000000000004';
const goldId = 'e0000000-0000-4000-8000-000000000005';

const transparent = {
  id: transparentId,
  name: 'Transparent Box',
  description: null,
  type: 'TRANSPARENT',
  imageKey: null,
  price: 400,
  stock: 20,
  isActive: true,
  colors: [],
};
const color = (id: string, name: string, overrides: object = {}) => ({
  id,
  name,
  hex: '#E8B4BC',
  imageKey: null,
  priceAdjustment: 50,
  stock: 5,
  isActive: true,
  ...overrides,
});
const box = {
  id: boxId,
  name: 'Classic Closed Box',
  description: null,
  type: 'OPAQUE',
  imageKey: null,
  price: 500,
  stock: 0,
  isActive: true,
  colors: [
    color(pinkId, 'Pink'),
    color(beigeId, 'Beige', { stock: 0 }),
    color(goldId, 'Gold', { isActive: false }),
  ],
};

function tx(records: object[]) {
  const byId = new Map(
    records.map((record) => [(record as { id: string }).id, record]),
  );
  return {
    giftPackaging: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    giftPackagingColor: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
const asTx = (value: ReturnType<typeof tx>) =>
  value as unknown as Prisma.TransactionClient;
const gift = { builderType: 'GIFT', company: false };

describe('giftPackagingFields', () => {
  it('leaves non-packaged designs empty', async () => {
    await expect(
      giftPackagingFields(asTx(tx([])), gift, undefined, undefined),
    ).resolves.toEqual({
      giftPackagingId: null,
      giftPackagingColorId: null,
      packagingPrice: 0,
    });
  });

  it('accepts transparent packaging without a colour, priced from the database', async () => {
    await expect(
      giftPackagingFields(
        asTx(tx([transparent])),
        gift,
        transparentId,
        undefined,
      ),
    ).resolves.toEqual({
      giftPackagingId: transparentId,
      giftPackagingColorId: null,
      packagingPrice: 400,
    });
  });

  it('rejects a colour on transparent packaging', async () => {
    await expect(
      giftPackagingFields(asTx(tx([transparent])), gift, transparentId, pinkId),
    ).rejects.toThrow('Transparent Box has no colours');
  });

  it('requires a colour for closed packaging with colours and adds its adjustment', async () => {
    const db = asTx(tx([box]));
    await expect(
      giftPackagingFields(db, gift, boxId, undefined),
    ).rejects.toThrow('Choose a colour of Classic Closed Box');
    await expect(giftPackagingFields(db, gift, boxId, pinkId)).resolves.toEqual(
      {
        giftPackagingId: boxId,
        giftPackagingColorId: pinkId,
        packagingPrice: 550,
      },
    );
  });

  it('rejects a colour of other packaging, inactive and sold-out colours', async () => {
    const db = asTx(tx([box]));
    await expect(
      giftPackagingFields(db, gift, boxId, transparentId),
    ).rejects.toThrow('This colour is not available for Classic Closed Box');
    await expect(giftPackagingFields(db, gift, boxId, goldId)).rejects.toThrow(
      'Classic Closed Box in Gold is no longer available',
    );
    await expect(giftPackagingFields(db, gift, boxId, beigeId)).rejects.toThrow(
      'Classic Closed Box in Beige is sold out',
    );
  });

  it('rejects inactive or unknown packaging', async () => {
    await expect(
      giftPackagingFields(
        asTx(tx([{ ...transparent, isActive: false }])),
        gift,
        transparentId,
        undefined,
      ),
    ).rejects.toThrow('Transparent Box is no longer available');
    await expect(
      giftPackagingFields(asTx(tx([])), gift, transparentId, undefined),
    ).rejects.toThrow('Gift packaging not found');
  });

  it('keeps packaging to customer gift designs', async () => {
    const db = asTx(tx([transparent]));
    for (const design of [
      { builderType: 'BOUQUET', company: false },
      { builderType: 'JEWELRY', company: false },
      { builderType: null, company: false },
      { builderType: 'GIFT', company: true },
    ])
      await expect(
        giftPackagingFields(db, design, transparentId, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      giftPackagingFields(db, gift, undefined, pinkId),
    ).rejects.toThrow('Choose the packaging of this colour');
  });
});

describe('takeGiftPackagingStock', () => {
  it('takes one from the colour of coloured packaging', async () => {
    const db = tx([box]);
    const taken = await takeGiftPackagingStock(asTx(db), boxId, pinkId);
    expect(taken.color?.name).toBe('Pink');
    expect(db.giftPackagingColor.updateMany).toHaveBeenCalledWith({
      where: { id: pinkId, isActive: true, stock: { gte: 1 } },
      data: { stock: { decrement: 1 } },
    });
    expect(db.giftPackaging.updateMany).not.toHaveBeenCalled();
  });

  it('takes one from transparent packaging itself', async () => {
    const db = tx([transparent]);
    await takeGiftPackagingStock(asTx(db), transparentId, null);
    expect(db.giftPackaging.updateMany).toHaveBeenCalledWith({
      where: { id: transparentId, isActive: true, stock: { gte: 1 } },
      data: { stock: { decrement: 1 } },
    });
  });

  it('fails when the last one was just ordered or the colour is gone', async () => {
    const db = tx([transparent, box]);
    db.giftPackaging.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      takeGiftPackagingStock(asTx(db), transparentId, null),
    ).rejects.toThrow('Transparent Box is sold out');
    await expect(
      takeGiftPackagingStock(asTx(db), boxId, goldId),
    ).rejects.toThrow('no longer available');
  });
});
