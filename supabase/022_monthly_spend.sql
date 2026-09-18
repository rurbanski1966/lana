-- ============================================================================
-- Lana — migration 022: Monthly spend replaces Pace on the Dashboard
--
-- Additive. Run after 021. Safe to re-run.
--
-- Per Ryan 2026-09-18: total money spent for the entire month, org-wide,
-- covering every cost source — the original AI grading (call_scores.cost_usd)
-- and the AI-generated reviewer summary (call_scores.manual_summary_cost_usd,
-- migration 021) — not just one of them.
--
-- Each cost source is attributed to the month it actually happened in, using
-- its own timestamp: cost_usd by created_at (when the call was scored),
-- manual_summary_cost_usd by manual_summary_generated_at (when that summary
-- was actually generated). A summary generated in a later month than its
-- call was scored counts toward the month it was generated in, not the
-- month the call itself was scored — the same principle 021's comment
-- already laid out for why that cost isn't folded into cost_usd.
--
-- New return column, so this has to DROP the function first — CREATE OR
-- REPLACE can't change a function's return signature (same reason
-- migrations 015 and 018 needed it).
-- ============================================================================

drop function if exists public.my_metrics();

create function public.my_metrics()
returns table (
  daily_ap          numeric,
  daily_spend       numeric,
  weekly_spend      numeric,
  monthly_spend     numeric,
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
        + interval '1 month - 1 day')::date                                 as month_end
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
