-- ============================================================================
-- Lana — schema
-- Run this once in the Supabase SQL editor against a fresh project.
-- Safe to re-run: every object is created if-not-exists or replaced.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('agent', 'admin', 'dialer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type product_category as enum ('ancillary', 'mapd', 'combined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type submission_status as enum ('pending', 'approved', 'rejected', 'chargeback');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        user_role not null default 'agent',
  team_id     uuid references public.teams (id) on delete set null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  carrier     text not null default '',
  category    product_category not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (name, carrier)
);

create table if not exists public.submissions (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references public.profiles (id) on delete cascade,
  product_id     uuid references public.products (id) on delete set null,
  category       product_category not null,
  client_name    text not null,
  policy_number  text not null default '',
  carrier        text not null default '',
  ap_amount      numeric(12, 2) not null check (ap_amount >= 0),
  status         submission_status not null default 'pending',
  submitted_on   date not null default (now() at time zone 'America/Chicago')::date,
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  created_by     uuid not null references public.profiles (id) on delete cascade,
  decided_at     timestamptz,
  decided_by     uuid references public.profiles (id) on delete set null
);

-- Monthly AP target per agent. Drives the Pace metric.
create table if not exists public.goals (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references public.profiles (id) on delete cascade,
  period      date not null,                      -- always the 1st of the month
  target_ap   numeric(12, 2) not null check (target_ap >= 0),
  created_at  timestamptz not null default now(),
  unique (agent_id, period)
);

create index if not exists submissions_agent_date_idx  on public.submissions (agent_id, submitted_on desc);
create index if not exists submissions_date_idx        on public.submissions (submitted_on desc);
create index if not exists submissions_status_idx      on public.submissions (status);
create index if not exists profiles_role_idx           on public.profiles (role) where active;


-- ---------------------------------------------------------------------------
-- Helpers
--
-- is_admin() is SECURITY DEFINER on purpose. A policy on `profiles` that
-- reads `profiles` to check the caller's role recurses infinitely and Postgres
-- aborts the query. Reading the role through a definer function bypasses RLS
-- for that one lookup and breaks the cycle.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

create or replace function public.my_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Business days (Mon-Fri) between two dates, inclusive. Used for Pace.
create or replace function public.business_days(p_start date, p_end date)
returns integer
language sql
immutable
as $$
  select count(*)::int
  from generate_series(p_start, p_end, interval '1 day') d
  where extract(isodow from d) < 6;
$$;


-- ---------------------------------------------------------------------------
-- New-user trigger: every auth user gets a profile row.
-- First user to ever sign up becomes admin so you are not locked out of a
-- fresh install; everyone after defaults to agent.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_first boolean;
begin
  select not exists (select 1 from public.profiles) into is_first;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when is_first then 'admin'::user_role else 'agent'::user_role end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.teams       enable row level security;
alter table public.profiles    enable row level security;
alter table public.products    enable row level security;
alter table public.submissions enable row level security;
alter table public.goals       enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;
drop policy if exists profiles_write_admin  on public.profiles;

create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

create policy profiles_select_admin on public.profiles
  for select using (public.is_admin());

-- An agent may rename themselves but may not change their own role or team.
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from public.profiles p where p.id = auth.uid())
    and active = (select active from public.profiles p where p.id = auth.uid())
  );

create policy profiles_write_admin on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- teams ---------------------------------------------------------------------
drop policy if exists teams_read      on public.teams;
drop policy if exists teams_write_admin on public.teams;

create policy teams_read on public.teams
  for select to authenticated using (true);

create policy teams_write_admin on public.teams
  for all using (public.is_admin()) with check (public.is_admin());

-- products ------------------------------------------------------------------
drop policy if exists products_read       on public.products;
drop policy if exists products_write_admin on public.products;

create policy products_read on public.products
  for select to authenticated using (true);

create policy products_write_admin on public.products
  for all using (public.is_admin()) with check (public.is_admin());

-- submissions ---------------------------------------------------------------
drop policy if exists submissions_select_own   on public.submissions;
drop policy if exists submissions_select_admin on public.submissions;
drop policy if exists submissions_insert_own   on public.submissions;
drop policy if exists submissions_update_own   on public.submissions;
drop policy if exists submissions_write_admin  on public.submissions;

create policy submissions_select_own on public.submissions
  for select using (agent_id = auth.uid());

create policy submissions_select_admin on public.submissions
  for select using (public.is_admin());

-- Agents log their own sales, always as pending. Only an admin decides status.
create policy submissions_insert_own on public.submissions
  for insert with check (
    agent_id = auth.uid()
    and created_by = auth.uid()
    and status = 'pending'
  );

-- Agents may correct a submission only while it is still pending.
create policy submissions_update_own on public.submissions
  for update using (agent_id = auth.uid() and status = 'pending')
  with check (agent_id = auth.uid() and status = 'pending');

create policy submissions_write_admin on public.submissions
  for all using (public.is_admin()) with check (public.is_admin());

-- goals ---------------------------------------------------------------------
drop policy if exists goals_select_own  on public.goals;
drop policy if exists goals_write_admin on public.goals;

create policy goals_select_own on public.goals
  for select using (agent_id = auth.uid());

