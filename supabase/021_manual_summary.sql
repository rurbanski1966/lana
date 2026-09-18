-- ============================================================================
-- Lana — migration 021: AI-generated summary of the reviewer's own changes
--
-- Additive. Run after 020. Safe to re-run.
--
-- Per Ryan 2026-09-18: "Summary of Call" and "What went well" / "What to
-- work on" should be AI-summarized from the manual reviewer's own notes and
-- grades, not a deterministic sentence-stitch. The summarize-review Edge
-- Function writes these columns (via service role) when triggered from
-- either the Generate report button or the Reviewer status Approve button.
--
-- manual_summary_generated_at is the cache key: summarize-review skips the
-- Anthropic call entirely (and returns the existing text) when this is
-- already newer than call_scores.overridden_at, so clicking Generate report
-- or Approve repeatedly after the first real generation costs nothing.
--
-- manual_summary_cost_usd is informational only — deliberately NOT folded
-- into cost_usd or summed by spend_summary()/my_metrics(), since doing so
-- would retroactively inflate a call's spend on whatever day it happened to
-- be scored, rather than the day the summary was actually generated.
-- ============================================================================

alter table public.call_scores add column if not exists manual_summary text;
alter table public.call_scores add column if not exists manual_strengths jsonb;
alter table public.call_scores add column if not exists manual_improvements jsonb;
alter table public.call_scores add column if not exists manual_summary_generated_at timestamptz;
alter table public.call_scores add column if not exists manual_summary_cost_usd numeric;
