import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

export const BUILDER_TYPES = ['JEWELRY', 'BOUQUET', 'GIFT', 'APPAREL'] as const;
export type BuilderType = (typeof BUILDER_TYPES)[number];

type Option = {
  key: string;
  name: string;
  type: 'select' | 'color' | 'number' | 'text';
  required: boolean;
  values?: unknown[];
  min?: number;
  max?: number;
  maxLength?: number;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message: string): never {
  throw new BadRequestException('Invalid category options: ' + message);
}

export function validateCategoryOptions(
  value: unknown,
): Prisma.InputJsonArray | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalid('options must be an array or null');
  const keys = new Set<string>();
  return value.map((raw, index) => {
    if (!object(raw)) invalid(`option ${index} must be an object`);
    const allowed = new Set([
      'key',
      'name',
      'type',
      'required',
      'values',
      'min',
      'max',
      'maxLength',
    ]);
    for (const key of Object.keys(raw))
      if (!allowed.has(key)) invalid(`option ${index} contains unknown field ${key}`);
    if (typeof raw.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(raw.key))
      invalid(`option ${index} has an invalid key`);
    if (keys.has(raw.key)) invalid(`option key ${raw.key} is duplicated`);
    keys.add(raw.key);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200)
      invalid(`option ${raw.key} has an invalid name`);
    if (!['select', 'color', 'number', 'text'].includes(String(raw.type)))
      invalid(`option ${raw.key} has an invalid type`);
    if (typeof raw.required !== 'boolean')
      invalid(`option ${raw.key} required must be boolean`);
    const option: Option = {
      key: raw.key,
      name: raw.name.trim(),
      type: raw.type as Option['type'],
      required: raw.required,
    };
    if (option.type === 'select') {
      if (!Array.isArray(raw.values) || raw.values.some((item) => typeof item !== 'string'))
        invalid(`option ${raw.key} values must be a string array`);
      if (new Set(raw.values).size !== raw.values.length)
        invalid(`option ${raw.key} values must be unique`);
      option.values = raw.values;
    } else if (option.type === 'color') {
      if (!Array.isArray(raw.values))
        invalid(`option ${raw.key} values must be an array`);
      const colors = new Set<string>();
      option.values = raw.values.map((color, colorIndex) => {
        if (
          !object(color) ||
          typeof color.name !== 'string' ||
          !color.name.trim() ||
          typeof color.value !== 'string' ||
          !color.value.trim()
        )
          invalid(`option ${option.key} color ${colorIndex} is invalid`);
        if (colors.has(color.value))
          invalid(`option ${option.key} color values must be unique`);
        colors.add(color.value);
        return { name: color.name.trim(), value: color.value.trim() };
      });
    } else if (option.type === 'number') {
      for (const field of ['min', 'max'] as const) {
        const number = raw[field];
        if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number)))
          invalid(`option ${raw.key} ${field} must be a finite number`);
        if (number !== undefined) option[field] = number;
      }
      if (option.min !== undefined && option.max !== undefined && option.min > option.max)
        invalid(`option ${raw.key} min cannot exceed max`);
    } else if (option.type === 'text') {
      if (
        raw.maxLength !== undefined &&
        (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 1 || (raw.maxLength as number) > 10000)
      )
        invalid(`option ${raw.key} maxLength must be an integer from 1 to 10000`);
      if (raw.maxLength !== undefined) option.maxLength = raw.maxLength as number;
    }
    return option as unknown as Prisma.InputJsonObject;
  });
}

export function validateSelectedOptions(
  configured: Prisma.JsonValue | null,
  selected: unknown,
): Prisma.InputJsonObject | null | undefined {
  if (selected === undefined || selected === null) return selected;
  if (!object(selected))
    throw new BadRequestException('selectedOptions must be an object or null');
  const options = validateCategoryOptions(configured ?? null) ?? [];
  const byKey = new Map(
    options.map((raw) => {
      const option = raw as unknown as Option;
      return [option.key, option] as const;
    }),
  );
  for (const key of Object.keys(selected))
    if (!byKey.has(key))
      throw new BadRequestException(`Unknown selected option: ${key}`);
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const option of byKey.values()) {
    const value = selected[option.key];
    if (value === undefined || value === null || value === '') {
      if (option.required)
        throw new BadRequestException(`Selected option ${option.key} is required`);
      continue;
    }
    if (option.type === 'select') {
      if (typeof value !== 'string' || !option.values?.includes(value))
        throw new BadRequestException(`Invalid value for selected option ${option.key}`);
      result[option.key] = value;
    } else if (option.type === 'color') {
      const requested =
        typeof value === 'string'
          ? value
          : object(value) && typeof value.value === 'string'
            ? value.value
            : undefined;
      if (!requested)
        throw new BadRequestException(`Invalid color for selected option ${option.key}`);
      const colors = (option.values ?? []) as { name: string; value: string }[];
      const configuredColor = colors.find((color) => color.value === requested);
      if (colors.length && !configuredColor)
        throw new BadRequestException(`Invalid color for selected option ${option.key}`);
      result[option.key] = configuredColor ?? requested;
    } else if (option.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (option.min !== undefined && value < option.min) ||
        (option.max !== undefined && value > option.max)
      )
        throw new BadRequestException(`Invalid number for selected option ${option.key}`);
      result[option.key] = value;
    } else {
      if (
        typeof value !== 'string' ||
        (option.maxLength !== undefined && value.length > option.maxLength)
      )
        throw new BadRequestException(`Invalid text for selected option ${option.key}`);
      result[option.key] = value;
    }
  }
  return result as Prisma.InputJsonObject;
}
