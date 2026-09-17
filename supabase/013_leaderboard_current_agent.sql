-- ============================================================================
-- Lana — migration 013: leaderboard always reflects the call's current agent
--
-- Additive. Run after 012. Safe to re-run.
--
-- scoring_leaderboard grouped by call_scores.agent_id — a snapshot frozen at
-- the moment score-call ran — while its label-only branch already read
-- agent_name live from call_recordings. That mismatch meant reassigning a
-- call to a different agent (or from a label to a real account) via Edit,
-- AFTER it had already been scored, left the leaderboard still crediting
-- whoever was assigned at scoring time.
--
-- Both branches now read agent_id/agent_name from call_recordings — the
-- live, current assignment — instead of call_scores. Per Ryan 2026-09-17:
-- the agent shown on the leaderboard must always match who Call reviews
-- currently shows the call assigned to, not who it was assigned to when it
-- happened to get scored.
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
      r.agent_id,
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
