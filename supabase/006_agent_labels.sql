-- ============================================================================
-- Lana — migration 006: label-only agents on call recordings
--
-- Additive. Run after 005. Safe to re-run.
--
-- A call can be tagged with a free-text agent_name instead of a real profile,
-- for recordings brought in before that person has a Lana login. agent_id
-- stays the source of truth once a real account exists — agent_name is only
-- read when agent_id is null. call_scores.agent_id is copied from the
-- recording (see score-call), so it has to allow null too.
-- ============================================================================

alter table public.call_recordings alter column agent_id drop not null;
alter table public.call_recordings add column if not exists agent_name text;

do $$ begin
  alter table public.call_recordings
    add constraint recordings_agent_identified
    check (agent_id is not null or agent_name is not null);
exception when duplicate_object then null; end $$;

alter table public.call_scores alter column agent_id drop not null;

create index if not exists recordings_agent_name_idx
  on public.call_recordings (agent_name) where agent_name is not null;

-- Every distinct label an admin has typed before, for the "remembered names"
-- dropdown on the upload form — and for browsing "everything for this name"
-- on the call list.
create or replace function public.recording_agent_names()
returns table (agent_name text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct r.agent_name
  from public.call_recordings r
  where r.agent_name is not null and public.is_admin()
  order by 1;
$$;

grant execute on function public.recording_agent_names() to authenticated;
