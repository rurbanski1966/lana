-- ============================================================================
-- Lana — migration 020: calibration compares against Manual review, not a
-- separate "Your grade" form
--
-- Additive. Run after 019. Safe to re-run.
--
-- Per Ryan 2026-09-17: the standalone "Your grade" form (score_reviews,
-- migration 005) duplicated work already done through the per-dimension and
-- per-finding Manual review buttons on a call's detail page. Two approved
-- calls with overrides on their Compliance findings / By dimension sections
-- only counted one "graded call" on Calibration, because that page only ever
-- read score_reviews — which the admin had no reason to also fill in.
--
-- Calibration now reads call_scores directly: for any is_overridden call,
-- the model's own columns (dimensions, overall_score, compliance_passed)
-- are the "model" side and the manual_* columns are the "human" side — the
-- exact same override data already shown on the call page, with nothing
-- new to fill in. A dimension the admin never touched still compares equal
-- (manual_dimensions carries the model's own score forward unchanged for any
-- key not explicitly re-graded — see drawDimensions' updatedDims spread),
-- so it correctly contributes a zero gap rather than being missing data.
--
-- score_reviews itself is left in place (no data destroyed), it's just no
-- longer read by these two functions or by the frontend.
-- ============================================================================

create or replace function public.calibration_by_dimension(p_start date, p_end date)
returns table (
  dimension_key text,
  reviews       bigint,
  model_avg     numeric,
  human_avg     numeric,
  delta         numeric,
  mean_abs_gap  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with paired as (
    select
      d.key                                                as dimension_key,
      (s.dimensions -> d.key ->> 'score')::numeric         as model_score,
      (s.manual_dimensions -> d.key ->> 'score')::numeric  as human_score
    from public.call_scores s
    join public.call_recordings r on r.id = s.recording_id
    cross join lateral jsonb_object_keys(s.manual_dimensions) as d(key)
    where s.is_overridden
      and r.call_on between p_start and p_end
      and s.dimensions ? d.key
      and (s.manual_dimensions -> d.key ->> 'score') is not null
  )
  select
    dimension_key,
    count(*)                                       as reviews,
    round(avg(model_score), 1)                     as model_avg,
    round(avg(human_score), 1)                     as human_avg,
    round(avg(model_score - human_score), 1)       as delta,
    round(avg(abs(model_score - human_score)), 1)  as mean_abs_gap
  from paired
  group by dimension_key
  order by abs(avg(model_score - human_score)) desc;
$$;

create or replace function public.calibration_summary(p_start date, p_end date)
returns table (
  reviews             bigint,
  model_avg           numeric,
  human_avg           numeric,
  delta               numeric,
  mean_abs_gap        numeric,
  within_5            bigint,
  within_10           bigint,
  compliance_disputed bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    round(avg(s.overall_score), 1),
    round(avg(s.manual_overall_score), 1),
    round(avg(s.overall_score - s.manual_overall_score), 1),
    round(avg(abs(s.overall_score - s.manual_overall_score)), 1),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 5),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 10),
    count(*) filter (where s.manual_compliance_passed is distinct from s.compliance_passed)
  from public.call_scores s
  join public.call_recordings r on r.id = s.recording_id
  where s.is_overridden
    and r.call_on between p_start and p_end;
$$;

grant execute on function public.calibration_by_dimension(date, date) to authenticated;
grant execute on function public.calibration_summary(date, date)      to authenticated;
