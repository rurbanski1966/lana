-- ============================================================================
-- Lana — migration 005: human grading and calibration
--
-- Additive. Run after 004. Safe to re-run.
--
-- Lets a person grade a call that the model already graded, then compares the
-- two. The point is not to police the model — it is to find where the RUBRIC
-- is wrong. A dimension where the model consistently scores 12 points above
-- the humans usually means the criteria for that dimension are too loose, not
-- that the model is broken.
--
-- Reviews are stored per reviewer, not per call, so two managers can grade the
-- same call and disagree. Disagreement between humans is itself a signal: if
-- your reviewers are 20 points apart on Discovery, no rubric wording will make
-- the model's number feel right, because there is no agreed standard yet.
-- ============================================================================

create table if not exists public.score_reviews (
  id               uuid primary key default gen_random_uuid(),
  score_id         uuid not null references public.call_scores (id) on delete cascade,
  recording_id     uuid not null references public.call_recordings (id) on delete cascade,
  reviewer_id      uuid not null references public.profiles (id) on delete cascade,

  overall_score    integer not null check (overall_score between 0 and 100),
  -- { dimension_key: { score: int, note: text } } — mirrors call_scores.dimensions
  -- so the two can be compared key by key.
  dimensions       jsonb not null default '{}'::jsonb,
  compliance_agree boolean,                       -- null = didn't assess
  notes            text not null default '',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One review per person per score. Revising your grade updates it rather
  -- than stacking a second opinion from the same head.
  unique (score_id, reviewer_id)
);

create index if not exists reviews_score_idx    on public.score_reviews (score_id);
create index if not exists reviews_reviewer_idx on public.score_reviews (reviewer_id, created_at desc);


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.score_reviews enable row level security;

drop policy if exists reviews_select on public.score_reviews;
drop policy if exists reviews_own    on public.score_reviews;
drop policy if exists reviews_admin  on public.score_reviews;

-- You can read a review if you could read the call it belongs to.
create policy reviews_select on public.score_reviews
  for select using (
    reviewer_id = auth.uid()
    or exists (
      select 1 from public.call_recordings r
      where r.id = recording_id
        and (r.agent_id = auth.uid() or r.uploaded_by = auth.uid())
    )
  );

create policy reviews_own on public.score_reviews
  for all using (reviewer_id = auth.uid()) with check (reviewer_id = auth.uid());

create policy reviews_admin on public.score_reviews
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Calibration: where does the model disagree with people, and by how much?
--
-- Returns one row per dimension. `delta` is model minus human, so a POSITIVE
-- delta means the model is scoring more generously than your reviewers.
--
-- SECURITY DEFINER and aggregate-only, same reasoning as the leaderboards:
-- the numbers are visible without exposing anyone's individual review.
-- ---------------------------------------------------------------------------
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
      d.key                                             as dimension_key,
      (s.dimensions -> d.key ->> 'score')::numeric      as model_score,
      (v.dimensions -> d.key ->> 'score')::numeric      as human_score
    from public.score_reviews v
    join public.call_scores s      on s.id = v.score_id
    join public.call_recordings r  on r.id = v.recording_id
    cross join lateral jsonb_object_keys(v.dimensions) as d(key)
    where r.call_on between p_start and p_end
      and s.dimensions ? d.key
      and (v.dimensions -> d.key ->> 'score') is not null
  )
  select
    dimension_key,
    count(*)                                   as reviews,
    round(avg(model_score), 1)                 as model_avg,
    round(avg(human_score), 1)                 as human_avg,
    round(avg(model_score - human_score), 1)   as delta,
    round(avg(abs(model_score - human_score)), 1) as mean_abs_gap
  from paired
  group by dimension_key
  order by abs(avg(model_score - human_score)) desc;
$$;

-- Overall-score agreement, plus how often humans disagreed with the model's
-- compliance verdict — that one matters more than any dimension gap.
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
    round(avg(v.overall_score), 1),
    round(avg(s.overall_score - v.overall_score), 1),
    round(avg(abs(s.overall_score - v.overall_score)), 1),
    count(*) filter (where abs(s.overall_score - v.overall_score) <= 5),
    count(*) filter (where abs(s.overall_score - v.overall_score) <= 10),
    count(*) filter (where v.compliance_agree is false)
  from public.score_reviews v
  join public.call_scores s     on s.id = v.score_id
  join public.call_recordings r on r.id = v.recording_id
  where r.call_on between p_start and p_end;
$$;

grant execute on function public.calibration_by_dimension(date, date) to authenticated;
grant execute on function public.calibration_summary(date, date)      to authenticated;
