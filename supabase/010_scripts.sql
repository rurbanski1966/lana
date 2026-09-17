-- ============================================================================
-- Lana — migration 010: call scripts
--
-- Additive. Run after 009. Safe to re-run.
--
-- A script is the talk-track an agent is supposed to follow on a call —
-- separate from the rubric, which is HOW every call gets graded regardless
-- of which script it was. Selecting one on upload tells score-call what the
-- agent was actually supposed to say, so the model can judge adherence to
-- that specific script instead of only the general rubric criteria.
-- ============================================================================

create table if not exists public.scripts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  content     text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null
);

-- Nullable and on delete set null: a call or score should never disappear
-- just because the script behind it was later removed or renamed.
alter table public.call_recordings add column if not exists script_id uuid references public.scripts (id) on delete set null;
alter table public.call_scores     add column if not exists script_id uuid references public.scripts (id) on delete set null;

alter table public.scripts enable row level security;

drop policy if exists scripts_read        on public.scripts;
drop policy if exists scripts_write_admin on public.scripts;

-- Everyone signed in can read the list — anyone uploading a call needs to
-- pick from it, not just admins.
create policy scripts_read on public.scripts
  for select to authenticated using (true);

create policy scripts_write_admin on public.scripts
  for all using (public.is_admin()) with check (public.is_admin());
