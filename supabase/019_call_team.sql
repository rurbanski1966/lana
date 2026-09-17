-- ============================================================================
-- Lana — migration 019: assign a team (EWSS / SMC) directly on a call
--
-- Additive. Run after 018. Safe to re-run.
--
-- Per Ryan 2026-09-17: need a field on the call itself — not just on the
-- agent's profile — to mark it EWSS or SMC. This is what a label-only call
-- (migration 006, someone without a Lana login yet) has always been missing:
-- migration 009's comment on scoring_leaderboard noted labeled calls have
-- "no team to put it in" and only ever show under All agents. Now they can
-- be tagged directly.
--
-- call_recordings.team_id is an override, not a requirement: when set, it
-- wins; when left blank, both scoring_leaderboard and spend_summary fall
-- back to the agent's own profile team exactly as before. A real agent's
-- calls can also be tagged per-call — useful for a call that should count
-- toward a specific team's numbers regardless of whose profile it's under.
-- ============================================================================

alter table public.call_recordings
  add column if not exists team_id uuid references public.teams (id) on delete set null;

-- --- scoring_leaderboard: team_name is now resolved per call ---------------
create or replace function public.scoring_leaderboard(p_start date, p_end date)
returns table (
  agent_id       uuid,
  full_name      text,
  team_name      text,
  calls_scored   bigint,
  avg_score      numeric,
  compliance_ok  bigint,
  open_findings  bigint,
  rank           bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with scored as (
    select
      r.agent_id,
      r.agent_name,
      coalesce(rt.name, pt.name, '— unassigned —') as team_name,
      s.effective_overall_score as overall_score,
      s.effective_compliance_passed as compliance_passed,
      jsonb_array_length(coalesce(s.effective_findings, '[]'::jsonb)) as finding_count
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
    where r.call_on between p_start and p_end
  ),
  real_agents as (
    select
      sc.agent_id,
      p.full_name,
      sc.team_name,
      count(*)                                       as calls_scored,
      round(avg(sc.overall_score), 1)                as avg_score,
      count(*) filter (where sc.compliance_passed)   as compliance_ok,
      coalesce(sum(sc.finding_count), 0)             as open_findings
    from scored sc
    join public.profiles p on p.id = sc.agent_id and p.active
    group by sc.agent_id, p.full_name, sc.team_name
  ),
  labeled as (
    select
      null::uuid                                    as agent_id,
      sc.agent_name                                  as full_name,
      sc.team_name,
      count(*)                                       as calls_scored,
      round(avg(sc.overall_score), 1)                as avg_score,
      count(*) filter (where sc.compliance_passed)   as compliance_ok,
      coalesce(sum(sc.finding_count), 0)             as open_findings
    from scored sc
    where sc.agent_id is null and sc.agent_name is not null
    group by sc.agent_name, sc.team_name
  ),
  totals as (
    select * from real_agents
    union all
    select * from labeled
  )
  select
    agent_id, full_name, team_name, calls_scored, avg_score,
    compliance_ok, open_findings,
    rank() over (order by avg_score desc nulls last)
  from totals
  order by avg_score desc nulls last, full_name;
$$;

grant execute on function public.scoring_leaderboard(date, date) to authenticated;

-- --- spend_summary: per-team totals now honor a call's own team_id too ----
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
      coalesce(rt.name, pt.name) as team_name
    from public.call_scores s
    join public.call_recordings r on r.id = s.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
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
