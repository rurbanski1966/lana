// ---------------------------------------------------------------------------
// score-call — Supabase Edge Function (Deno)
//
// Scores one transcribed call and writes call_scores.
//
// This runs server-side because ANTHROPIC_API_KEY cannot go in the browser:
// the frontend ships with the Supabase publishable key, and anything alongside
// it is published. It is also the only writer to call_scores — that table has
// no insert policy, so an agent cannot grade their own call.
//
// TWO WAYS IN, authorized differently:
//
//   1. The "Score call" button — carries the user's JWT. The recording is read
//      through that JWT, so RLS decides whether this user may score it.
//
//   2. A Database Webhook on UPDATE — no user session, proves itself with a
//      shared secret header and reads with the service role. Postgres already
//      established the row exists; there is nothing for RLS to decide.
//
// Loop safety for the webhook path: this function moves the row through
// 'scoring' and then 'scored', and each of those is an UPDATE that re-fires
// the webhook. Scoring only runs when status is exactly 'transcribed', so the
// echoes exit immediately instead of scoring the same call forever.
// ---------------------------------------------------------------------------
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

/* inlined from rubric.ts */
// ---------------------------------------------------------------------------
// Rubric assembly.
//
// The rubric itself is no longer here — it lives in public.scoring_rubrics and
// is edited from the app. This module turns a rubric row into the two things
// the model call needs: a system prompt and an output schema.
//
// There is deliberately NO built-in fallback rubric. If no active row exists,
// scoring fails loudly. A fallback would mean the app could display one set of
// criteria while a different set silently graded the calls — the exact bug
// that makes a score impossible to trust or reproduce.
//
// Assembly is DETERMINISTIC: fixed section order, fixed separators, no dates,
// no per-call values. That is what lets the prompt cache work — caching is a
// byte-exact prefix match, so the same rubric row must produce the same bytes
// every time. Reordering these sections would invalidate the cache on every
// call without changing a word of the rubric.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BUILTIN_RUBRIC — used only when the database has no active rubric.
//
// This exists so scoring works before migration 004 is applied, and keeps
// working if the rubrics table is ever empty. It is NOT silent: the version
// string is prefixed `builtin/`, and that string is written to
// call_scores.rubric_version, so any score graded this way says so on its own
// row. A fallback you can't identify afterwards would be worse than no
// fallback — you could never tell which criteria produced a given score.
//
// The database rubric always wins when one is active. Edits made on the Rubric
// page therefore take effect immediately and this block stops being consulted.
// Keep the text here in sync with the seed in 004_rubric.sql, or the two paths
// will grade differently.
// ---------------------------------------------------------------------------
const BUILTIN_RUBRIC: Rubric = {
  version: 'builtin/2026-08-26.1',
  intro:
`You are a sales-quality reviewer for an insurance agency. You score recorded sales calls against a fixed rubric and return structured findings that a manager will use for coaching.

You are scoring the AGENT, not the prospect. A call where the prospect was rude or hung up early can still be a high-scoring call if the agent handled it well. A call that closed a sale can still be a low-scoring call if the agent got there by cutting corners.`,
  scale: [
    { min: 90, max: 100, label: 'Exemplary', description: 'Would be used as a training example.' },
    { min: 75, max: 89, label: 'Strong', description: 'Minor refinements only.' },
    { min: 60, max: 74, label: 'Competent', description: 'Did the job; clear room to improve.' },
    { min: 40, max: 59, label: 'Weak', description: 'Missed material opportunities or made avoidable errors.' },
    { min: 0, max: 39, label: 'Poor', description: "Would damage the agency's results or reputation." },
  ],
  scale_note:
`Use the whole range — a competent, unremarkable call is a 70, not a 90.

If a dimension genuinely did not occur in the call — the prospect hung up during the opening, so there was no close — score it 0 and say plainly in the rationale that it did not occur. Do not score an absent stage as average.`,
  dimensions: [
    {
      key: 'opening', label: 'Opening & rapport', weight: 1,
      description: 'Did the agent establish who they are, why they are calling, and earn permission to continue — without launching straight into a pitch?',
      criteria: [
        'Gives their name and the agency name unprompted, early.',
        'States the reason for the call in one plain sentence.',
        'Confirms they are speaking to the intended person before discussing anything specific.',
        'Asks whether it is a workable time, and honours the answer.',
        'Tone is unhurried and conversational rather than read-aloud or apologetic.',
        'Does not begin presenting a product before the prospect has agreed to talk.',
      ],
    },
    {
      key: 'discovery', label: 'Discovery', weight: 2,
      description: "Did the agent learn the prospect's actual situation before proposing anything? This is the dimension that most often separates a good call from a bad one — an agent who presents before discovering should score low here regardless of how polished the presentation was.",
      criteria: [
        'Asks what coverage the prospect has now, and what prompted them to look.',
        'Establishes which doctors, hospitals, or clinics the prospect wants to keep.',
        'Establishes current prescriptions by name where relevant.',
        'Surfaces budget or affordability constraints without pressuring.',
        'Asks open questions rather than yes/no ones.',
        'Lets the prospect finish; does not talk over or rush the answer.',
        'Reflects back what was heard to confirm it landed correctly.',
      ],
    },
    {
      key: 'presentation', label: 'Presentation', weight: 2,
      description: 'Was the recommendation tied to what discovery surfaced, and described accurately? Penalize accuracy problems hard: a fluent, friendly misstatement of a benefit is worse than an awkward correct one.',
      criteria: [
        'Explicitly connects the recommendation to something the prospect said.',
        'States premium and the cost-sharing that will actually affect this prospect.',
        'States meaningful limitations and exclusions, not only benefits.',
        'Confirms — rather than assumes — whether named doctors or drugs are covered.',
        'Uses plain language; defines any insurance term it uses.',
        'Checks the prospect is following before moving to the next point.',
        'Presents one clear recommendation rather than an unfiltered list of options.',
      ],
    },
    {
      key: 'objection_handling', label: 'Objection handling', weight: 1,
      description: 'Did the agent find and answer the real concern? Distinguish handling from steamrolling — repeating the pitch louder is not handling. If no objection arose, score on whether the agent surfaced and addressed unspoken hesitation.',
      criteria: [
        'Acknowledges the objection before answering it.',
        'Asks a clarifying question to find the concern underneath the stated one.',
        'Answers the actual concern rather than an easier adjacent one.',
        'Stays calm and does not interrupt or raise pressure.',
        'Accepts a genuine no without escalating.',
        'Confirms the concern is resolved before moving on.',
      ],
    },
    {
      key: 'closing', label: 'Closing', weight: 1,
      description: 'Was there a clear, specific, agreed next step? A polite ending with no next step is a weak close, not a neutral one.',
      criteria: [
        'Proposes a concrete next step rather than "I will follow up".',
        'Attaches a specific day and time to it.',
        'Gets explicit agreement from the prospect.',
        'Recaps what will happen and what the prospect needs to have ready.',
        'Leaves a direct way to make contact in the meantime.',
        'Ends without applying last-minute pressure.',
      ],
    },
  ],
  compliance_intro:
'Report every compliance issue you observe as a separate finding. These are regulatory and reputational matters, so they are graded independently of the sales dimensions — a smooth, high-scoring sales call can still fail compliance, and you must say so when it does.',
  finding_codes: [
    { code: 'recording_disclosure', label: 'Recording not disclosed',
      description: 'The call is being recorded and the agent did not disclose it.' },
    { code: 'scope_of_appointment', label: 'Scope of appointment',
      description: 'The agent discussed a Medicare Advantage or Part D plan without an agreed scope of appointment covering that product type.' },
    { code: 'permission_to_contact', label: 'Permission to contact',
      description: 'No established basis for the outbound contact, or the prospect asked not to be contacted and the agent continued.' },
    { code: 'missing_disclaimer', label: 'Missing disclaimer',
      description: "The agent did not state that they do not offer every plan available in the prospect's area, where that statement was required." },
    { code: 'misleading_claim', label: 'Misleading claim',
      description: 'A benefit, cost, or affiliation was stated in a way that is inaccurate or would leave a reasonable listener with a false impression. Includes implying endorsement by Medicare or a government body.' },
    { code: 'provider_network_claim', label: 'Unverified network claim',
      description: 'The agent asserted a specific doctor, hospital, or drug is covered without verifying it.' },
    { code: 'unsolicited_cross_sell', label: 'Unsolicited cross-sell',
      description: "The agent moved to a different product line without the prospect's agreement." },
    { code: 'pressure_tactic', label: 'Pressure tactic',
      description: 'Manufactured urgency, refusing to end the call, or discouraging the prospect from consulting someone else.' },
  ],
  severity_guidance:
'Severity: `critical` for anything that likely breaks a rule on its own, `high` for a clear violation needing prompt correction, `medium` for a practice that will become a violation if repeated, `low` for a habit worth correcting. Set `compliance_passed` to false if any finding is `high` or `critical`.',
  evidence_rules:
`Every dimension rationale and every compliance finding must quote the transcript. Quote the shortest span that supports the point, verbatim, from the transcript you were given. If you cannot find a supporting quote, you do not have grounds for the point — drop it.

Do not infer facts that are not in the transcript. Transcripts are imperfect: speaker labels can be wrong and words are sometimes garbled. When a passage is ambiguous, say so in the rationale and score conservatively rather than assuming the worse reading. Never report a compliance finding that rests on a garbled passage.`,
  output_guidance:
`The bulleted criteria under each dimension are the specific behaviours to look for. They are a guide to what good looks like, not a checklist to tally — a call can score well while missing a bullet that did not apply, and can score badly while technically hitting several. Judge the dimension, and use the bullets to explain why.

Where a dimension carries a weight above 1, it matters proportionally more to the overall score.

\`overall_score\` is your holistic judgment of the call, not an average of the dimensions — weight what actually mattered here, informed by the dimension weights. Keep it 0-100.

\`summary\` is two or three sentences a manager can read without opening the transcript. \`coaching_focus\` is the single highest-leverage thing this agent should work on next; name one thing, not a list.`,
};

