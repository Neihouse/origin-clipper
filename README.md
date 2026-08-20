# origin-clipper

Private weekly marketing-clip pipeline for Primordial Groove's **ORIGIN** Twitch livestreams.

Every Saturday morning, a Vercel Cron job pulls the past week of Twitch clips for the ORIGIN
channel, scores them with a transparent, deterministic ranking (views, recency, duration fit),
and shortlists the top few into a private, password-protected review queue. Each shortlisted
clip gets a proposed caption that documents ORIGIN as a cultural collaboration between
Primordial Groove and Primordial Den. **Nothing is ever posted
automatically** — a human has to explicitly approve or reject each clip from the review queue.

## What this app does *not* do (on purpose)

- No auto-posting. A clip only goes to Instagram/Facebook when an admin clicks **Publish**
  on an approved clip (see "Meta app setup" below for the credentials that step uses) —
  nothing posts on its own.
- No video download or re-encoding — clips are linked/embedded via Twitch's own URLs.
- No public-facing clip gallery. The review queue is private and authenticated.
- No invented engagement metrics — only what Twitch's Helix API actually returns.
- No unrelated Primordial Groove / Den website features. This repo only owns Twitch
  ingestion, ranking, review, and (later) publishing.

These are intentional scope boundaries for v1, not gaps to be quietly filled in later.

## How ranking works

`src/lib/ranking/score.ts` computes a deterministic score from three factual signals:

- **Views** (50% weight) — log-scaled, saturating around 5,000 views so one viral clip
  doesn't dominate every other signal.
- **Recency** (25% weight) — linear decay across the collection window; newer clips score higher.
- **Duration fit** (25% weight) — a clip between 20–45s scores highest (ideal for short-form
  repost), tapering to zero outside 8–60s.

Clips of the same VOD moment (same `video_id`, offsets within 90s) are treated as duplicates
so near-identical clips don't crowd out variety in the top N.

This is **not** a judgment of artistic or musical quality — it's a ranking over the metrics
Twitch exposes. A human still makes the actual creative call in the review queue. See
`src/lib/ranking/score.test.ts` for full coverage of the scoring logic.

## Weekly flow

