-- ============================================================================
-- Lana — migration 014: spend summary (day / week / month, org-wide and per team)
--
-- Additive. Run after 013. Safe to re-run.
--
-- "Cost" here is call_scores.cost_usd — the Anthropic grading cost. There is
-- no per-call transcription cost anywhere in the schema (Deepgram's cost was
-- never computed or stored), so this deliberately does not claim to include
-- it. Reporting a fabricated number would be worse than reporting a true one
-- that's narrower than expected.
--
-- Week is Monday-Sunday (Postgres date_trunc('week', ...) is ISO, i.e.
-- Monday-first) and month is the 1st through the last day, both in
-- America/Chicago local time to match every other date boundary in the app
-- (see my_metrics()).
--
-- Returns one row per (scope, period): scope is 'All' for the org-wide
-- total, or a team's name for that team's slice. Team names come from the
-- teams table, not hardcoded, so this keeps working as teams are added or
-- renamed.
-- ============================================================================

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
  -- Admin-gated the same way scoring_spend() is: a non-admin caller gets an
  -- empty set here, so every aggregate below comes back zero rather than the
  -- function erroring.
  scored as (
    select s.cost_usd, r.call_on, t.name as team_name
    from public.call_scores s
    join public.call_recordings r on r.id = s.recording_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams t      on t.id = p.team_id
    where public.is_admin()
  )
  select 'All'::text, 'day'::text,
    coalesce(sum(sc.cost_usd) filter (where sc.call_on = b.today), 0),
    count(*) filter (where sc.call_on = b.today)
  from bounds b left join scored sc on true

  union all
  select 'All', 'week',
    coalesce(sum(sc.cost_usd) filter (where sc.call_on between b.week_start and b.week_end), 0),
    count(*) filter (where sc.call_on between b.week_start and b.week_end)
  from bounds b left join scored sc on true

  union all
  select 'All', 'month',
    coalesce(sum(sc.cost_usd) filter (where sc.call_on between b.month_start and b.month_end), 0),
    count(*) filter (where sc.call_on between b.month_start and b.month_end)
  from bounds b left join scored sc on true

  union all
  select t.name, 'week',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.call_on between b.week_start and b.week_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.call_on between b.week_start and b.week_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.week_start, b.week_end

  union all
  select t.name, 'month',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.call_on between b.month_start and b.month_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.call_on between b.month_start and b.month_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.month_start, b.month_end;
$$;

grant execute on function public.spend_summary() to authenticated;