interface ScaleBand {
  min: number;
  max: number;
  label: string;
  description: string;
}

interface Dimension {
  key: string;
  label: string;
  description: string;
  // Concrete, checkable behaviours. These do the real work: "was discovery
  // good" is not gradeable, "asked about current prescriptions before
  // recommending" is. Editable per dimension from the Rubric page.
  criteria?: string[];
  // Relative importance when forming the overall score. 1 is normal; 2 counts
  // double. Not a strict multiplier — the model is told to weight its holistic
  // judgment, not to compute an average.
  weight?: number;
}

interface FindingCode {
  code: string;
  label: string;
  description: string;
}

interface Rubric {
  version: string;
  intro: string;
  scale: ScaleBand[];
  scale_note: string;
  dimensions: Dimension[];
  compliance_intro: string;
  finding_codes: FindingCode[];
  severity_guidance: string;
  evidence_rules: string;
  output_guidance: string;
}

// A dimension key becomes a JSON object key in the output schema. Anything
// outside this shape produces a schema the API rejects, and the failure
// surfaces as an opaque 400 rather than "your rubric is malformed".
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

function validateRubric(r: Rubric): string[] {
  const problems: string[] = [];

  if (!r.dimensions?.length) problems.push('Rubric has no dimensions.');
  if (!r.finding_codes) problems.push('Rubric has no finding_codes array.');

  const seenDim = new Set<string>();
  for (const d of r.dimensions ?? []) {
    if (!KEY_RE.test(d.key)) {
      problems.push(`Dimension key "${d.key}" must be lowercase letters, digits and underscores, starting with a letter.`);
    }
    if (seenDim.has(d.key)) problems.push(`Duplicate dimension key "${d.key}".`);
    seenDim.add(d.key);
  }

  const seenCode = new Set<string>();
  for (const c of r.finding_codes ?? []) {
    if (!KEY_RE.test(c.code)) {
      problems.push(`Finding code "${c.code}" must be lowercase letters, digits and underscores, starting with a letter.`);
    }
    if (seenCode.has(c.code)) problems.push(`Duplicate finding code "${c.code}".`);
    seenCode.add(c.code);
  }

  return problems;
}

