# origin-clipper

Private weekly marketing-clip pipeline for Primordial Groove's **ORIGIN** Twitch livestreams.

Every Saturday morning, a Vercel Cron job pulls the past week of Twitch clips for the ORIGIN
channel, scores them with a transparent, deterministic ranking (views, recency, duration fit),
and shortlists the top few into a private, password-protected review queue. Each shortlisted
clip gets a proposed field-note caption naming ORIGIN as a Primordial Groove weekly held at
Primordial Den. **Nothing is posted without a human decision** — an
admin approves the exact clip and then explicitly chooses either **Publish now** or
**Schedule Publish** for one future time. Scheduling is a one-clip, one-time authorization;
it is not permission for the system to choose future content.

## What this app does *not* do (on purpose)

- No unreviewed or standing auto-posting. The worker can deliver only a specific approved
  clip with a persisted **Schedule Publish** authorization. It never selects, approves, or
  schedules content on its own.
- No permanent local video archive or re-encoding. One approved clip is fetched and re-hosted
  only when publishing begins, then reused across safe retries for that same post.
- No public-facing clip gallery. The review queue is private and authenticated.
- No invented engagement metrics — only what Twitch's Helix API actually returns.
- No unrelated Primordial Groove / Den website features. This repo only owns Twitch
  ingestion, ranking, review, and publishing.

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
   ORIGIN field note: recorded at Primordial Den, with ORIGIN named as a Primordial Groove
   weekly held at the Den (`src/lib/caption.ts`).
7. You review everything at `/admin/clips` and approve or reject. Approval alone never sends
   anything to Meta.
8. Once approved, the operator either clicks **Publish now** or chooses a Pacific date/time
   and clicks **Schedule Publish**. The latter records one future authorization.
9. The scheduled worker claims only due, explicitly authorized rows. Instagram and Facebook
   are tracked independently, so a confirmed success is never reposted during a retry.
10. After Instagram publishes, the operator invites `@primordialgroove` as a collaborator in
    Instagram and records whether the invitation is pending or accepted. Once both platform
    posts are live, the operator opens them and marks publishing verified.

## Scheduled publishing and weekly cadence

The admin queue includes a compact four-week calendar. Schedule controls use **Pacific time
(`America/Los_Angeles`)** and convert the chosen wall-clock time to an explicit UTC instant
before it reaches the server. A publish must be at least five minutes ahead and no more than
28 days away. Daylight-saving times that do not exist or occur twice are rejected rather than
silently shifted.

The private queue summarizes cadence health without making editorial decisions: upcoming
scheduled posts in the next 28 days, the next due time, the approved-but-unscheduled buffer,
overdue/failed/manual-review work, incomplete collaborator/verification follow-up, and failed
temporary-media cleanup. It warns when no post is due within seven days or the buffer drops
below four. Those thresholds are planning prompts, not an instruction to publish filler or a
fixed weekday. The attention/upcoming list is capped at 50 rows and reports how many additional
records are outside the bounded view.

Publishing history is append-only at the authorization level. `clip_publications` holds the
durable per-clip delivery result, while each **Publish now**, **Schedule Publish**, reschedule,
or retry creates a separate `publication_attempts` audit row. Cards and cadence health read
the latest attempt rather than rewriting or accidentally counting older failed attempts.

- Run a six-week pilot with one guaranteed ORIGIN field note per week.
- During weekly review, choose one primary clip and one backup. The app never makes that
  editorial choice.
- Keep four approved, publishable clips in reserve; add a second weekly post only when that
  buffer remains healthy.
- Schedule the primary in a consistent slot. A scheduled item can be rescheduled or cancelled
  until the worker claims it; while claimed, those controls lock.
- A clear `failed` result is safe to retry without reposting a platform that already succeeded.
  An ambiguous response enters `manual_review` and stays locked until an operator inspects the
  real Instagram/Facebook profiles and records whether a post exists. A claimed published
  result requires the numeric Meta ID; the server reads that object back from Meta and changes
  no state if the ID cannot be verified.
- The Instagram collaborator invitation remains manual. Publishing from Primordial Den and
  inviting Primordial Groove communicates the PG ↔ Den relationship through the two accounts;
  the caption stays documentary rather than promotional.

At the end of six weeks, review delivery reliability, clip-buffer health, completion/watch
behavior, shares, and saves. Change the slot—or increase frequency—only from that evidence.

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

These credentials power **Publish now** and the explicitly authorized scheduled worker,
posting approved clips to Instagram Reels and a Facebook Page. One **Primordial Den** Facebook
Page is the target for both platforms. After Instagram publishes, an operator manually invites
`@primordialgroove` as collaborator; the Graph API publish step does not automate that invitation.

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
| `VIDEO_ASSET_RETENTION_DAYS` | Days to retain a verified post's temporary Blob asset before cleanup. Integer `1`–`30`; defaults to `7`. |

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

`vercel.json` schedules three authenticated jobs:

- `/api/cron/collect-clips` at `0 15 * * 6` — **15:00 UTC every Saturday**.
- `/api/cron/publish-scheduled` at `*/15 * * * *` — every 15 minutes, to claim due,
  explicitly authorized publishes.
