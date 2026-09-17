-- ============================================================================
-- Lana — migration 016: attribute spend to when scoring happened, not call_on
--
-- Additive. Run after 015. Safe to re-run.
--
-- Both my_metrics().daily_spend and spend_summary() filtered by
-- call_recordings.call_on — the call's nominal date, which can be entered as
-- any day regardless of when it was actually transcribed and scored. A call
-- graded today with call_on set to an earlier date was invisible to "today's"
-- spend, and a call graded today with call_on today would count on the wrong
-- day if call_on is ever backdated further. Spend has to be measured by when
-- the Anthropic API cost was actually incurred: call_scores.created_at.
--
-- Neither function's return columns change, so CREATE OR REPLACE is fine —
-- unlike migration 015, there's no need to DROP first here.
-- ============================================================================

create or replace function public.my_metrics()
returns table (
  daily_ap          numeric,
  daily_spend       numeric,
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
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      join public.call_recordings r on r.id = cs.recording_id
      cross join bounds b
      where r.agent_id = auth.uid()
        and (cs.created_at at time zone 'America/Chicago')::date = b.today
    ), 0) as daily_spend,
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

grant execute on function public.my_metrics() to authenticated;

create or replace function public.spend_summary()
returns table (
  scope        text,
  period       text,
  total_cost   numeric,
  calls_scored bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      (now() at time zone 'America/Chicago')::date                          as today,
      date_trunc('week', (now() at time zone 'America/Chicago'))::date      as week_start,
      (date_trunc('week', (now() at time zone 'America/Chicago'))
        + interval '6 days')::date                                         as week_end,
      date_trunc('month', (now() at time zone 'America/Chicago'))::date     as month_start,
      (date_trunc('month', (now() at time zone 'America/Chicago'))
        + interval '1 month - 1 day')::date                                 as month_end
  ),
  scored as (
    select
      s.cost_usd,
      (s.created_at at time zone 'America/Chicago')::date as scored_on,
      t.name as team_name
    from public.call_scores s
    join public.call_recordings r on r.id = s.recording_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams t      on t.id = p.team_id
    where public.is_admin()
  )
  select 'All'::text, 'day'::text,
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on = b.today), 0),
    count(*) filter (where sc.scored_on = b.today)
  from bounds b left join scored sc on true

  union all
  select 'All', 'week',
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on between b.week_start and b.week_end), 0),
    count(*) filter (where sc.scored_on between b.week_start and b.week_end)
  from bounds b left join scored sc on true

  union all
  select 'All', 'month',
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on between b.month_start and b.month_end), 0),
    count(*) filter (where sc.scored_on between b.month_start and b.month_end)
  from bounds b left join scored sc on true

  union all
  select t.name, 'week',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.scored_on between b.week_start and b.week_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.scored_on between b.week_start and b.week_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.week_start, b.week_end

  union all
  select t.name, 'month',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.scored_on between b.month_start and b.month_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.scored_on between b.month_start and b.month_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.month_start, b.month_end;
$$;

grant execute on function public.spend_summary() to authenticated;
