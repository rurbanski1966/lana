-- ============================================================================
-- Lana — migration 002: dialer portal
--
-- Additive. Run this after schema.sql; it touches nothing that migration
-- created. Safe to re-run.
--
-- Design note on why there is no per-call table:
-- a dialer places 150-250 calls a day. Asking them to hand-enter a row per
-- dial guarantees the data never gets logged. So volume is captured as a daily
-- tally (one editable row per dialer per day) and only appointments — the
-- events that actually carry money — get individual records.
-- ============================================================================

do $$ begin
  create type appointment_status as enum ('scheduled', 'held', 'no_show', 'sold', 'lost');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- Daily activity tally
-- ---------------------------------------------------------------------------
create table if not exists public.call_sessions (
  id            uuid primary key default gen_random_uuid(),
  dialer_id     uuid not null references public.profiles (id) on delete cascade,
  logged_on     date not null default (now() at time zone 'America/Chicago')::date,
  dials         integer not null default 0 check (dials >= 0),
  contacts      integer not null default 0 check (contacts >= 0),
  voicemails    integer not null default 0 check (voicemails >= 0),
  talk_minutes  integer not null default 0 check (talk_minutes >= 0),
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (dialer_id, logged_on),
  -- A contact is a subset of a dial. Without this, a fat-fingered entry
  -- produces a contact rate above 100% and every downstream rate is garbage.
  constraint contacts_within_dials check (contacts <= dials),
  constraint voicemails_within_dials check (voicemails <= dials)
);

create index if not exists call_sessions_dialer_date_idx
  on public.call_sessions (dialer_id, logged_on desc);


-- ---------------------------------------------------------------------------
-- Appointments
--
-- set_on is the date the appointment was BOOKED; scheduled_at is when it
-- happens. Dialer productivity is measured on set_on — crediting the booking
-- to a future date would leave today's board empty.
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id             uuid primary key default gen_random_uuid(),
  dialer_id      uuid not null references public.profiles (id) on delete cascade,
  agent_id       uuid references public.profiles (id) on delete set null,
  lead_name      text not null,
  phone          text not null default '',
  set_on         date not null default (now() at time zone 'America/Chicago')::date,
  scheduled_at   timestamptz not null,
  status         appointment_status not null default 'scheduled',
  submission_id  uuid references public.submissions (id) on delete set null,
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  created_by     uuid not null references public.profiles (id) on delete cascade
);

create index if not exists appointments_dialer_idx   on public.appointments (dialer_id, set_on desc);
create index if not exists appointments_agent_idx    on public.appointments (agent_id, scheduled_at desc);
create index if not exists appointments_status_idx   on public.appointments (status);


-- ---------------------------------------------------------------------------
-- Dialer targets. Kept separate from `goals` because those are denominated in
-- AP and these are counts — one column would have to mean two things.
-- ---------------------------------------------------------------------------
create table if not exists public.dialer_goals (
  id                    uuid primary key default gen_random_uuid(),
  dialer_id             uuid not null references public.profiles (id) on delete cascade,
  period                date not null,                 -- 1st of the month
  target_dials          integer not null default 0 check (target_dials >= 0),
  target_appointments   integer not null default 0 check (target_appointments >= 0),
  created_at            timestamptz not null default now(),
  unique (dialer_id, period)
);


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.call_sessions enable row level security;
alter table public.appointments  enable row level security;
alter table public.dialer_goals  enable row level security;

-- call_sessions -------------------------------------------------------------
drop policy if exists sessions_own   on public.call_sessions;
drop policy if exists sessions_admin on public.call_sessions;

create policy sessions_own on public.call_sessions
  for all using (dialer_id = auth.uid()) with check (dialer_id = auth.uid());

create policy sessions_admin on public.call_sessions
  for all using (public.is_admin()) with check (public.is_admin());

-- appointments --------------------------------------------------------------
drop policy if exists appts_dialer_all    on public.appointments;
drop policy if exists appts_agent_select  on public.appointments;
drop policy if exists appts_agent_update  on public.appointments;
drop policy if exists appts_admin         on public.appointments;

create policy appts_dialer_all on public.appointments
  for all using (dialer_id = auth.uid()) with check (dialer_id = auth.uid());

-- The agent the appointment was booked for can see it and report what
-- happened — they are the only one who actually knows whether it held.
create policy appts_agent_select on public.appointments
  for select using (agent_id = auth.uid());

create policy appts_agent_update on public.appointments
  for update using (agent_id = auth.uid()) with check (agent_id = auth.uid());

create policy appts_admin on public.appointments
  for all using (public.is_admin()) with check (public.is_admin());

-- dialer_goals --------------------------------------------------------------
drop policy if exists dgoals_own   on public.dialer_goals;
drop policy if exists dgoals_admin on public.dialer_goals;

create policy dgoals_own on public.dialer_goals
  for select using (dialer_id = auth.uid());

create policy dgoals_admin on public.dialer_goals
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Agents need to see the roster to book an appointment for someone, but the
-- base profiles policy only exposes their own row. This returns names only —
-- no email, no role, no team.
-- ---------------------------------------------------------------------------
create or replace function public.bookable_agents()
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name
  from public.profiles p
  where p.active and p.role in ('agent', 'admin')
  order by p.full_name;
$$;


