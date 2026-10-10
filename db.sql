-- =============================================================================
-- Supabase database script (ErgoFocus)
-- Deployed and managed via Supabase MCP
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- One profile per auth user. `role` drives the Pro plan (updated by Stripe webhook).
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  role               text not null default 'free' check (role in ('free', 'pro')),
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  subscription_current_period_end timestamptz,
  subscription_cancel_at_period_end boolean not null default false,
  deleted_at         timestamptz default null,
  updated_at         timestamptz not null default now()
);

-- Expo push tokens, one row per device token.
create table if not exists public.push_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Sensor history sync (daily aggregates only, Pro plan)
create table if not exists public.sensor_daily (
  user_id      uuid not null references auth.users(id) on delete cascade,
  sensor       text not null check (sensor in ('light', 'sound', 'movement', 'gyro')),
  day          date not null,                       -- local day of the device
  avg          double precision not null,
  sample_count integer not null check (sample_count > 0),
  updated_at   timestamptz not null default now(),
  primary key (user_id, sensor, day)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

create index if not exists idx_push_tokens_user_id on public.push_tokens (user_id);
create index if not exists idx_profiles_stripe_customer_id
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;
create unique index if not exists idx_profiles_stripe_subscription_id
  on public.profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;
create index if not exists idx_profiles_deleted_at
  on public.profiles (deleted_at)
  where deleted_at is null;
create index if not exists idx_sensor_daily_user_day
  on public.sensor_daily (user_id, day desc);

-- -----------------------------------------------------------------------------
-- Automatic Profile Provisioning
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id, role)
  values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Revoke public execution to satisfy security advisor
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles    enable row level security;
alter table public.push_tokens enable row level security;
alter table public.sensor_daily enable row level security;

-- Profiles: users can only read their own row (if not soft-deleted).
drop policy if exists "profiles: leer el propio perfil" on public.profiles;
create policy "profiles: leer el propio perfil"
  on public.profiles for select
  using ((select auth.uid()) = user_id and deleted_at is null);

-- Push tokens: users manage only their own tokens.
drop policy if exists "push_tokens: leer los propios tokens" on public.push_tokens;
create policy "push_tokens: leer los propios tokens"
  on public.push_tokens for select
  using ((select auth.uid()) = user_id);

drop policy if exists "push_tokens: crear el propio token" on public.push_tokens;
create policy "push_tokens: crear el propio token"
  on public.push_tokens for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "push_tokens: actualizar el propio token" on public.push_tokens;
create policy "push_tokens: actualizar el propio token"
  on public.push_tokens for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "push_tokens: borrar los propios tokens" on public.push_tokens;
create policy "push_tokens: borrar los propios tokens"
  on public.push_tokens for delete
  using ((select auth.uid()) = user_id);

-- Sensor daily: users read/delete own rows; insert/update restricted to Pro plan.
drop policy if exists "sensor_daily: leer los propios datos" on public.sensor_daily;
create policy "sensor_daily: leer los propios datos"
  on public.sensor_daily for select
  using (
    (select auth.uid()) = user_id
    and not exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.deleted_at is not null
    )
  );

drop policy if exists "sensor_daily: crear datos (solo Pro)" on public.sensor_daily;
create policy "sensor_daily: crear datos (solo Pro)"
  on public.sensor_daily for insert
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.role = 'pro' and p.deleted_at is null
    )
  );

drop policy if exists "sensor_daily: actualizar datos (solo Pro)" on public.sensor_daily;
create policy "sensor_daily: actualizar datos (solo Pro)"
  on public.sensor_daily for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.role = 'pro' and p.deleted_at is null
    )
  );

drop policy if exists "sensor_daily: borrar los propios datos" on public.sensor_daily;
create policy "sensor_daily: borrar los propios datos"
  on public.sensor_daily for delete
  using ((select auth.uid()) = user_id);
