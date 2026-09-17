-- ============================================================================
-- Lana — migration 009: leaderboard includes label-only agents
--
-- Additive. Run after 008. Safe to re-run.
--
-- scoring_leaderboard only ever grouped by public.profiles, so a call scored
-- under a free-text agent_name (migration 006 — someone without a Lana login
-- yet) contributed to no one's row at all: it had no agent_id to join on, so
-- it silently vanished from the leaderboard entirely.
--
-- Now it's a second grouping, unioned in: one row per distinct agent_name
-- with agent_id null and team_name '— unassigned —'. There's no team to put
-- it in — the team tabs filter by an exact team_name match, which a labeled
-- row deliberately never has — so it only ever shows under "All agents".
-- Once someone gets a real account, reassign their calls to it (Agents page)
-- and their history rolls into their profile's row instead.
-- ============================================================================

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
      s.agent_id,
      r.agent_name,
      s.effective_overall_score as overall_score,
      s.effective_compliance_passed as compliance_passed,
      jsonb_array_length(coalesce(s.effective_findings, '[]'::jsonb)) as finding_count
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    where r.call_on between p_start and p_end
  ),
  real_agents as (
    select
      p.id                                       as agent_id,
      p.full_name,
      coalesce(t.name, '—')                      as team_name,
      count(sc.*)                                as calls_scored,
      round(avg(sc.overall_score), 1)            as avg_score,
      count(*) filter (where sc.compliance_passed) as compliance_ok,
      coalesce(sum(sc.finding_count), 0)         as open_findings
    from public.profiles p
    left join public.teams t on t.id = p.team_id
    left join scored sc      on sc.agent_id = p.id
    where p.active
    group by p.id, p.full_name, t.name
  ),
  labeled as (
    select
      null::uuid                                    as agent_id,
      sc.agent_name                                  as full_name,
      '— unassigned —'::text                         as team_name,
      count(*)                                       as calls_scored,
      round(avg(sc.overall_score), 1)                as avg_score,
      count(*) filter (where sc.compliance_passed)   as compliance_ok,
      coalesce(sum(sc.finding_count), 0)             as open_findings
    from scored sc
    where sc.agent_id is null and sc.agent_name is not null
    group by sc.agent_name
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
  where calls_scored > 0
  order by avg_score desc nulls last, full_name;
$$;

grant execute on function public.scoring_leaderboard(date, date) to authenticated;
