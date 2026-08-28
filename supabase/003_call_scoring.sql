-- ============================================================================
-- Lana — migration 003: AI call scoring
--
-- Additive. Run after schema.sql and 002_dialer.sql. Safe to re-run.
--
-- Scoring is NOT done from the browser. The anon key is public, so an API key
-- shipped to the client is a published API key. All model calls go through the
-- `score-call` Edge Function, which holds ANTHROPIC_API_KEY server-side and is
-- the only writer to call_scores.
-- ============================================================================

do $$ begin
  create type recording_status as enum (
    'uploaded',      -- audio stored, no transcript yet
    'transcribing',  -- transcription in flight
    'transcribed',   -- transcript ready, not yet scored
    'scoring',       -- model call in flight
    'scored',        -- done
    'failed'         -- see error_message
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type transcript_source as enum ('manual', 'deepgram', 'import');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finding_severity as enum ('low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- Recordings
--
-- agent_id is whoever was ON the call — agent or dialer. uploaded_by is
-- whoever put it in the system, which is often an admin reviewing someone
-- else's call.
-- ---------------------------------------------------------------------------
create table if not exists public.call_recordings (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references public.profiles (id) on delete cascade,
  uploaded_by       uuid not null references public.profiles (id) on delete cascade,
  appointment_id    uuid references public.appointments (id) on delete set null,
  title             text not null default '',
  call_on           date not null default (now() at time zone 'America/Chicago')::date,
  duration_seconds  integer check (duration_seconds is null or duration_seconds >= 0),
  storage_path      text,                       -- object key in the call-recordings bucket
  transcript        text,
  transcript_source transcript_source,
  status            recording_status not null default 'uploaded',
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A recording is only scoreable once it has a transcript. Enforcing it here
  -- means a bad client can't move a row into a state the scorer can't handle.
  constraint transcript_required_when_ready check (
    status not in ('transcribed', 'scoring', 'scored')
    or (transcript is not null and length(btrim(transcript)) > 0)
  )
);

create index if not exists recordings_agent_idx  on public.call_recordings (agent_id, call_on desc);
create index if not exists recordings_status_idx on public.call_recordings (status);


-- ---------------------------------------------------------------------------
-- Scores
--
-- Dimension scores and findings land as jsonb because the rubric is expected
-- to change; pinning it into columns would mean a migration every time a
-- criterion is added. rubric_version records which rubric produced the row so
-- old scores stay interpretable after the rubric moves.
-- ---------------------------------------------------------------------------
create table if not exists public.call_scores (
  id                uuid primary key default gen_random_uuid(),
  recording_id      uuid not null references public.call_recordings (id) on delete cascade,
  agent_id          uuid not null references public.profiles (id) on delete cascade,
  overall_score     integer not null check (overall_score between 0 and 100),
  dimensions        jsonb not null default '{}'::jsonb,
  compliance_passed boolean not null default true,
  findings          jsonb not null default '[]'::jsonb,
  strengths         jsonb not null default '[]'::jsonb,
  improvements      jsonb not null default '[]'::jsonb,
  summary           text not null default '',
  coaching_focus    text not null default '',

  -- Cost and provenance. Without these you cannot answer "what is scoring
  -- costing us" or "which rubric produced this score" three months from now.
  model             text not null default '',
  rubric_version    text not null default '',
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  cache_read_tokens integer not null default 0,
  cost_usd          numeric(10, 5) not null default 0,

  created_at        timestamptz not null default now()
);

create index if not exists scores_recording_idx on public.call_scores (recording_id);
create index if not exists scores_agent_idx     on public.call_scores (agent_id, created_at desc);


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.call_recordings enable row level security;
alter table public.call_scores     enable row level security;

-- recordings ----------------------------------------------------------------
drop policy if exists recordings_select_own on public.call_recordings;
drop policy if exists recordings_insert     on public.call_recordings;
drop policy if exists recordings_update_own on public.call_recordings;
drop policy if exists recordings_delete_own on public.call_recordings;
drop policy if exists recordings_admin      on public.call_recordings;

-- You can see a call if you were on it or you uploaded it.
create policy recordings_select_own on public.call_recordings
  for select using (agent_id = auth.uid() or uploaded_by = auth.uid());

create policy recordings_insert on public.call_recordings
  for insert with check (uploaded_by = auth.uid());

-- Agents may attach or correct a transcript, but may not push a row into a
-- terminal state — `scored` is written by the Edge Function alone.
create policy recordings_update_own on public.call_recordings
  for update using (agent_id = auth.uid() or uploaded_by = auth.uid())
  with check (status in ('uploaded', 'transcribed', 'failed'));

create policy recordings_delete_own on public.call_recordings
  for delete using (uploaded_by = auth.uid());

create policy recordings_admin on public.call_recordings
  for all using (public.is_admin()) with check (public.is_admin());

-- scores --------------------------------------------------------------------
-- Read-only to everyone. There is no insert or update policy on purpose: the
-- Edge Function writes with the service role, which bypasses RLS. If a client
-- could write here, an agent could grade their own call.
drop policy if exists scores_select_own on public.call_scores;
drop policy if exists scores_admin      on public.call_scores;

create policy scores_select_own on public.call_scores
  for select using (
    agent_id = auth.uid()
    or exists (
      select 1 from public.call_recordings r
      where r.id = recording_id and r.uploaded_by = auth.uid()
    )
  );

create policy scores_admin on public.call_scores
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Private storage bucket for audio
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'call-recordings', 'call-recordings', false, 104857600,  -- 100 MB
  array['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
        'audio/webm', 'audio/ogg', 'audio/aac', 'audio/x-m4a']
)
on conflict (id) do nothing;

-- Objects are keyed <uploader-uuid>/<recording-uuid>.<ext>, so the first path
-- segment is the ownership check. Anything else is unreachable.
drop policy if exists recordings_object_read   on storage.objects;
drop policy if exists recordings_object_write  on storage.objects;
drop policy if exists recordings_object_delete on storage.objects;
drop policy if exists recordings_object_admin  on storage.objects;

create policy recordings_object_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'call-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy recordings_object_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'call-recordings'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

create policy recordings_object_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'call-recordings'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );


-- ---------------------------------------------------------------------------
-- Scorecard rollups. SECURITY DEFINER, aggregates only — same reasoning as the
-- other leaderboards: everyone sees the ranking, nobody reads raw transcripts.
-- ---------------------------------------------------------------------------
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
    select s.agent_id, s.overall_score, s.compliance_passed,
           jsonb_array_length(s.findings) as finding_count
    from public.call_scores s
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

-- What scoring has cost, for the period. Admin-only by construction.
create or replace function public.scoring_spend(p_start date, p_end date)
returns table (
  calls_scored      bigint,
  total_cost_usd    numeric,
  avg_cost_usd      numeric,
  input_tokens      bigint,
  output_tokens     bigint,
  cache_read_tokens bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    coalesce(sum(s.cost_usd), 0),
    coalesce(round(avg(s.cost_usd), 5), 0),
    coalesce(sum(s.input_tokens), 0),
    coalesce(sum(s.output_tokens), 0),
    coalesce(sum(s.cache_read_tokens), 0)
  from public.call_scores s
  join public.call_recordings r on r.id = s.recording_id
  where r.call_on between p_start and p_end
    and public.is_admin();
$$;

grant execute on function public.scoring_leaderboard(date, date) to authenticated;
grant execute on function public.scoring_spend(date, date)       to authenticated;
