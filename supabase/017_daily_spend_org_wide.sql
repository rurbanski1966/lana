-- ============================================================================
-- Lana — migration 017: Daily spend on the Dashboard counts every call, not
-- just the viewer's own
--
-- Additive. Run after 016. Safe to re-run.
--
-- my_metrics().daily_spend was scoped to agent_id = auth.uid(), matching how
-- daily_ap has always worked (each agent sees only their own AP). Per Ryan
-- 2026-09-17: unlike AP, Daily spend should count every call scored today
-- regardless of which agent it's assigned to — it's an org-wide cost figure,
-- not a personal one, even though it's shown on the personal Dashboard tile.
--
-- Return columns are unchanged, so CREATE OR REPLACE is fine here.
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
    -- Org-wide on purpose: every call scored today counts, regardless of
    -- which agent (or label, or no agent at all) it's assigned to.
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date = b.today
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
