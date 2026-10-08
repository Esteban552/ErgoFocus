# Sensor history sync

## Principle

Offline-first. Raw readings stay on the device; only **daily aggregates** go to the cloud, and only for **Pro** users who opt in.

| Layer | Table | Content | Leaves the device? |
|-------|-------|---------|--------------------|
| Local SQLite (`src/db/database.ts`) | `sensor_logs` | Every reading (`sensor`, `value`, `created_at`) | No |
| Supabase Postgres (`db.sql`) | `sensor_daily` | One row per `(user_id, sensor, day)` with `avg` and `sample_count` | Yes, Pro + opt-in |

## Why aggregates

- **Volume:** a few rows per user per day instead of thousands.
- **Privacy:** habits cannot be reconstructed minute by minute.
- **Idempotency:** the primary key `(user_id, sensor, day)` makes re-syncing safe. An `upsert` overwrites the day, so there are no duplicates, retries are harmless, and no client-generated id is needed.
- **Fit with the app:** `getSensorReadingsByDay` in `src/db/repos.ts` already computes per-day averages.

## Data flow

1. The app logs readings into `sensor_logs` (`logSensor`).
2. If the user is Pro and has enabled sync, a sync job runs (app foreground, or once per day):
   1. Read the local readings for the days not yet synced (or the last N days).
   2. Group by local day and sensor and compute `avg` and `sample_count`.
   3. `upsert` into `sensor_daily` with `onConflict: 'user_id,sensor,day'`.
3. On a new device, the app does a `select` from `sensor_daily` to restore history (read-only charts; raw data is not recoverable).

```ts
// Sketch of the client call
await supabase.from('sensor_daily').upsert(
  rows.map(r => ({
    user_id: userId,
    sensor: r.sensor,
    day: r.dayKey,            // 'YYYY-MM-DD', local day
    avg: r.avg,
    sample_count: r.count,
    updated_at: new Date().toISOString(),
  })),
  { onConflict: 'user_id,sensor,day' }
);
```

> `getSensorReadingsByDay` does not return the sample count today. It must be extended to return `count`, since `sample_count` is required.

## Access rules (RLS)

- **Select / delete:** the user's own rows only (`auth.uid() = user_id`).
- **Insert / update:** own rows **and** `profiles.role = 'pro'`. The Pro check lives in the database, so a modified client cannot bypass it.
- A user who downgrades keeps their history, can read and delete it, but cannot write new rows.
- Account deletion cascades through `auth.users` (`on delete cascade`).

## Rules for the sync job

- Always use the **device's local day** for `day`. Two devices in different time zones may disagree on boundary days.
- Only sync **closed days** plus today (today is overwritten on each sync).
- If two devices sync the same day, the last write wins. Acceptable for averages, but it is a known limitation (see gaps).
- Failures must never block the UI: retry on next launch.

## Retention

No automatic retention is defined yet. Suggested: keep 12–24 months, with a scheduled job (`pg_cron`) deleting older rows.

---

# Areas not covered by this database design

Open points found while reviewing the project.

## Data and schema

1. **No automatic profile creation.** `profiles` rows are created only by the Stripe webhook. A user who never paid has no row. `getProfileRole` masks this by returning `'free'`. Recommended: a trigger on `auth.users` that inserts a `free` profile.
2. **`updated_at` is not maintained by the database.** Only the webhook sets it. Use a `moddatetime`-style trigger.
3. **No user consent record.** Nothing stores that the user opted in to cloud sync, or when. Needed for GDPR-style compliance.
4. **No `subscriptions` table.** Subscription status, plan, period end and cancellation live only in Stripe. The app only knows `free` or `pro`, so cancel-at-period-end, failed payments, and trials are not modeled.
5. **Multi-device conflicts in `sensor_daily`.** Last write wins. Merging by weighted average using `sample_count` would be more correct, and needs an RPC function rather than a plain upsert.
6. **Local schema has no migrations.** `src/db/database.ts` uses `CREATE TABLE IF NOT EXISTS`. Any future column change will break existing installs without a `user_version` migration scheme.
7. **Local `sensor_logs` grows forever.** There is no pruning of old readings.
8. **Only the Supabase side is versioned.** `db.sql` and the migration file can drift. Pick one source of truth, ideally migrations, and generate `db.sql` from it.

## Payments and webhooks

9. **No webhook idempotency.** Stripe retries events. A `stripe_events(id primary key)` table would prevent double processing and out-of-order issues.
10. **`customer.subscription.deleted` depends on `subscription.metadata.user_id`.** If that metadata is not set when the subscription is created, the user stays Pro forever. A fallback lookup by `stripe_customer_id` is possible (hence the index added in `db.sql`), but the code does not do it yet.
11. **Other Stripe events are ignored:** `invoice.payment_failed`, `customer.subscription.updated`.

## Push notifications

12. **`send-push` is deployed with `--no-verify-jwt` and has no authentication.** Anyone who knows the URL can send notifications to any `user_id`. This is the most serious gap. It needs a shared secret or service-only access.
13. **Stale tokens are never cleaned.** Expo returns `DeviceNotRegistered` receipts, but the function ignores the response and never deletes dead tokens.
14. **A token can move between users on the same device** (logout/login as another user). The update policy only allows changing rows you already own, so the second user's `upsert` on an existing token can fail. Handle this with a security-definer RPC or by deleting the token at logout.
15. **No notification preferences** (opt-out, quiet hours, categories).

## Security and operations

16. **No explicit grants review.** Confirm that `anon` and `authenticated` have only the table privileges you expect, besides RLS.
17. **No rate limiting** on `sensor_daily` upserts or token registration.
18. **No backups or restore plan documented**, and no separation between dev and prod projects (the `.env` points to a single project).
19. **`.env` is present in the repository folder.** Check that it is gitignored and that no `service_role` key ended up in client code.
20. **Account deletion is partial.** Supabase data is removed via cascade, but local SQLite cleanup (`deleteLocalUserData`) relies on the app being online and running. Stripe customer and subscription are not cancelled or deleted by `delete-account`.

## Suggested priority

1. `send-push` authentication (security).
2. `subscription.deleted` fallback by `stripe_customer_id` (billing correctness).
3. Profile auto-creation trigger and webhook idempotency.
4. Consent record before enabling `sensor_daily` sync.
5. Local migration scheme and retention.
