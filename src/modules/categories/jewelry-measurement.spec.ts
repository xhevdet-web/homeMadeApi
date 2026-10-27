import {
  assertJewelryMinimumPrice,
  assertNotOverfilled,
  JEWELRY_LENGTH_TOLERANCE_MM,
  canComponentFit,
  isJewelryCategory,
  isNecklaceCategory,
  isLengthComplete,
  measuredSize,
  normalizeCategorySizes,
  remainingLengthMm,
  selectedMeasuredSize,
  selectMeasurement,
  usedLengthMm,
} from './jewelry-measurement.js';

const small = {
  id: 'small',
  name: 'Small',
  minMeasurementMm: 140,
  maxMeasurementMm: 180,
  defaultMeasurementMm: 160,
};
const medium = {
  id: 'medium',
  name: 'Medium',
  minMeasurementMm: 180,
  maxMeasurementMm: 240,
  defaultMeasurementMm: 200,
};
// The live Bracelet category still stores this until the admin converts it.
const legacy = {
  id: 'medium',
  name: 'Medium',
  measurement: 18,
  unit: '24cm',
  maxItems: 32,
};

describe('jewelry measurement', () => {
  it('measures bracelets and necklaces alike, and tells them apart like the app', () => {
    expect(isJewelryCategory({ builderType: 'JEWELRY' })).toBe(true);
    expect(isJewelryCategory({ builderType: 'GIFT' })).toBe(false);
    expect(isJewelryCategory(null)).toBe(false);
    expect(
      isNecklaceCategory({ builderType: 'JEWELRY', name: 'Necklace' }),
    ).toBe(true);
    expect(
      isNecklaceCategory({ builderType: 'JEWELRY', name: 'Bracelet' }),
    ).toBe(false);
    expect(
      isNecklaceCategory({
        builderType: 'JEWELRY',
        name: 'Charms',
        builderConfig: { silhouette: 'NECKLACE' },
      }),
    ).toBe(true);
    expect(
      isNecklaceCategory({
        builderType: 'JEWELRY',
        name: 'Necklace pieces',
        builderConfig: { silhouette: 'BRACELET' },
      }),
    ).toBe(false);
    expect(isNecklaceCategory({ builderType: 'GIFT', name: 'Necklace' })).toBe(
      false,
    );
  });

  it('reads Small and Medium length ranges and rejects legacy or broken sizes', () => {
    expect(measuredSize(small)).toEqual(small);
    expect(measuredSize(medium)).toEqual(medium);
    expect(measuredSize(legacy)).toBeNull();
    expect(measuredSize({ ...medium, maxMeasurementMm: 170 })).toBeNull();
    expect(measuredSize({ ...medium, defaultMeasurementMm: 260 })).toBeNull();
    expect(measuredSize({ ...medium, minMeasurementMm: 18.5 })).toBeNull();
    expect(selectedMeasuredSize(legacy)).toBeNull();
    expect(
      selectedMeasuredSize({ ...medium, selectedMeasurementMm: 200 }),
    ).toEqual({
      ...medium,
      selectedMeasurementMm: 200,
    });
  });

  it('accepts a length within the size and rejects others', () => {
    expect(selectMeasurement(medium, 200)).toEqual({
      ...medium,
      selectedMeasurementMm: 200,
    });
    expect(selectMeasurement(medium, 180).selectedMeasurementMm).toBe(180);
    expect(selectMeasurement(medium, 240).selectedMeasurementMm).toBe(240);
    expect(() => selectMeasurement(medium, 250)).toThrow('18 cm to 24 cm');
    expect(() => selectMeasurement(medium, 170)).toThrow('18 cm to 24 cm');
    expect(() => selectMeasurement(medium, undefined)).toThrow(
      'Choose the length',
    );
  });

  it('adds up mixed component sizes by quantity', () => {
    expect(
      usedLengthMm([
        { name: '8 mm bead', quantity: 10, effectiveLengthMm: 8 },
        { name: '10 mm pearl', quantity: 4, effectiveLengthMm: 10 },
        { name: '4 mm spacer', quantity: 2, effectiveLengthMm: 4 },
      ]),
    ).toBe(128);
  });

  it('refuses to measure a component without a physical size', () => {
    for (const effectiveLengthMm of [null, 0, -8, 8.5])
      expect(() =>
        usedLengthMm([
          { name: 'Black Panther', quantity: 1, effectiveLengthMm },
        ]),
      ).toThrow('Black Panther does not have a physical size configured');
  });

  it('applies one central tolerance for fit, completion and overfill', () => {
    expect(JEWELRY_LENGTH_TOLERANCE_MM).toBe(2);
    expect(remainingLengthMm(168, 200)).toBe(32);
    expect(canComponentFit(176, 12, 180)).toBe(false);
    expect(canComponentFit(176, 6, 180)).toBe(true);
    expect(canComponentFit(176, 4, 180)).toBe(true);
    expect(isLengthComplete(178, 180)).toBe(true);
    expect(isLengthComplete(182, 180)).toBe(true);
    expect(isLengthComplete(177, 180)).toBe(false);
    expect(() => assertNotOverfilled(182, 180)).not.toThrow();
    expect(() => assertNotOverfilled(183, 180)).toThrow(
      'longer than the chosen 18 cm',
    );
    expect(() => assertNotOverfilled(100, 180)).not.toThrow();
  });

  it('orders jewelry from the minimum price, however full it is', () => {
    expect(() => assertJewelryMinimumPrice(499)).toThrow(
      'Bracelets start at €5.00',
    );
    expect(() => assertJewelryMinimumPrice(499, true)).toThrow(
      'Necklaces start at €5.00',
    );
    expect(() => assertJewelryMinimumPrice(500)).not.toThrow();
    expect(() => assertJewelryMinimumPrice(1950, true)).not.toThrow();
  });

  it('stores jewelry sizes as ranges and other sizes in the legacy shape', () => {
    expect(normalizeCategorySizes([{ ...small, maxItems: 28 }], true)).toEqual([
      small,
    ]);
    expect(() => normalizeCategorySizes([legacy], true)).toThrow('Size 1');
    expect(normalizeCategorySizes([legacy], false)).toEqual([legacy]);
    expect(() => normalizeCategorySizes([small], false)).toThrow('Size 1');
  });
});
