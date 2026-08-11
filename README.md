# jams.dk

A tiny Cloudflare Worker app for traditional folk musicians: load the front page, get a random accepted tune, watch a YouTube rendition, maybe click through to sheet music, and vote it up or down.

## Stack

- Cloudflare Workers
- D1 (SQLite)
- server-rendered HTML + a little native `<dialog>` JS
- `/kustode` moderator dashboard behind HTTP Basic Auth

No frontend framework, no user accounts, no client-side API layer.

## Data model

- `tunes`
  - `id`
  - `title`
  - `notes`
  - `youtube_identifier`
  - `sheet_music_reference`
  - `submitted_ip`
  - `date_added`
  - `date_accepted` nullable
- `tags`
- `tune_tags` many-to-many join table
- `votes`
  - one row per `(tune_id, visitor_ip)`
  - `value` is `1` or `-1`

## Routes

- `/` — public front page and submission modal
- `POST /submit` — public tune submission
- `POST /vote` — public thumbs up/down
- `/kustode` — moderator queue + tag manager

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local moderator credentials:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Apply D1 migrations locally:

   ```bash
   npx wrangler d1 migrations apply jamsdk --local
   ```

4. Generate Worker typings after config changes:

   ```bash
   npm run types
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

## Deploy

Set the moderator secrets in Cloudflare:

```bash
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASSWORD
```

Apply the remote migration and deploy:

```bash
npx wrangler d1 migrations apply jamsdk --remote
npm run deploy
```

## Moderator flow

1. Open the front page and submit a tune.
2. Visit `/kustode`.
3. Review the submission, edit fields, assign tags, then accept or reject it.
4. Accepted tunes start showing up on `/` immediately.

## Checks

```bash
npm run check
npm test
```

## Notes

- `migrations/0002_tunes.sql` resets the old placeholder schema and creates the real app tables.
- The front page stores votes by visitor IP using `CF-Connecting-IP` (or a local fallback in dev).
