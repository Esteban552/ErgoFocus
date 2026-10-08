-- Migration: profiles, push_tokens, sensor_daily and auth trigger
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  role               text not null default 'free' check (role in ('free', 'pro')),
  stripe_customer_id text,
  updated_at         timestamptz not null default now()
);

create table if not exists public.push_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.sensor_daily (
  user_id      uuid not null references auth.users(id) on delete cascade,
  sensor       text not null check (sensor in ('light', 'sound', 'movement', 'gyro')),
  day          date not null,
  avg          double precision not null,
  sample_count integer not null check (sample_count > 0),
  updated_at   timestamptz not null default now(),
  primary key (user_id, sensor, day)
);

create index if not exists idx_push_tokens_user_id on public.push_tokens (user_id);
create index if not exists idx_profiles_stripe_customer_id
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists idx_sensor_daily_user_day
  on public.sensor_daily (user_id, day desc);

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

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles    enable row level security;
alter table public.push_tokens enable row level security;
alter table public.sensor_daily enable row level security;

create policy "profiles: leer el propio perfil"
  on public.profiles for select
  using ((select auth.uid()) = user_id);

create policy "push_tokens: leer los propios tokens"
  on public.push_tokens for select
  using ((select auth.uid()) = user_id);

create policy "push_tokens: crear el propio token"
  on public.push_tokens for insert
  with check ((select auth.uid()) = user_id);

create policy "push_tokens: actualizar el propio token"
  on public.push_tokens for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "push_tokens: borrar los propios tokens"
  on public.push_tokens for delete
  using ((select auth.uid()) = user_id);

create policy "sensor_daily: leer los propios datos"
  on public.sensor_daily for select
  using ((select auth.uid()) = user_id);

create policy "sensor_daily: crear datos (solo Pro)"
  on public.sensor_daily for insert
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.role = 'pro'
    )
  );

create policy "sensor_daily: actualizar datos (solo Pro)"
  on public.sensor_daily for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = (select auth.uid()) and p.role = 'pro'
    )
  );

create policy "sensor_daily: borrar los propios datos"
  on public.sensor_daily for delete
  using ((select auth.uid()) = user_id);