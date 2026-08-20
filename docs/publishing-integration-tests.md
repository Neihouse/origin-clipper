# Publishing integration tests

The publishing integration suite exercises real PostgreSQL locking, partial unique indexes,
compare-and-swap transitions, and stale-lease recovery. Unit tests cannot prove those behaviors.

## Safety contract

- Use a dedicated, disposable PostgreSQL database or Neon branch with no application traffic.
- Apply the repository migrations to that disposable database separately, using a direct
  (non-pooler) connection. The test command never creates, migrates, truncates, or drops schema.
- Provide the test connection only as `TEST_DATABASE_URL`. The suite never reads or uses
  `DATABASE_URL` as its connection source.
- The suite inserts uniquely named fixture clips and deletes only those exact fixture IDs with
  cascading child rows. It does not delete pre-existing data.
- The preflight refuses to run if the database already contains due schedules, expired publish
  leases, or eligible/stale Blob-cleanup work that a global worker claim could otherwise mutate.
- No Meta or Vercel Blob request is made. Publishing tests stop at database claims, and cleanup
  tests inject a local delete double.

## Run

```bash
TEST_DATABASE_URL='<disposable-postgres-url>' npm run test:integration
```

A pooled URL is suitable for the test run because it models concurrent application queries.
Use the branch's direct URL only for applying migrations before the run.

The suite covers concurrent scheduled claims, immediate double-click authorization, cancellation
and reschedule races, expired publish-lease reconciliation with partial-platform preservation,
Blob cleanup claim exclusivity/cooldown, and replacement-safe ETag compare-and-swap behavior.