-- ---------------------------------------------------------------------------
-- Dialer metrics for the calling user.
--
-- Rates are returned as fractions, not percentages, and are null rather than
-- zero when the denominator is zero — "no dials yet" and "a 0% contact rate"
-- are different facts and the tiles render them differently.
-- ---------------------------------------------------------------------------
create or replace function public.my_dialer_metrics()
returns table (
  dials_today         integer,
  contacts_today      integer,
  appts_today         integer,
  dials_month         integer,
  contacts_month      integer,
  appts_month         integer,
  held_month          integer,
  sold_month          integer,
  resolved_month      integer,
  contact_rate        numeric,
  set_rate            numeric,
  held_rate           numeric,
  close_rate          numeric,
  target_dials        integer,
  target_appointments integer,
  days_elapsed        integer,
  days_in_month       integer,
  appt_pace           numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with b as (
    select
      (now() at time zone 'America/Chicago')::date                      as today,
      date_trunc('month', (now() at time zone 'America/Chicago'))::date as m_start,
      (date_trunc('month', (now() at time zone 'America/Chicago'))
        + interval '1 month - 1 day')::date                             as m_end
  ),
  s as (
    select
      coalesce(sum(cs.dials)    filter (where cs.logged_on = b.today), 0)::int as dials_today,
      coalesce(sum(cs.contacts) filter (where cs.logged_on = b.today), 0)::int as contacts_today,
      coalesce(sum(cs.dials), 0)::int    as dials_month,
      coalesce(sum(cs.contacts), 0)::int as contacts_month
    from b left join public.call_sessions cs
      on cs.dialer_id = auth.uid()
     and cs.logged_on between b.m_start and b.m_end
    group by b.today
  ),
  a as (
    select
      count(*) filter (where ap.set_on = b.today)::int                    as appts_today,
      count(*)::int                                                       as appts_month,
      count(*) filter (where ap.status = 'held')::int                     as held_month,
      count(*) filter (where ap.status = 'sold')::int                     as sold_month,
      count(*) filter (where ap.status <> 'scheduled')::int               as resolved_month
    from b left join public.appointments ap
      on ap.dialer_id = auth.uid()
     and ap.set_on between b.m_start and b.m_end
    group by b.today
  ),
  d as (
    select
      public.business_days(b.m_start, least(b.today, b.m_end)) as elapsed,
      public.business_days(b.m_start, b.m_end)                 as total
    from b
  ),
  g as (
    select coalesce(dg.target_dials, 0) as td, coalesce(dg.target_appointments, 0) as ta
    from b left join public.dialer_goals dg
      on dg.dialer_id = auth.uid() and dg.period = b.m_start
  )
  select
    coalesce(s.dials_today, 0), coalesce(s.contacts_today, 0), coalesce(a.appts_today, 0),
    coalesce(s.dials_month, 0), coalesce(s.contacts_month, 0), coalesce(a.appts_month, 0),
    coalesce(a.held_month, 0), coalesce(a.sold_month, 0), coalesce(a.resolved_month, 0),
    case when coalesce(s.dials_month, 0)    > 0 then round(s.contacts_month::numeric / s.dials_month, 4) end,
    case when coalesce(s.contacts_month, 0) > 0 then round(a.appts_month::numeric / s.contacts_month, 4) end,
    case when coalesce(a.resolved_month, 0) > 0
      then round((a.held_month + a.sold_month)::numeric / a.resolved_month, 4) end,
    case when (coalesce(a.held_month, 0) + coalesce(a.sold_month, 0)) > 0
      then round(a.sold_month::numeric / (a.held_month + a.sold_month), 4) end,
    g.td, g.ta, d.elapsed, d.total,
    case when d.elapsed > 0
      then round(coalesce(a.appts_month, 0)::numeric / d.elapsed * d.total, 1)
      else 0 end
  from d cross join g
  left join s on true
  left join a on true;
$$;


-- ---------------------------------------------------------------------------
-- Dialer leaderboard. Aggregates only, same reasoning as the AP leaderboard:
-- every dialer sees the rankings, nobody reads anyone else's raw rows.
-- ---------------------------------------------------------------------------
create or replace function public.dialer_leaderboard(p_start date, p_end date)
returns table (
  dialer_id    uuid,
  full_name    text,
  team_name    text,
  dials        integer,
  contacts     integer,
  appts        integer,
  sold         integer,
  contact_rate numeric,
  set_rate     numeric,
  rank         bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select p.id, p.full_name, coalesce(t.name, '—') as team_name
    from public.profiles p
    left join public.teams t on t.id = p.team_id
    where p.active and p.role = 'dialer'
  ),
  vol as (
    select cs.dialer_id,
           coalesce(sum(cs.dials), 0)::int    as dials,
           coalesce(sum(cs.contacts), 0)::int as contacts
    from public.call_sessions cs
    where cs.logged_on between p_start and p_end
    group by cs.dialer_id
  ),
  appt as (
    select ap.dialer_id,
           count(*)::int                                as appts,
           count(*) filter (where ap.status = 'sold')::int as sold
    from public.appointments ap
    where ap.set_on between p_start and p_end
    group by ap.dialer_id
  ),
  joined as (
    select
      pe.id, pe.full_name, pe.team_name,
      coalesce(v.dials, 0)    as dials,
      coalesce(v.contacts, 0) as contacts,
      coalesce(ap.appts, 0)   as appts,
      coalesce(ap.sold, 0)    as sold
    from people pe
    left join vol  v  on v.dialer_id  = pe.id
    left join appt ap on ap.dialer_id = pe.id
  )
  select
    id, full_name, team_name, dials, contacts, appts, sold,
    case when dials > 0    then round(contacts::numeric / dials, 4) end,
    case when contacts > 0 then round(appts::numeric / contacts, 4) end,
    rank() over (order by appts desc, contacts desc)
  from joined
  order by appts desc, contacts desc, full_name asc;
$$;

grant execute on function public.bookable_agents()                 to authenticated;
grant execute on function public.my_dialer_metrics()               to authenticated;
grant execute on function public.dialer_leaderboard(date, date)    to authenticated;
