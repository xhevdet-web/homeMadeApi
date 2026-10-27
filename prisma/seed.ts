// Development data. Runs with Node type stripping, which cannot load the generated
// Prisma client (its imports name .js files), so it talks to PostgreSQL through the same
// adapter. Every insert skips rows that already exist: seeding never overwrites data.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';

const packaging = [
  { name: 'Transparent Box', description: "See what's inside", type: 'TRANSPARENT', shape: 'SQUARE', price: 400, stock: 20, sortOrder: 0, colors: [] },
  {
    name: 'Classic Closed Box', description: 'Best for mugs, candles and teddies', type: 'OPAQUE', shape: 'SQUARE', price: 500, stock: 0, sortOrder: 1,
    colors: [
      { name: 'Black', hex: '#151515', stock: 12 },
      { name: 'White', hex: '#F5F5F5', stock: 18 },
      { name: 'Pink', hex: '#E8B4BC', stock: 5 },
      { name: 'Beige', hex: '#E5D3B3', stock: 0 },
    ],
  },
  {
    name: 'Slim Closed Box', description: 'Best for jewelry, chocolates and cards', type: 'OPAQUE', shape: 'RECTANGULAR', price: 450, stock: 0, sortOrder: 2,
    colors: [
      { name: 'Black', hex: '#151515', stock: 10 },
      { name: 'Red', hex: '#B3141B', stock: 8 },
      { name: 'White', hex: '#F5F5F5', stock: 8 },
    ],
  },
  {
    name: 'Gift Bag', description: 'Ready to hand over', type: 'OPAQUE', shape: 'SQUARE', price: 350, stock: 0, sortOrder: 3,
    colors: [
      { name: 'Black', hex: '#151515', stock: 10 },
      { name: 'White', hex: '#F5F5F5', stock: 10 },
      { name: 'Gold', hex: '#D4AF37', stock: 6 },
    ],
  },
];

const text = (value: string) => "'" + value.replaceAll("'", "''") + "'";

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.log('Seed skipped: NODE_ENV is production.');
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const adapter = await new PrismaPg({ connectionString }).connect();
  try {
    const statements = packaging.flatMap((entry) => [
      `INSERT INTO gift_packaging (id, name, description, type, shape, price, stock, sort_order, updated_at)
       VALUES (gen_random_uuid(), ${text(entry.name)}, ${text(entry.description)}, '${entry.type}', '${entry.shape}',
         ${entry.price}, ${entry.stock}, ${entry.sortOrder}, NOW())
       ON CONFLICT (name) DO NOTHING;`,
      ...entry.colors.map((color, index) =>
        `INSERT INTO gift_packaging_colors (id, packaging_id, name, hex, stock, sort_order, updated_at)
         SELECT gen_random_uuid(), id, ${text(color.name)}, ${text(color.hex)}, ${color.stock}, ${index}, NOW()
         FROM gift_packaging WHERE name = ${text(entry.name)}
         ON CONFLICT (packaging_id, name) DO NOTHING;`),
    ]);
    await adapter.executeScript(statements.join('\n'));
    console.log('Seeded gift packaging (existing rows left untouched).');
  } finally {
    await adapter.dispose();
  }
}

await main();
