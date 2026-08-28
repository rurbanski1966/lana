-- ============================================================================
-- Lana — migration 004: editable scoring rubric
--
-- Additive. Run after 003. Safe to re-run.
--
-- Moves the grading criteria out of the Edge Function's source and into the
-- database, so the rubric can be read and changed from the app instead of
-- through a code edit and redeploy.
--
-- The prompt is stored as SEPARATE FIELDS, not one blob. score-call assembles
-- them in a fixed order every time. That matters for two reasons:
--   1. Prompt caching is a byte-exact prefix match. Deterministic assembly
--      means the cached prefix stays stable between calls.
--   2. A single freeform blob makes the UI a textarea. Separate fields let
--      the app show dimensions and compliance codes as editable lists.
--
-- Rubrics are VERSIONED AND IMMUTABLE-IN-SPIRIT: publishing an edit inserts a
-- new row and moves the active flag. Old scores reference the version that
-- graded them, so a score from March stays interpretable after the rubric
-- changes in August.
-- ============================================================================

create table if not exists public.scoring_rubrics (
  id                 uuid primary key default gen_random_uuid(),
  version            text not null unique,
  is_active          boolean not null default false,

  -- Assembled in this order by score-call.
  intro              text not null default '',
  scale              jsonb not null default '[]'::jsonb,  -- [{min,max,label,description}]
  scale_note         text not null default '',
  dimensions         jsonb not null default '[]'::jsonb,  -- [{key,label,description}]
  compliance_intro   text not null default '',
  finding_codes      jsonb not null default '[]'::jsonb,  -- [{code,label,description}]
  severity_guidance  text not null default '',
  evidence_rules     text not null default '',
  output_guidance    text not null default '',

  notes              text not null default '',            -- why this version exists
  created_at         timestamptz not null default now(),
  created_by         uuid references public.profiles (id) on delete set null,

  -- A dimension key becomes a JSON object key in the model's output schema and
  -- a column-ish key in call_scores.dimensions. Anything non-identifier-safe
  -- there produces a schema the API rejects, so guard it at write time.
  constraint dimensions_nonempty check (jsonb_array_length(dimensions) > 0)
);

-- Exactly one active rubric. A partial unique index is the enforcement, so a
-- bad write fails loudly instead of leaving two actives and a coin flip over
-- which one grades the next call.
create unique index if not exists scoring_rubrics_one_active
  on public.scoring_rubrics (is_active) where is_active;

create index if not exists scoring_rubrics_created_idx
  on public.scoring_rubrics (created_at desc);


-- ---------------------------------------------------------------------------
-- RLS: everyone reads, admins write.
--
-- Agents being able to read the rubric is deliberate. People graded by a
-- standard should be able to see the standard.
-- ---------------------------------------------------------------------------
alter table public.scoring_rubrics enable row level security;

drop policy if exists rubrics_read  on public.scoring_rubrics;
drop policy if exists rubrics_admin on public.scoring_rubrics;

create policy rubrics_read on public.scoring_rubrics
  for select to authenticated using (true);

create policy rubrics_admin on public.scoring_rubrics
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Publishing a new version.
--
-- Deactivate-then-activate has to be one statement's worth of atomic, or the
-- partial unique index rejects the moment both rows are active. Doing it in a
-- function also means the app can't forget a step.
-- ---------------------------------------------------------------------------
create or replace function public.publish_rubric(p_rubric_id uuid)
returns public.scoring_rubrics
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.scoring_rubrics;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can publish a rubric';
  end if;

  update public.scoring_rubrics set is_active = false where is_active;
  update public.scoring_rubrics set is_active = true where id = p_rubric_id
    returning * into result;

  if result.id is null then
    raise exception 'Rubric % not found', p_rubric_id;
  end if;

  return result;
end;
$$;

grant execute on function public.publish_rubric(uuid) to authenticated;

