-- Persist Stripe's subscription lifecycle so Pro access survives a scheduled cancellation
-- until the end of the period the customer already paid for.
alter table public.profiles
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text,
  add column if not exists subscription_current_period_end timestamptz,
  add column if not exists subscription_cancel_at_period_end boolean not null default false;

create unique index if not exists idx_profiles_stripe_subscription_id
  on public.profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;
