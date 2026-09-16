-- ============================================================================
-- Lana — migration 007: manual score overrides
--
-- Additive. Run after 006. Safe to re-run.
--
-- The model's score never changes after scoring — overall_score, dimensions,
-- compliance_passed and findings stay exactly what score-call wrote. An
-- admin's override lands in a parallel set of manual_* columns instead, so
-- the model's original numbers stay visible next to the override rather than
-- being replaced by it.
--
-- is_overridden is the one flag everything else keys off. call_scores_effective
-- resolves it: manual_* when true, the model's own columns when false. Reports
-- (scoring_leaderboard) read through that view, so an override actually
-- changes what a dashboard shows — including how many low/medium/high/
-- critical findings count against someone, since a dismissed or re-graded
-- finding in manual_findings is what effective_findings reflects.
--
-- This is unrelated to score_reviews (migration 005) — those are many
-- independent human opinions used to tune the rubric against the model, never
-- authoritative on their own. This is the one admin-made call that IS
-- authoritative for a given score.
-- ============================================================================

alter table public.call_scores add column if not exists manual_overall_score integer
  check (manual_overall_score is null or manual_overall_score between 0 and 100);
alter table public.call_scores add column if not exists manual_dimensions jsonb;
alter table public.call_scores add column if not exists manual_compliance_passed boolean;
alter table public.call_scores add column if not exists manual_findings jsonb;
alter table public.call_scores add column if not exists manual_notes text not null default '';
alter table public.call_scores add column if not exists is_overridden boolean not null default false;
alter table public.call_scores add column if not exists overridden_by uuid references public.profiles (id) on delete set null;
alter table public.call_scores add column if not exists overridden_at timestamptz;

create or replace view public.call_scores_effective as
select
  s.*,
  case when s.is_overridden then s.manual_overall_score     else s.overall_score     end as effective_overall_score,
  case when s.is_overridden then s.manual_dimensions        else s.dimensions        end as effective_dimensions,
  case when s.is_overridden then s.manual_compliance_passed else s.compliance_passed end as effective_compliance_passed,
  case when s.is_overridden then s.manual_findings          else s.findings          end as effective_findings
from public.call_scores s;

-- A view has no RLS of its own — Postgres evaluates call_scores' own policies
-- (scores_select_own / scores_admin) against the rows it reads from that
-- table, so access here is exactly as restricted as reading call_scores
-- directly. No separate grant needed beyond select.
grant select on public.call_scores_effective to authenticated;

-- Re-point the scorecard rollup at the effective columns so an override
-- changes the agent's average and open-findings count, not just the one call.
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
      s.effective_overall_score as overall_score,
      s.effective_compliance_passed as compliance_passed,
      jsonb_array_length(coalesce(s.effective_findings, '[]'::jsonb)) as finding_count
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    where r.call_on between p_start and p_end
  ),
  totals as (
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
