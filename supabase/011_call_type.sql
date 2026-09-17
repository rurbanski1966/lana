-- ============================================================================
-- Lana — migration 011: call type on call recordings
--
-- Additive. Run after 010. Safe to re-run.
--
-- A simple category tag for a call — Ancillary or Medicare — separate from
-- the script and the rubric. Nullable: existing calls just have no type
-- until someone edits them.
-- ============================================================================

alter table public.call_recordings add column if not exists call_type text;

do $$ begin
  alter table public.call_recordings
    add constraint call_recordings_call_type_check
    check (call_type is null or call_type in ('ancillary', 'medicare'));
exception when duplicate_object then null; end $$;