-- Used by score-call. SECURITY DEFINER so the function can read the active
-- rubric with the service role without depending on a user session.
create or replace function public.active_rubric()
returns public.scoring_rubrics
language sql
stable
security definer
set search_path = public
as $$
  select * from public.scoring_rubrics where is_active limit 1;
$$;

grant execute on function public.active_rubric() to authenticated;


-- ---------------------------------------------------------------------------
-- Seed: the rubric currently baked into rubric.ts, so the app shows a real
-- baseline the moment this migration runs rather than an empty screen.
-- ---------------------------------------------------------------------------
insert into public.scoring_rubrics (
  version, is_active, intro, scale, scale_note, dimensions,
  compliance_intro, finding_codes, severity_guidance, evidence_rules,
  output_guidance, notes
)
values (
  '2026-08-26.1',
  true,
  'You are a sales-quality reviewer for an insurance agency. You score recorded sales calls against a fixed rubric and return structured findings that a manager will use for coaching.

You are scoring the AGENT, not the prospect. A call where the prospect was rude or hung up early can still be a high-scoring call if the agent handled it well. A call that closed a sale can still be a low-scoring call if the agent got there by cutting corners.',

  '[
    {"min": 90, "max": 100, "label": "Exemplary",  "description": "Would be used as a training example."},
    {"min": 75, "max": 89,  "label": "Strong",     "description": "Minor refinements only."},
    {"min": 60, "max": 74,  "label": "Competent",  "description": "Did the job; clear room to improve."},
    {"min": 40, "max": 59,  "label": "Weak",       "description": "Missed material opportunities or made avoidable errors."},
    {"min": 0,  "max": 39,  "label": "Poor",       "description": "Would damage the agency''s results or reputation."}
  ]'::jsonb,

  'Use the whole range — a competent, unremarkable call is a 70, not a 90.