create policy goals_write_admin on public.goals
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- RPCs
--
-- The leaderboard has to show every agent's totals to every agent, but agents
-- must not be able to read each other's raw submission rows. So it is exposed
-- as a SECURITY DEFINER function returning aggregates only — never the
-- underlying records.
-- ---------------------------------------------------------------------------
create or replace function public.leaderboard(
  p_start    date,
  p_end      date,
  p_category text default null
)
returns table (
  agent_id         uuid,
  full_name        text,
  team_name        text,
  total_ap         numeric,
  submission_count bigint,
  rank             bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select s.agent_id, s.ap_amount
    from public.submissions s
    where s.submitted_on between p_start and p_end
      and s.status in ('pending', 'approved')
      and (p_category is null or s.category = p_category::product_category)
  ),
  totals as (
    select
      p.id                                as agent_id,
      p.full_name,
      coalesce(t.name, '—')               as team_name,
      coalesce(sum(sc.ap_amount), 0)      as total_ap,
      count(sc.*)                         as submission_count
    from public.profiles p
    left join public.teams t on t.id = p.team_id
    left join scoped sc      on sc.agent_id = p.id
    where p.active and p.role in ('agent', 'admin')
    group by p.id, p.full_name, t.name
  )
  select
    agent_id, full_name, team_name, total_ap, submission_count,
    rank() over (order by total_ap desc) as rank
  from totals
  order by total_ap desc, full_name asc;
$$;

-- Daily AP / Month AP / Pace for the calling agent.
--
-- Pace projects the month-end total from business days elapsed, not calendar
-- days — a month is 20-23 selling days and calendar-day math understates pace
-- every weekend.
create or replace function public.my_metrics()
returns table (
  daily_ap          numeric,
  month_ap          numeric,
  pace              numeric,
  target_ap         numeric,
  days_elapsed      integer,
  days_in_month     integer,
  month_count       bigint,
  pending_count     bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      (now() at time zone 'America/Chicago')::date                      as today,
      date_trunc('month', (now() at time zone 'America/Chicago'))::date as month_start,
      (date_trunc('month', (now() at time zone 'America/Chicago'))
        + interval '1 month - 1 day')::date                             as month_end
  ),
  mine as (
    select s.*, b.today, b.month_start, b.month_end
    from public.submissions s
    cross join bounds b
    where s.agent_id = auth.uid()
      and s.status in ('pending', 'approved')
      and s.submitted_on between b.month_start and b.month_end
  ),
  agg as (
    select
      coalesce(sum(ap_amount) filter (where submitted_on = today), 0) as daily_ap,
      coalesce(sum(ap_amount), 0)                                     as month_ap,
      count(*)                                                        as month_count
    from mine
  ),
  days as (
    select
      public.business_days(month_start, least(today, month_end)) as elapsed,
      public.business_days(month_start, month_end)               as total
    from bounds
  )
  select
    agg.daily_ap,
    agg.month_ap,
    case when days.elapsed > 0
      then round(agg.month_ap / days.elapsed * days.total, 2)
      else 0
    end as pace,
    coalesce((
      select g.target_ap from public.goals g, bounds b
      where g.agent_id = auth.uid() and g.period = b.month_start
    ), 0) as target_ap,
    days.elapsed,
    days.total,
    agg.month_count,
    (select count(*) from public.submissions
      where agent_id = auth.uid() and status = 'pending') as pending_count
  from agg, days;
$$;

-- Admin rollup: totals by agent, by category, and by status for a date range.
create or replace function public.admin_report(p_start date, p_end date)
returns table (
  bucket   text,
  label    text,
  total_ap numeric,
  cnt      bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select 'category'::text, s.category::text,
           coalesce(sum(s.ap_amount), 0), count(*)
    from public.submissions s
    where s.submitted_on between p_start and p_end and public.is_admin()
    group by s.category

    union all

    select 'status'::text, s.status::text,
           coalesce(sum(s.ap_amount), 0), count(*)
    from public.submissions s
    where s.submitted_on between p_start and p_end and public.is_admin()
    group by s.status

    union all

    select 'team'::text, coalesce(t.name, '— unassigned —'),
           coalesce(sum(s.ap_amount), 0), count(*)
    from public.submissions s
    join public.profiles p on p.id = s.agent_id
    left join public.teams t on t.id = p.team_id
    where s.submitted_on between p_start and p_end and public.is_admin()
    group by t.name
  ) x (bucket, label, total_ap, cnt)
  order by bucket, total_ap desc;
$$;

grant execute on function public.leaderboard(date, date, text) to authenticated;
grant execute on function public.my_metrics()                  to authenticated;
grant execute on function public.admin_report(date, date)      to authenticated;


-- ---------------------------------------------------------------------------
-- Seed: a starter product list. Edit freely in the admin portal afterwards.
-- ---------------------------------------------------------------------------
insert into public.products (name, carrier, category) values
  ('Medicare Advantage',         'UnitedHealthcare', 'mapd'),
  ('Medicare Advantage',         'Aetna',            'mapd'),
  ('Medicare Advantage',         'Humana',           'mapd'),
  ('Medicare Advantage',         'Wellcare',         'mapd'),
  ('Prescription Drug Plan',     'UnitedHealthcare', 'mapd'),
  ('Dental / Vision / Hearing',  'Manhattan Life',   'ancillary'),
  ('Hospital Indemnity',         'Aetna',            'ancillary'),
  ('Final Expense',              'Mutual of Omaha',  'ancillary'),
  ('Cancer / Critical Illness',  'Guarantee Trust',  'ancillary'),
  ('MAPD + Ancillary Bundle',    'Multiple',         'combined')
on conflict (name, carrier) do nothing;
