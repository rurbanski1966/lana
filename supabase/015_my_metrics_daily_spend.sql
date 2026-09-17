-- ============================================================================
-- Lana — migration 015: daily spend on the agent dashboard
--
-- Additive. Run after 014. Safe to re-run.
--
-- Adds daily_spend to my_metrics() — the grading cost (call_scores.cost_usd)
-- of this agent's own calls with call_on = today, replacing Daily AP on the
-- Dashboard tile. Same "call_on, not when it was entered" convention Daily AP
-- itself already uses (see agg.daily_ap below), and the same grading-cost-
-- only caveat as the Scorecard's Spend section: there's no per-call
-- transcription cost stored anywhere to add to it.
-- ============================================================================

-- Postgres won't let CREATE OR REPLACE change a function's return columns —
-- adding daily_spend requires dropping the old signature first.
drop function if exists public.my_metrics();

create function public.my_metrics()
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
      where r.agent_id = auth.uid() and r.call_on = b.today
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
