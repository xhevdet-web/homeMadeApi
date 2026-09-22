# HomeMade API

`HomeMadeApi/` is the only backend project root. Run all commands here.
This is an ESM NestJS modular monolith. Feature controllers, services, DTOs,
shared helpers, and the database service are scaffolds, not completed endpoints.

## Structure

```text
HomeMadeApi/
|-- prisma/
|   |-- schema.prisma
|   |-- migrations/
|   `-- seed.ts
|-- src/
|   |-- main.ts
|   |-- app.module.ts
|   |-- app.controller.ts
|   |-- app.controller.spec.ts
|   |-- app.service.ts
|   |-- common/
|   |   |-- decorators/
|   |   |-- guards/
|   |   |-- enums/
|   |   |-- filters/
|   |   |-- interceptors/
|   |   |-- types/
|   |   `-- utils/
|   |-- config/
|   |-- database/
|   `-- modules/
|       |-- auth/                 (dto/, strategies/)
|       |-- users/                (dto/)
|       |-- addresses/            (dto/)
|       |-- products/             (dto/)
|       |-- categories/           (dto/)
|       |-- customization-items/  (dto/)
|       |-- designs/              (dto/, design-pricing.service.ts)
|       |-- design-items/         (dto/)
|       |-- discover/
|       `-- favorites/
|-- test/
|   |-- auth/
|   |-- users/
|   |-- products/
|   |-- designs/
|   `-- app.e2e-spec.ts
|-- .env                         (local, ignored)
|-- .env.example
|-- .gitignore
|-- .dockerignore
|-- .oxlintrc.json
|-- .prettierrc
|-- Dockerfile
|-- docker-compose.yml
|-- nest-cli.json
|-- package.json
|-- pnpm-lock.yaml
|-- prisma.config.ts
|-- tsconfig.json
|-- tsconfig.build.json
|-- vitest.config.ts
|-- vitest.config.e2e.ts
`-- README.md
```

Each business module contains its module, controller, and service. Generated
`node_modules/` and `dist/` stay at the root and are ignored by Git.

## Local development

Use pnpm 10.34.5 (pinned in package.json). Node 24 is used by the Docker image.

```powershell
pnpm install --frozen-lockfile
# Only if .env does not already exist:
Copy-Item .env.example .env
pnpm build
pnpm test
pnpm test:e2e
pnpm start:dev
```

Set DATABASE_URL in the root .env to your Windows PostgreSQL connection for
`homemade_beads`. Keep credentials out of source control. The API loads .env at
startup; existing environment variables take precedence. The starter GET /
returns `Hello World!`. Booting it does not yet establish a database connection.

Docker Compose runs only the API, using the existing Windows PostgreSQL server.
For `docker compose up --build`, set the DATABASE_URL hostname to
`host.docker.internal` in the environment file. Use `localhost` when running
Nest directly on Windows. Docker does not create tables, migrate, or seed.

## Prisma

The CLI and client are pinned to the same version. `prisma.config.ts` points to
`prisma/schema.prisma`, `prisma/migrations`, and `prisma/seed.ts`, and reads the
connection from DATABASE_URL. See the [Prisma configuration reference](https://docs.prisma.io/docs/orm/reference/prisma-config-reference).

```powershell
pnpm prisma:validate
# After domain models and seed logic have been implemented:
pnpm prisma:generate
pnpm prisma:migrate --name initial
pnpm prisma:seed
```

The schema currently configures PostgreSQL and client output only. No models,
migrations, or seed data have been invented during the folder cleanup.
PrismaService still needs the generated client, PostgreSQL adapter, and lifecycle
wiring. No database changes were made as part of restructuring.

## Next implementation phase

- Define User, Address, RefreshToken, Category, Product, ProductImage,
  CustomizationItem, CustomizationItemImage, Design, DesignItem, and Favorite.
  Use UUID external IDs and integer minor units for prices.
- Product types: BRACELET, NECKLACE. Customization item types: BEAD, CHARM,
  LETTER, SPACER, PENDANT. Keep these in the existing modules.
- Designs belong to a user and product. DesignItems reference customization
  items with positionIndex, positionX, positionY, rotation, scale, and quantity.
- Discover queries published/public designs; Favorites joins users and designs.
- Calculate prices on the server using product and customization item prices.
  Never trust a client-provided total.
- Implement JWT access tokens, rotating refresh tokens with hashes in PostgreSQL,
  Argon2id password hashing, CUSTOMER/ADMIN roles, and ownership checks.
  Never persist plaintext passwords or refresh tokens.
- Add class-validator/class-transformer DTO validation and environment validation.
  JWT, Argon2, validation, and database adapter dependencies should be added with
  their implementation. Existing files do not enforce these behaviors yet.
- Implement feature tests. Current tests cover the starter controller only.

No Orders, Payments, Notifications, or Admin module is included.

## Cleanup decisions

The newer nested src/common, src/config, src/database, src/modules, AppModule,
Prisma placeholders, feature test folders, .env, .env.example, Dockerfile, and
.dockerignore were promoted to this root. Identical starter files were compared
and retained once. Root TypeScript build settings and lint configuration were
preserved. Package manifests were reconciled and the root pnpm lockfile updated.

The obsolete nested project, its empty Git repository, duplicate configuration,
and build cache were removed after checking copied files. Placeholder Nest
Observe integration was removed; it had no real credentials. Vitest's unused
path plugin was removed (there are no path aliases). dotenv was added for local
environment loading. Prisma CLI 8 prerelease was aligned with client 7.10.0.

## Cleanup verification

- pnpm install --frozen-lockfile: passed.
- pnpm build: passed.
- TypeScript check including tests and tooling: passed.
- pnpm test: 1 test passed.
- pnpm test:e2e: 1 test passed.
- pnpm lint: passed.
- pnpm prisma:validate: passed.
- Compiled Nest process: booted and GET / returned HTTP 200 / Hello World!.
- Docker image and live PostgreSQL connection were not tested.


## Authentication endpoints

POST /api/v1/auth/login accepts email and password, verifies Argon2id, and returns accessToken, expiresIn (seconds), and a safe user object. GET /api/v1/auth/me verifies a Bearer token and returns safe user fields. Inactive/deleted users and invalid/expired tokens receive 401. Set JWT_ACCESS_SECRET to a cryptographically random secret of at least 32 bytes (JWT_SECRET remains a legacy fallback); no fallback secret is used. Password placeholder rows cannot authenticate. Refresh tokens and server-side logout/revocation are not implemented yet. Other CRUD route authorization remains a separate task.

Registration and user updates now accept optional userName, phone, country, address and postalCode. Username is normalized to lowercase (3?30 letters/digits/dot/underscore/hyphen) and unique. Login accepts { identifier, password } for email or username; { email, password } remains compatible. Safe user and session responses include the new fields.

Reusable JWT guard and configuration: see [authentication documentation](docs/authentication.md). JWT_ACCESS_EXPIRES_IN defaults to 60m. AuthModule exports JwtAuthGuard and JwtStrategy for use by importing feature modules.