If a dimension genuinely did not occur in the call — the prospect hung up during the opening, so there was no close — score it 0 and say plainly in the rationale that it did not occur. Do not score an absent stage as average.',

  '[
    {"key": "opening", "label": "Opening & rapport", "weight": 1,
     "description": "Did the agent establish who they are, why they are calling, and earn permission to continue — without launching straight into a pitch?",
     "criteria": [
       "Gives their name and the agency name unprompted, early.",
       "States the reason for the call in one plain sentence.",
       "Confirms they are speaking to the intended person before discussing anything specific.",
       "Asks whether it is a workable time, and honours the answer.",
       "Tone is unhurried and conversational rather than read-aloud or apologetic.",
       "Does not begin presenting a product before the prospect has agreed to talk."
     ]},
    {"key": "discovery", "label": "Discovery", "weight": 2,
     "description": "Did the agent learn the prospect''s actual situation before proposing anything? This is the dimension that most often separates a good call from a bad one — an agent who presents before discovering should score low here regardless of how polished the presentation was.",
     "criteria": [
       "Asks what coverage the prospect has now, and what prompted them to look.",
       "Establishes which doctors, hospitals, or clinics the prospect wants to keep.",
       "Establishes current prescriptions by name where relevant.",
       "Surfaces budget or affordability constraints without pressuring.",
       "Asks open questions rather than yes/no ones.",
       "Lets the prospect finish; does not talk over or rush the answer.",
       "Reflects back what was heard to confirm it landed correctly."
     ]},
    {"key": "presentation", "label": "Presentation", "weight": 2,
     "description": "Was the recommendation tied to what discovery surfaced, and described accurately? Penalize accuracy problems hard: a fluent, friendly misstatement of a benefit is worse than an awkward correct one.",
     "criteria": [
       "Explicitly connects the recommendation to something the prospect said.",
       "States premium and the cost-sharing that will actually affect this prospect.",
       "States meaningful limitations and exclusions, not only benefits.",
       "Confirms — rather than assumes — whether named doctors or drugs are covered.",
       "Uses plain language; defines any insurance term it uses.",
       "Checks the prospect is following before moving to the next point.",
       "Presents one clear recommendation rather than an unfiltered list of options."
     ]},
    {"key": "objection_handling", "label": "Objection handling", "weight": 1,
     "description": "Did the agent find and answer the real concern? Distinguish handling from steamrolling — repeating the pitch louder is not handling. If no objection arose, score on whether the agent surfaced and addressed unspoken hesitation.",
     "criteria": [
       "Acknowledges the objection before answering it.",
       "Asks a clarifying question to find the concern underneath the stated one.",
       "Answers the actual concern rather than an easier adjacent one.",
       "Stays calm and does not interrupt or raise pressure.",
       "Accepts a genuine no without escalating.",
       "Confirms the concern is resolved before moving on."
     ]},
    {"key": "closing", "label": "Closing", "weight": 1,
     "description": "Was there a clear, specific, agreed next step? A polite ending with no next step is a weak close, not a neutral one.",
     "criteria": [
       "Proposes a concrete next step rather than \"I will follow up\".",
       "Attaches a specific day and time to it.",
       "Gets explicit agreement from the prospect.",
       "Recaps what will happen and what the prospect needs to have ready.",
       "Leaves a direct way to make contact in the meantime.",
       "Ends without applying last-minute pressure."
     ]}
  ]'::jsonb,

  'Report every compliance issue you observe as a separate finding. These are regulatory and reputational matters, so they are graded independently of the sales dimensions — a smooth, high-scoring sales call can still fail compliance, and you must say so when it does.',

  '[
    {"code": "recording_disclosure", "label": "Recording not disclosed",
     "description": "The call is being recorded and the agent did not disclose it."},
    {"code": "scope_of_appointment", "label": "Scope of appointment",
     "description": "The agent discussed a Medicare Advantage or Part D plan without an agreed scope of appointment covering that product type."},
    {"code": "permission_to_contact", "label": "Permission to contact",
     "description": "No established basis for the outbound contact, or the prospect asked not to be contacted and the agent continued."},
    {"code": "missing_disclaimer", "label": "Missing disclaimer",
     "description": "The agent did not state that they do not offer every plan available in the prospect''s area, where that statement was required."},
    {"code": "misleading_claim", "label": "Misleading claim",
     "description": "A benefit, cost, or affiliation was stated in a way that is inaccurate or would leave a reasonable listener with a false impression. Includes implying endorsement by Medicare or a government body."},
    {"code": "provider_network_claim", "label": "Unverified network claim",
     "description": "The agent asserted a specific doctor, hospital, or drug is covered without verifying it."},
    {"code": "unsolicited_cross_sell", "label": "Unsolicited cross-sell",
     "description": "The agent moved to a different product line without the prospect''s agreement."},
    {"code": "pressure_tactic", "label": "Pressure tactic",
     "description": "Manufactured urgency, refusing to end the call, or discouraging the prospect from consulting someone else."}
  ]'::jsonb,

  'Severity: `critical` for anything that likely breaks a rule on its own, `high` for a clear violation needing prompt correction, `medium` for a practice that will become a violation if repeated, `low` for a habit worth correcting. Set `compliance_passed` to false if any finding is `high` or `critical`.',

  'Every dimension rationale and every compliance finding must quote the transcript. Quote the shortest span that supports the point, verbatim, from the transcript you were given. If you cannot find a supporting quote, you do not have grounds for the point — drop it.

Do not infer facts that are not in the transcript. Transcripts are imperfect: speaker labels can be wrong and words are sometimes garbled. When a passage is ambiguous, say so in the rationale and score conservatively rather than assuming the worse reading. Never report a compliance finding that rests on a garbled passage.',

  '`overall_score` is your holistic judgment of the call, not an average of the dimensions — weight what actually mattered on this call. Keep it 0-100.

`summary` is two or three sentences a manager can read without opening the transcript. `coaching_focus` is the single highest-leverage thing this agent should work on next; name one thing, not a list.',

  'Initial baseline — the rubric originally compiled into the Edge Function.'
)
on conflict (version) do nothing;