1. Vercel Cron hits `GET /api/cron/collect-clips` (see [Cron behavior](#cron-behavior) for schedule details).
2. The route verifies the `Authorization: Bearer $CRON_SECRET` header, then calls
   `runWeeklyCollection()`.
3. Clips from the last `COLLECTION_WINDOW_DAYS` days (default 7) are fetched from Twitch Helix
   for the configured broadcaster.
4. Clips are upserted by `twitchClipId` — re-running the job never creates duplicates. Only
   mutable Twitch fields (title, view count, thumbnail, etc.) are refreshed on conflict; a
   clip's review status, score, caption, and approval state are never overwritten.
5. Every clip still awaiting a decision (`discovered` or `shortlisted`) is re-ranked, and the
   top `TOP_CLIP_LIMIT` (default 5) become `shortlisted`. Anything that falls out of the top N
   on a later run drops back to `discovered` — `shortlisted` always reflects the *current* top
   N of the undecided backlog, not a one-time snapshot. Clips already `approved`, `rejected`,
   or `published` are never touched by this step.
6. Each newly shortlisted clip gets a deterministic proposed title/caption framed as an
   ORIGIN field note: the Den as host and Primordial Groove as cultural collaborator
   (`src/lib/caption.ts`).
7. You review everything at `/admin/clips` and approve or reject. Nothing leaves this app
   automatically.
8. Once approved, clicking **Publish** posts the clip to Instagram Reels and the Primordial
   Den Facebook Page (see "Meta app setup" below for the credentials this needs). Each
   platform is tracked and retried independently, so a failure on one never blocks or
   re-posts the other.

## Local setup

```bash
npm install
cp .env.example .env.local
# fill in .env.local — see "Environment variables" below
npm run db:generate   # only needed after schema changes; an initial migration is already included
npm run db:migrate
npm run dev
```

Visit `http://localhost:3000` — it redirects to `/login`, then `/admin/clips` once signed in.

## Twitch app setup

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and register a new
   application (any name; OAuth Redirect URL can be `http://localhost:3000` — this app only
   uses the app-access-token flow, no user redirect happens).
2. Copy the generated **Client ID** → `TWITCH_CLIENT_ID`.
3. Generate a **Client Secret** → `TWITCH_CLIENT_SECRET`.
4. `TWITCH_BROADCASTER_LOGIN` is the channel name as it appears in the URL
   (`twitch.tv/origin` → `origin`).
5. `TWITCH_BROADCASTER_ID` is the numeric user ID behind that login. Look it up with any
   Twitch user-ID lookup tool, or query it yourself once you have an app token:
   ```bash
   curl -s 'https://id.twitch.tv/oauth2/token' \
     -d "client_id=$TWITCH_CLIENT_ID&client_secret=$TWITCH_CLIENT_SECRET&grant_type=client_credentials" \
     | jq -r .access_token
   # then, with that token:
   curl -s 'https://api.twitch.tv/helix/users?login=origin' \
     -H "Client-Id: $TWITCH_CLIENT_ID" \
     -H "Authorization: Bearer <token from above>" | jq
   ```

This app only ever requests an **app access token** (client-credentials grant) — sufficient
for reading public clip data. It never asks ORIGIN's Twitch account to authorize anything.

**If a future version needs to programmatically *create* clips or publish anywhere on
ORIGIN's behalf**, that requires a user-authorization (OAuth) token scoped to the broadcaster's
account instead of an app token, plus a redirect-based auth flow this app does not currently
implement. That is explicitly out of scope for v1 — flagging it here so it isn't a surprise
later.

## Meta app setup

These credentials power the **Publish** button (posting approved clips to Instagram Reels
and a Facebook Page) — the app code is already built and waiting on them; nothing here works
until you provision them. One new **Primordial Den** Facebook Page is the target for both
platforms, where the posts document ORIGIN as a shared cultural practice: the Den hosts the
space and Primordial Groove is the cultural collaborator.

1. Create a new Facebook Page for **Primordial Den** under a Business Portfolio (Meta Business
   Suite → Business Settings → Accounts → Pages → Add) — the same Business Portfolio you'll
   create the Meta App under in step 3.
2. Link Primordial Den's existing Instagram account to that new Page (Instagram app →
   Settings → Account type and tools → linked accounts, or Meta Business Suite → Accounts →
   connect Instagram to the Page).
3. Create the Meta App at the [Meta for Developers console](https://developers.facebook.com/apps/)
   → My Apps → Create App (Business type), linked to that same Business Portfolio.
4. Add the Content Publishing capability / Facebook Login for Business product (exact names
   shift in Meta's dashboard over time).
5. Request permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_business_content_publish` (confirm current names in-dashboard —
   Meta renames these periodically).
6. In App Review → Permissions and Features, check **Standard vs Advanced Access** for each
   permission. Since the Page and Instagram account are owned by the app's own Business
   Portfolio, Standard Access may not require a public App Review submission — confirm this
   live in the dashboard rather than assuming either way.
7. Generate a **long-lived Page access token via a Business Manager System User** (no
   expiration) → `META_PAGE_ACCESS_TOKEN`. This avoids building an OAuth refresh flow entirely.
8. Look up the Page ID and its linked Instagram Business Account ID:
   ```bash
   curl -s "https://graph.facebook.com/v21.0/<page-id>?fields=instagram_business_account" \
     -d "access_token=$META_PAGE_ACCESS_TOKEN" | jq
   ```
   → `META_PAGE_ID` is the Page ID you queried; `META_IG_USER_ID` is the
   `instagram_business_account.id` field in the response.
9. Verify the token via `GET /debug_token` (confirm scopes and that it shows no expiration).
10. Do one manual smoke-test publish via the Graph API Explorer or curl before relying on it.
11. Set `META_PAGE_ID`, `META_IG_USER_ID`, `META_PAGE_ACCESS_TOKEN`, and
    `BLOB_READ_WRITE_TOKEN` (for re-hosting clip video before it's handed to Meta) in Vercel
    Project Settings, same as the existing secrets.

As with the Twitch client secret, treat `META_PAGE_ACCESS_TOKEN` as a real secret — anyone
with it can post to the Page and its linked Instagram account.

## Environment variables

All variables are documented with generation hints in [`.env.example`](.env.example). Summary:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Any standard Postgres connection string (Neon, Supabase, RDS, local). |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch app credentials (see above). |
| `TWITCH_BROADCASTER_LOGIN` / `TWITCH_BROADCASTER_ID` | The ORIGIN channel to collect from. |
| `CRON_SECRET` | Shared secret Vercel Cron sends as `Authorization: Bearer <value>`. Generate with `openssl rand -hex 32`. |
| `ADMIN_PASSWORD_HASH` | scrypt hash of the admin password. Generate with `npm run hash-password -- 'your-password'`. |
| `SESSION_SECRET` | Signs the admin session JWT cookie. Generate with `openssl rand -hex 32`. |
| `COLLECTION_WINDOW_DAYS` | How many trailing days of clips to fetch. Defaults to `7`. |
| `TOP_CLIP_LIMIT` | How many clips stay shortlisted at once. Defaults to `5`. |
| `META_PAGE_ID` | Facebook Page ID for the Primordial Den Page (see "Meta app setup"). |
| `META_IG_USER_ID` | Instagram Business Account ID linked to that Page. |
| `META_PAGE_ACCESS_TOKEN` | Long-lived Page access token from a Business Manager System User. |
| `META_GRAPH_API_VERSION` | Graph API version to call. Defaults to `v21.0`. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token, used to re-host clip video before publishing to Meta. |

### Why custom auth instead of Clerk/Auth0/etc.

There is exactly one account (the owner) and no signup, invite, or multi-tenant flow — a
third-party auth provider would add an external dependency, a network call on every request,
and a vendor account to manage for a single hardcoded password check. Instead:

- `ADMIN_PASSWORD_HASH` is a **scrypt** hash (Node's built-in `crypto.scryptSync`, not bcrypt —
  bcrypt needs a native binary, which is extra friction on Vercel's build image for no real
  benefit here).
- A successful login issues a signed, `httpOnly`/`secure`/`sameSite=lax` JWT session cookie
  (via `jose`), valid for 14 days.
- Every `/admin/:path*` request is checked twice: once in `src/proxy.ts` (Next's routing
  layer, formerly called "middleware") and again inside each Server Action / page via
  `requireSession()` — defense in depth, since proxy alone is an optimistic check, not a
  full authorization boundary.
- Login attempts are rate-limited per client IP (`src/lib/auth/rate-limit.ts`, 10 attempts /
  5 minutes) to blunt password guessing on the one public unauthenticated endpoint. It's an
  in-memory, per-instance limiter — a reasonable bound for a single-admin app without adding a
  paid external store, but it resets on cold start and isn't shared across concurrent
  instances. If that gap ever matters in practice, move it to a shared store (e.g. Upstash via
  the Vercel Marketplace).

If this ever needs real multi-user accounts, swapping in a provider later is a contained
change — it only touches `src/lib/auth/*` and `src/proxy.ts`.

## Cron behavior

`vercel.json` schedules the collector for `0 15 * * 6` — **15:00 UTC every Saturday**.

Vercel Cron schedules are UTC-only and have no daylight-saving awareness. 15:00 UTC is
7:00 AM Pacific during PDT (spring–fall) and 8:00 AM Pacific during PST (winter) — i.e. it
lands in the intended "Saturday morning America/Los_Angeles" window either way, just sliding
by an hour twice a year. If tighter precision is ever needed, that requires either a
timezone-aware scheduler outside Vercel Cron or manually adjusting the cron expression twice a
year — not implemented here as it's unnecessary for a weekly marketing job.

The route itself (`src/app/api/cron/collect-clips/route.ts`) rejects any request whose
`Authorization` header doesn't match `Bearer $CRON_SECRET`, so it's safe to be a public URL —
Vercel sends that header automatically for scheduled invocations, and it should never be
shared elsewhere.

## Approving clips

Sign in at `/login`, then go to `/admin/clips`. Each card shows the thumbnail, an embedded
player link, title, creator, view count, duration, capture date, the ranking score with a
plain-language breakdown, the proposed field-note caption, and **Approve** / **Reject** buttons.
Filter by status (`discovered`, `shortlisted`, `approved`, `rejected`, `published`) with the
tabs at the top. Approving or rejecting is immediate and does not require a second
confirmation step — there is nothing further it triggers (no posting), so this is safe by
design for v1.

The **Collect now** button at the top of the page runs the same collection logic as the
Saturday cron job, on demand, from the browser — no `CRON_SECRET` or terminal needed, just
your existing login session. Useful for an out-of-band pull without waiting for Saturday, or
for re-running after fixing a Twitch/env issue. It shows a live fetched/shortlisted count (or
an error) once it finishes.

## Deployment (Vercel)

1. Push this repo to a **private** GitHub/GitLab/Bitbucket repo and import it in Vercel.
2. Add a Postgres database via the Vercel Marketplace (or bring your own — any Postgres
   connection string works) and set `DATABASE_URL`.
3. Set every other variable from the table above in the Vercel project's Environment
   Variables settings (Production, and Preview if you want preview deploys to work too).
4. Run the migration once against the production database:
   ```bash
   DATABASE_URL="<production connection string>" npm run db:migrate
   ```
5. Deploy. `vercel.json` already declares the weekly cron — no extra dashboard configuration
   needed, but confirm it appears under the project's Cron Jobs tab after the first deploy.
6. Visit `/login` on the deployed URL and sign in with the password behind
   `ADMIN_PASSWORD_HASH`.

The app sets `robots: { index: false, follow: false }` and the review queue is fully
authenticated, but there is no IP allowlisting — treat the admin password and `SESSION_SECRET`
/ `CRON_SECRET` as real secrets (Vercel env vars, never committed, never logged).

## What's deferred beyond v1

- Automatic publishing to any social platform (Instagram, TikTok, X, etc.) once approved.
- Any video download, clipping, re-encoding, or captioning of the video itself.
- A public gallery or embed feed of approved clips.
- Multi-user accounts / roles.
- Twitch user-authorization (OAuth) flow, needed only if a future version wants to create
  clips or publish through Twitch itself on ORIGIN's behalf.

## Tests

```bash
npm run test        # vitest run — ranking logic is fully unit-tested
npm run typecheck
npm run lint
npm run build
```

Only the pure ranking/caption logic has automated tests; DB-touching code (the collector,
Server Actions) is not unit-tested in v1 since there's no test database wired up in this
environment — verify those manually against a real `DATABASE_URL` before relying on them in
production.
