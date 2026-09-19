-- ============================================================================
-- Lana — migration 023: Yearly spend replaces "To target" on the Dashboard
--
-- Additive. Run after 022. Safe to re-run.
--
-- Per Ryan 2026-09-18: same idea as 022's monthly_spend, but for the whole
-- calendar year, org-wide, covering every cost source — the AI grading cost
-- (call_scores.cost_usd) and the AI-generated reviewer summary cost
-- (call_scores.manual_summary_cost_usd, migration 021). There is no other
-- cost column on call_scores to fold in.
--
-- Same attribution rule as 022: each cost source counts toward the year its
-- own timestamp falls in — cost_usd by created_at, manual_summary_cost_usd
-- by manual_summary_generated_at — not the year the call itself happened.
--
-- target_ap and pace stay in the return set (goals still use target_ap
-- elsewhere) even though the Dashboard tile that showed "To target" now
-- shows Yearly spend instead.
--
-- New return column, so this has to DROP the function first — CREATE OR
-- REPLACE can't change a function's return signature (same reason
-- migrations 015, 018 and 022 needed it).
-- ============================================================================

drop function if exists public.my_metrics();

create function public.my_metrics()
returns table (
  daily_ap          numeric,
  daily_spend       numeric,
  weekly_spend      numeric,
  monthly_spend     numeric,
  yearly_spend      numeric,
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
      (now() at time zone 'America/Chicago')::date                          as today,
      date_trunc('week', (now() at time zone 'America/Chicago'))::date      as week_start,
      (date_trunc('week', (now() at time zone 'America/Chicago'))
        + interval '6 days')::date                                         as week_end,
      date_trunc('month', (now() at time zone 'America/Chicago'))::date     as month_start,
      (date_trunc('month', (now() at time zone 'America/Chicago'))
        + interval '1 month - 1 day')::date                                 as month_end,
      date_trunc('year', (now() at time zone 'America/Chicago'))::date      as year_start,
      (date_trunc('year', (now() at time zone 'America/Chicago'))
        + interval '1 year - 1 day')::date                                  as year_end
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
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date = b.today
    ), 0) as daily_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as weekly_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores cs
      cross join bounds b
      where cs.manual_summary_generated_at is not null
        and (cs.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as monthly_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores cs
      cross join bounds b
      where cs.manual_summary_generated_at is not null
        and (cs.manual_summary_generated_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0) as yearly_spend,
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