function buildSystemPrompt(r: Rubric): string {
  const scaleLines = (r.scale ?? [])
    .map(b => `- ${b.min}-${b.max}  ${b.label}. ${b.description}`)
    .join('\n');

  const dimensionLines = (r.dimensions ?? [])
    .map(d => {
      const weight = d.weight && d.weight !== 1 ? ` [weight: ${d.weight}x]` : '';
      const criteria = d.criteria?.length
        ? '\n' + d.criteria.map(c => `  - ${c}`).join('\n')
        : '';
      return `**${d.key}** (${d.label})${weight} — ${d.description}${criteria}`;
    })
    .join('\n\n');

  const codeLines = (r.finding_codes ?? [])
    .map(c => `- \`${c.code}\` (${c.label}) — ${c.description}`)
    .join('\n');

  // Fixed section order. Do not reorder — see the caching note at the top.
  return [
    r.intro,
    '## Scoring scale\n\nEvery dimension is scored 0-100 on this scale.\n\n' + scaleLines,
    r.scale_note,
    '## Dimensions\n\n' + dimensionLines,
    '## Compliance\n\n' + r.compliance_intro,
    'Finding codes:\n\n' + codeLines,
    r.severity_guidance,
    '## Evidence\n\n' + r.evidence_rules,
    '## Output\n\n' + r.output_guidance,
  ]
    .map(s => (s ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// Structured-output schema, derived from the rubric so the model can only
// return the dimensions and codes that are actually defined.
//
// Note what is NOT expressible here: JSON Schema numeric bounds and string
// lengths are unsupported by structured outputs, so "0-100" lives in the
// prompt text and index.ts clamps on the way in.
function buildOutputSchema(r: Rubric) {
  const dimensionSchema = {
    type: 'object',
    properties: {
      score: { type: 'integer', description: '0-100 on the rubric scale.' },
      rationale: { type: 'string', description: 'Two or three sentences justifying the score.' },
      evidence: { type: 'string', description: 'A short verbatim quote from the transcript.' },
    },
    required: ['score', 'rationale', 'evidence'],
    additionalProperties: false,
  };

  const keys = r.dimensions.map(d => d.key);
  const codes = r.finding_codes.map(c => c.code);

  return {
    type: 'object',
    properties: {
      overall_score: { type: 'integer', description: 'Holistic 0-100 score for the call.' },
      dimensions: {
        type: 'object',
        properties: Object.fromEntries(keys.map(k => [k, dimensionSchema])),
        required: keys,
        additionalProperties: false,
      },
      compliance_passed: {
        type: 'boolean',
        description: 'False if any finding is high or critical severity.',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // An empty enum is invalid JSON Schema, so a rubric with no
            // compliance codes falls back to a free string rather than
            // producing a schema the API rejects.
            code: codes.length
              ? { type: 'string', enum: codes }
              : { type: 'string', description: 'Compliance issue identifier.' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            detail: { type: 'string', description: 'What happened, in one or two sentences.' },
            evidence: { type: 'string', description: 'Verbatim quote from the transcript.' },
          },
          required: ['code', 'severity', 'detail', 'evidence'],
          additionalProperties: false,
        },
      },
      strengths: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      coaching_focus: { type: 'string' },
    },
    required: [
      'overall_score', 'dimensions', 'compliance_passed', 'findings',
      'strengths', 'improvements', 'summary', 'coaching_focus',
    ],
    additionalProperties: false,
  };
}

/* end rubric.ts */


const MODEL = Deno.env.get('SCORING_MODEL') ?? 'claude-opus-5';
const EFFORT = Deno.env.get('SCORING_EFFORT') ?? 'high';
const MAX_TRANSCRIPT_CHARS = Number(Deno.env.get('MAX_TRANSCRIPT_CHARS') ?? 200_000);

// Kill switch for the automatic path. Set AUTO_SCORE=off to stop webhook-driven
// scoring without deleting the webhook or redeploying — the button keeps
// working. Useful when a bulk import would otherwise score hundreds of calls.
const AUTO_SCORE = (Deno.env.get('AUTO_SCORE') ?? 'on').toLowerCase() !== 'off';

// Claude Opus 5 list pricing, USD per million tokens. Cache reads bill at
// ~0.1x input. Update these together with MODEL — a stale table produces
// confidently wrong cost reporting, which is worse than none.
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1 },
};

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Length-independent compare so a wrong secret can't be narrowed down by
// timing the response.
function constantTimeEquals(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const bearer = (h: string | null) => (h ?? '').replace(/^Bearer\s+/i, '').trim();

// Two ways a request can prove it is machine-to-machine, and accepting BOTH is
// deliberate.
//
// The shared header is explicit but has to be kept identical in three places —
// this secret, and the header on every webhook. Change one and automation dies
// with no error anywhere a person looks. Supabase already attaches the service
// role key to webhook calls, so accepting that too means a correctly-created
// webhook works with nothing to keep in sync.
function classifyCaller(req: Request) {
  const providedSecret = req.headers.get('x-webhook-secret');
  const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
  const authValue = bearer(req.headers.get('Authorization'));

  if (constantTimeEquals(providedSecret, expectedSecret)) {
    return { kind: 'webhook' as const, via: 'shared-secret' };
  }
  if (constantTimeEquals(authValue, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
    return { kind: 'webhook' as const, via: 'service-role' };
  }
  // A wrong secret used to fall through and report "Missing Authorization
  // header", which is actively misleading — it sent us debugging the wrong
  // header for an hour. Name what actually failed.
  if (providedSecret) {
    return { kind: 'bad-secret' as const, via: 'shared-secret' };
  }
  return { kind: 'user' as const, via: 'jwt' };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // GET = config self-check. Every misconfiguration in this system so far has
  // been invisible until a call failed hours later: a missing key, a rubric
  // that was never published, a secret that matched in one place and not
  // another. This answers all of it in one request, before anyone uploads
  // anything. Booleans only — no secret values are ever returned.
  if (req.method === 'GET') {
    let rubricVersion: string | null = null;
    let rubricError: string | null = null;
    try {
      const { data, error } = await serviceClient.rpc('active_rubric');
      if (error) rubricError = error.message;
      else {
        const row = Array.isArray(data) ? data[0] : data;
        rubricVersion = row?.version ?? null;
      }
    } catch (e) {
      rubricError = e instanceof Error ? e.message : String(e);
    }

    const caller = classifyCaller(req);
    return json({
      function: 'score-call',
      // Scoring works with the built-in rubric, so readiness turns on the API
      // key alone. rubric.in_use tells you which one would actually grade.
      ok: Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
      rubric_in_use: rubricVersion ?? BUILTIN_RUBRIC.version,
      secrets: {
        ANTHROPIC_API_KEY: Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
        WEBHOOK_SECRET: Boolean(Deno.env.get('WEBHOOK_SECRET')),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
      },
      rubric: { active_version: rubricVersion, error: rubricError },
      scoring: { model: MODEL, effort: EFFORT, auto_score: AUTO_SCORE },
      // Lets you confirm a webhook's credentials are right by replaying its
      // headers here, instead of discovering it when a call silently fails.
      your_credentials: caller.kind === 'webhook'
        ? `accepted (${caller.via})`
        : caller.kind === 'bad-secret'
          ? 'x-webhook-secret was sent but does NOT match WEBHOOK_SECRET'
          : 'no machine credentials (would be treated as a user request)',
    });
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST only' }, 405);

  const caller = classifyCaller(req);
  if (caller.kind === 'bad-secret') {
    return json({ error: 'x-webhook-secret does not match WEBHOOK_SECRET on this project.' }, 401);
  }
  const isWebhook = caller.kind === 'webhook';

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  // A webhook posts { type, table, record, old_record }; the UI posts
  // { recording_id }. Accept both shapes.
  const record = (body.record ?? null) as Record<string, unknown> | null;
  const recordingId = (body.recording_id ?? record?.id) as string | undefined;
  if (!recordingId) return json({ error: 'recording_id is required' }, 400);

  const COLS = 'id, agent_id, transcript, status, title, call_on, duration_seconds, script_id';
  let rec: {
    id: string; agent_id: string; transcript: string | null; status: string; script_id: string | null;
  } | null;

  if (isWebhook) {
    if (!AUTO_SCORE) return json({ skipped: 'AUTO_SCORE is off' });
    const { data, error } = await serviceClient
      .from('call_recordings').select(COLS).eq('id', recordingId).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  } else {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

    // Authorization IS this read: a recording the caller may not see comes
    // back null, which is exactly the answer we want.
    const { data, error } = await userClient
      .from('call_recordings').select(COLS).eq('id', recordingId).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  }

  if (!rec) return json({ error: 'Recording not found, or not yours to score.' }, 404);

  if (isWebhook) {
    // The narrow gate that makes the automatic path safe. Every other status —
    // including the 'scoring' and 'scored' updates this function itself
    // writes — exits here. 200 rather than 4xx so the webhook log shows real
    // failures instead of routine no-ops.
    if (rec.status !== 'transcribed') return json({ skipped: `status is ${rec.status}` });
    if (!rec.transcript?.trim()) return json({ skipped: 'no transcript' });
  } else {
    if (!rec.transcript?.trim()) return json({ error: 'This recording has no transcript yet.' }, 409);
    if (rec.status === 'scoring') return json({ error: 'This recording is already being scored.' }, 409);
  }

  const full = rec.transcript!.trim();
  const transcript = full.slice(0, MAX_TRANSCRIPT_CHARS);
  const truncated = full.length > MAX_TRANSCRIPT_CHARS;

  await serviceClient
    .from('call_recordings')
    .update({ status: 'scoring', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', rec.id);

  try {
    // The rubric comes from the database, not from this file. No fallback: if
    // there is no active rubric, fail rather than grade with something other
    // than what the app displays.
    // Database rubric wins when one is active; otherwise fall back to the copy
    // compiled into this function so scoring works before migration 004 is
    // applied. The fallback's version string is prefixed `builtin/` and is
    // written to the score row, so you can always tell which criteria graded
    // a given call.
    let rubric: Rubric = BUILTIN_RUBRIC;
    try {
      const { data, error } = await serviceClient.rpc('active_rubric');
      if (!error) {
        const row = (Array.isArray(data) ? data[0] : data) as Rubric | null;
        if (row?.version) rubric = row;
      }
    } catch {
      // Missing RPC or unreachable table — the built-in rubric stands in.
    }

    const problems = validateRubric(rubric);
    if (problems.length) {
      throw new Error(`Active rubric "${rubric.version}" is invalid: ${problems.join(' ')}`);
    }

    const systemPrompt = buildSystemPrompt(rubric);
    const outputSchema = buildOutputSchema(rubric);

    // The script is per-call, like the transcript — it goes in the user
    // message, never the cached system block, or every script would fork the
    // prompt cache and the rubric would never be read from it again.
    let script: { name: string; content: string } | null = null;
    if (rec.script_id) {
      const { data } = await serviceClient
        .from('scripts')
        .select('name, content')
        .eq('id', rec.script_id)
        .maybeSingle();
      script = data;
    }
    const scriptBlock = script?.content?.trim()
      ? `\n\nThe agent was expected to follow this specific script on this call. Judge how closely ` +
        `they followed it — required points covered, order, disclosures, and language — and factor ` +
        `adherence into your dimension scores (particularly Presentation) and into the summary and ` +
        `coaching_focus. A good-faith adaptation that still hits the script's substance is not itself ` +
        `a violation; skipping a required point or disclosure is.` +
        `\n\n<script name="${script!.name.replace(/"/g, "'")}">\n${script!.content.trim()}\n</script>`
      : '';

    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! });

    // Prompt cache layout. Render order is tools -> system -> messages, so the
    // breakpoint on the system block caches the whole rubric; the transcript
    // sits after it and varies per call without touching the cached prefix.
    // Everything before that marker must be byte-identical across calls —
    // interpolating the agent's name or today's date up here would give every
    // request its own cache entry and nothing would ever be read.
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      // Thinking is on by default on Opus 5 and its tokens count against
      // max_tokens, so the ceiling above is sized for reasoning + output.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: outputSchema },
      },
      // Opus 5's safety classifiers can decline a request. Without a fallback
      // the call just stops; "default" re-runs it on Anthropic's recommended
      // substitute, routed by refusal category.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content:
            `Score this sales call.${truncated ? '\n\nNOTE: the transcript was truncated for length; score only what is present and say so in the summary.' : ''}` +
            scriptBlock +
            `\n\n<transcript>\n${transcript}\n</transcript>`,
        },
      ],
    });

    const message = await stream.finalMessage();

    // Check stop_reason before touching content. On a refusal, content is
    // empty or partial — indexing it blind throws, and a truncated response
    // would parse as a real score.
    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Scoring was declined by the model's safety classifiers` +
        (message.stop_details?.category ? ` (${message.stop_details.category}).` : '.')
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('Model hit the output limit before finishing. Raise max_tokens or lower effort.');
    }

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Model returned no text block.');
    }

    const parsed = JSON.parse(textBlock.text);

    // The schema guarantees shape, not range: structured outputs don't support
    // JSON Schema numeric bounds, so "0-100" lives in the prompt and is
    // enforced here.
    const dimensions: Record<string, unknown> = {};
    for (const dim of rubric.dimensions) {
      const d = parsed.dimensions?.[dim.key] ?? {};
      dimensions[dim.key] = {
        // Label is stored alongside the score so an old row still renders
        // correctly after the rubric renames or drops that dimension.
        label: dim.label,
        score: clamp(d.score),
        rationale: String(d.rationale ?? ''),
        evidence: String(d.evidence ?? ''),
      };
    }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    // Recompute rather than trusting the model's own boolean — this is the
    // field a manager acts on, and it must follow from the findings.
    const compliancePassed = !findings.some(
      (f: { severity?: string }) => f.severity === 'high' || f.severity === 'critical'
    );

    const usage = message.usage;
    const price = PRICING[MODEL] ?? { input: 0, output: 0, cacheRead: 0 };
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const costUsd =
      (inputTokens * price.input +
        outputTokens * price.output +
        cacheRead * price.cacheRead +
        cacheWrite * price.input * 1.25) / 1_000_000;

    const { data: score, error: insertError } = await serviceClient
      .from('call_scores')
      .insert({
        recording_id: rec.id,
        agent_id: rec.agent_id,
        script_id: rec.script_id,
        overall_score: clamp(parsed.overall_score),
        dimensions,
        compliance_passed: compliancePassed,
        findings,
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        summary: String(parsed.summary ?? ''),
        coaching_focus: String(parsed.coaching_focus ?? ''),
        model: message.model ?? MODEL,
        rubric_version: rubric.version,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cost_usd: Number(costUsd.toFixed(5)),
      })
      .select()
      .single();

    if (insertError) throw new Error(insertError.message);

    await serviceClient
      .from('call_recordings')
      .update({ status: 'scored', updated_at: new Date().toISOString() })
      .eq('id', rec.id);

    return json({
      score,
      cached_tokens: cacheRead,
      cost_usd: score.cost_usd,
      via: isWebhook ? 'webhook' : 'ui',
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);

    // Park the row in a state the UI can retry from rather than leaving it
    // stuck on 'scoring' forever.
    await serviceClient
      .from('call_recordings')
      .update({
        status: 'failed',
        error_message: messageText.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rec.id);

    console.error('score-call failed', { recording_id: rec.id, error: messageText });
    return json({ error: messageText }, 500);
  }
});
