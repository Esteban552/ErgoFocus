-- =============================================================================
-- Migration: Soporte de Soft Delete para perfiles de usuario
-- =============================================================================

-- 1. Agregar columna deleted_at a profiles si no existe
alter table public.profiles
  add column if not exists deleted_at timestamptz default null;

-- 2. Índice para consultas y filtros de usuarios activos
create index if not exists idx_profiles_deleted_at
  on public.profiles (deleted_at)
  where deleted_at is null;

-- 3. Actualizar política de lectura de perfil para ignorar usuarios eliminados
drop policy if exists "profiles: leer el propio perfil" on public.profiles;
create policy "profiles: leer el propio perfil"
  on public.profiles for select
  using ((select auth.uid()) = user_id and deleted_at is null);

-- 4. Actualizar políticas de sensor_daily para ignorar usuarios con soft-delete
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
