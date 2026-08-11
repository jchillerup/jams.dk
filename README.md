# D1 notes

Tiny Cloudflare Worker app in TypeScript. Think “Flask, but on Workers”: one file, server-rendered HTML, D1 for storage, no frontend framework.

## What you got

- `src/index.ts` — Worker app
- `migrations/0001_notes.sql` — example D1 schema
- HTTP Basic Auth in front of the UI
- a tiny note list/create/delete UI

If your real schema is different, keep the setup and swap the SQL in `src/index.ts` + `migrations/0001_notes.sql`.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Put your D1 details into `wrangler.toml`:

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "your-d1-name"
   database_id = "your-d1-id"
   ```

3. Create local auth vars:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

4. Apply the migration:

   ```bash
   npx wrangler d1 migrations apply your-d1-name --local
   npx wrangler d1 migrations apply your-d1-name --remote
   ```

5. Run it locally:

   ```bash
   npm run dev
   ```

## Deploy

Set the auth secrets in Cloudflare:

```bash
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASSWORD
```

Then deploy:

```bash
npm run deploy
```

## Auto deploy from GitHub

This repo includes `.github/workflows/deploy.yml`.
On every push to `main`, GitHub Actions will:

1. `npm ci`
2. run `npm run check`
3. run `npm test`
4. apply remote D1 migrations
5. deploy the Worker

Add these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Your Cloudflare API token needs permission to deploy Workers and apply D1 migrations.

## Checks

```bash
npm run check
npm test
```