- `/api/cron/cleanup-assets` at `17 11 * * *` — **11:17 UTC daily**, to remove eligible
  temporary Blob assets after the configured retention period.

Vercel Cron schedules are UTC-only and have no daylight-saving awareness. 15:00 UTC is
7:00 AM Pacific during PDT (spring–fall) and 8:00 AM Pacific during PST (winter) — i.e. it
lands in the intended "Saturday morning America/Los_Angeles" window either way, just sliding
by an hour twice a year. If tighter precision is ever needed, that requires either a
timezone-aware scheduler outside Vercel Cron or manually adjusting the cron expression twice a
year — not implemented here as it's unnecessary for a weekly marketing job.

All three routes reject requests whose `Authorization` header does not match
`Bearer $CRON_SECRET`, so they are safe to expose as cron endpoints. Vercel sends that header
for scheduled invocations, and it should never be shared elsewhere. The chosen publish time
is an eligibility boundary, not an exact delivery guarantee: the worker normally starts it on
the next 15-minute run.

The due-publish worker does not assume cron delivery is exactly once. Vercel can overlap or
duplicate invocations and does not automatically retry a failed invocation, so each run claims
a small bounded batch with an atomic database update, unique claim token, and expiring lease.
Two workers cannot validly publish the same row. If a claim expires after an outbound Meta
request, it is never replayed automatically: the row fails closed into `manual_review` because
the public post may exist even if the response was lost. The next operator resolves that state
from the actual Instagram/Facebook profiles before creating any new authorization.

Asset cleanup is deliberately downstream of human verification. A Blob becomes eligible only
after Instagram and Facebook are both published, the operator has marked publishing verified,
`VIDEO_ASSET_RETENTION_DAYS` has elapsed, and no active publication attempt can still need the
asset. Cleanup claims use a lease, and deletion sends the stored Blob ETag as `ifMatch`, so a
replacement at the same URL cannot be deleted by a stale claim. The stored asset URL/ETag are
cleared only after deletion succeeds; failures cool down and retry on a later daily run.

## Approving clips

Sign in at `/login`, then go to `/admin/clips`. Each card shows the thumbnail, an embedded
player link, title, creator, view count, duration, capture date, the ranking score with a
plain-language breakdown, the proposed field-note caption, and **Approve** / **Reject** buttons.
Filter by status (`discovered`, `shortlisted`, `approved`, `rejected`, `published`) with the
tabs at the top. Approving or rejecting is immediate and does not require a second
confirmation step — there is nothing further it triggers (no posting), so this is safe by
design. An approved card then offers two separate actions:

- **Publish now** starts one guarded Instagram/Facebook attempt immediately.
- **Schedule Publish** authorizes that exact approved clip and stored caption once. It becomes
  eligible at the selected Pacific time and normally starts on the next 15-minute worker run.
  The date may be changed or cancelled until the worker claims it.

Scheduled, processing, failed, overdue, and manual-review states remain visible on the card
and detail page. A failed result is retryable; `manual_review` is deliberately not. For manual
review, inspect the real profiles and record whether the post exists before the app unlocks a
retry. Once Instagram is live, use the checklist to record the collaborator invitation as
pending/accepted. **Mark publishing verified** stays unavailable until both platforms have
confirmed success and still means a person actually inspected both posts.

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
5. Deploy. `vercel.json` declares the collection, due-publish, and verified-asset-cleanup crons —
   no extra dashboard configuration is needed, but confirm all three appear under the project's
   Cron Jobs tab after the first deploy.
6. Visit `/login` on the deployed URL and sign in with the password behind
   `ADMIN_PASSWORD_HASH`.

The app sets `robots: { index: false, follow: false }` and the review queue is fully
authenticated, but there is no IP allowlisting — treat the admin password and `SESSION_SECRET`
/ `CRON_SECRET` as real secrets (Vercel env vars, never committed, never logged).

## What's deferred beyond v1

- Adding another outbound platform (TikTok, YouTube Shorts, X, etc.).
- A permanent video archive, clipping, re-encoding, or captioning of the video itself.
- A public gallery or embed feed of approved clips.
- Multi-user accounts / roles.
- Twitch user-authorization (OAuth) flow, needed only if a future version wants to create
  clips or publish through Twitch itself on ORIGIN's behalf.

## Tests

```bash
npm run test        # Vitest: ranking, caption, time, policy, cron, and auth-boundary coverage
npm run test:integration # Real PostgreSQL locking/claim tests; requires TEST_DATABASE_URL
npm run typecheck
npm run lint
npm run build
```

Pure ranking, caption, Pacific-time conversion, publishing policy, route authentication, and
platform request behavior have automated tests. The opt-in integration suite verifies real
PostgreSQL claims, partial unique indexes, concurrent workers, stale leases, and ETag-safe Blob
cleanup against a dedicated disposable database or Neon branch. It never uses `DATABASE_URL`
and makes no Meta or Blob request. Follow [the integration-test safety and setup guide](docs/publishing-integration-tests.md)
before running it. Never use the public accounts for an unapproved smoke test.
