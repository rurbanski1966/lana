-- ============================================================================
-- Lana — migration 012: reviewer approval status on calls
--
-- Additive. Run after 011. Safe to re-run.
--
-- Separate from the AI score and any manual override of it — this just
-- tracks whether a human reviewer has looked at the call and signed off on
-- it. Defaults to false, so every existing call starts Pending.
-- ============================================================================

alter table public.call_recordings add column if not exists reviewer_approved boolean not null default false;
alter table public.call_recordings add column if not exists reviewer_approved_by uuid references public.profiles (id) on delete set null;
alter table public.call_recordings add column if not exists reviewer_approved_at timestamptz;
