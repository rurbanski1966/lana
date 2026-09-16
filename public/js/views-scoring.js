// ---------------------------------------------------------------------------
// Call scoring: review list, single-call detail, admin scorecard.
//
// No model calls happen here. The browser uploads audio, stores a transcript,
// and asks an Edge Function to score — the Anthropic key never reaches the
// client.
// ---------------------------------------------------------------------------
import * as db from './db.js';
import { SCORE_DIMENSIONS, FINDING_CODES, FINDING_SEVERITIES, RECORDING_STATUSES } from './config.js';
import {
  esc, fmtNum, fmtDate, fmtMoneyExact, today, range, RANGES,
  toast, statTile, barRow, empty, spinner, selectField,
} from './ui.js';

/* --- helpers ------------------------------------------------------------- */

const statusChipFor = status => {
  const s = RECORDING_STATUSES.find(x => x.value === status);
  if (!s) return esc(status);
  return `<span class="chip chip--${s.tone}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
};

const severityChip = severity => {
  const s = FINDING_SEVERITIES.find(x => x.value === severity);
  if (!s) return esc(severity);
  return `<span class="chip chip--${s.tone}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
};

// Scores live on a fixed 0-100 scale, so bars are drawn against 100 — not
// against the highest score in the set. Scaling to the local max would render
// five mediocre scores as a full-width row of bars.
const SCORE_MAX = 100;

// Render whatever dimensions the score actually contains, rather than a fixed
// list. The rubric is editable, so a score from an older version may carry
// dimensions that no longer exist — and a newer one may add some. Iterating a
// hardcoded list would silently drop both.
const entriesOf = dims => Object.entries(dims ?? {}).filter(([, v]) => v && typeof v === 'object');

// Calibration (score_reviews) always compares against the model's own
// dimensions, regardless of any override — it's tuning the rubric, not
// reading the authoritative number. Keep this reading raw score.dimensions.
const dimensionEntries = score => entriesOf(score?.dimensions);

// Label precedence: the one stamped on the score when it was graded, then the
// current config, then a readable form of the key. The stamped label is first
// so an old score keeps the wording it was actually graded under.
const dimLabel = (key, v) =>
  v?.label
  || SCORE_DIMENSIONS.find(d => d.key === key)?.label
  || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const scoreTone = n =>
  n >= 75 ? 'var(--good)' : n >= 60 ? 'var(--warning)' : n >= 40 ? 'var(--serious)' : 'var(--critical)';

const fmtDuration = seconds => {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Turn a transcript into readable turns.
//
// Diarized output arrives as "Speaker 0: ..." lines; a pasted transcript may
// use real names, or no labels at all. Anything that doesn't match a label
// pattern is rendered as an unattributed line rather than being dropped —
// losing text here would mean the reader can't verify an evidence quote,
// which is the entire point of showing the transcript.
const SPEAKER_RE = /^\s*([A-Za-z][\w .'’-]{0,28}?)\s*:\s*(.*)$/;

function transcriptHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const turns = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(SPEAKER_RE);
    if (m && m[2] !== undefined) {
      turns.push({ who: m[1].trim(), text: m[2] });
    } else if (turns.length && !turns[turns.length - 1].who) {
      // Continuation of an unlabeled block — keep it together.
      turns[turns.length - 1].text += '\n' + line;
    } else {
      turns.push({ who: null, text: line });
    }
  }

  if (turns.length === 0) return empty('Transcript is empty.');

  // Stable speaker ordering so the same person keeps the same side/indent
  // through the whole call, regardless of who talks first.
  const speakers = [...new Set(turns.map(t => t.who).filter(Boolean))];

  return `<div class="transcript">${turns.map((t, i) => {
    const idx = t.who ? speakers.indexOf(t.who) % 2 : 0;
    return `
      <div class="turn${t.who ? ` turn--s${idx}` : ' turn--plain'}">
        <div class="turn__no">${i + 1}</div>
        ${t.who ? `<div class="turn__who">${esc(t.who)}</div>` : '<div class="turn__who"></div>'}
        <div class="turn__text">${esc(t.text)}</div>
      </div>`;
  }).join('')}</div>`;
}

/* === Review list ========================================================== */
export async function reviews(main, ctx) {
  const isAdmin = ctx.profile.role === 'admin';

  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Call reviews</h1>
      <div class="page__sub">Upload a call or paste a transcript, then score it</div>
    </div></div>
    <div class="card" id="new" style="max-width:680px">${spinner()}</div>
    <div class="card" id="list">${spinner()}</div>`;

  const people = isAdmin ? await db.listAgents() : [];
  const rememberedNames = isAdmin ? await db.recordingAgentNames() : [];

  // Typed against a datalist: matches an existing account's name (case-
  // insensitive) and it's a real agent; anything else is saved as a label
  // with no login, per Ryan 2026-09-16 — recordings/grades still need to be
  // browsable by that name later, hence recordingAgentNames() below.
  const activePeople = people.filter(p => p.active);
  const nameToId = new Map(activePeople.map(p => [(p.full_name || p.email).trim().toLowerCase(), p.id]));

  /* --- new recording --- */
  const newCard = document.getElementById('new');
  newCard.innerHTML = `
    <div class="card__head">
      <h2>Add a call</h2>
      <span class="muted">Audio, transcript, or both</span>
    </div>
    <form id="rec-form">
      <div class="grid-2">
        <label class="field">
          <span>Title</span>
          <input type="text" id="title" maxlength="120" placeholder="e.g. Tuesday MAPD callback">
        </label>
        <label class="field">
          <span>Call date *</span>
          <input type="date" id="call_on" value="${today()}" max="${today()}" required>
        </label>
      </div>

      ${isAdmin ? `
        <label class="field">
          <span>Agent on the call *</span>
          <input type="text" id="agent_input" list="agent-datalist" required
                 placeholder="Start typing a name…"
                 value="${esc(ctx.profile.full_name || '')}">
          <datalist id="agent-datalist">
            ${activePeople.map(p => `<option value="${esc(p.full_name || p.email)}">`).join('')}
            ${rememberedNames.map(n => `<option value="${esc(n)}">`).join('')}
          </datalist>
          <span class="muted" style="font-size:12px">
            Pick an existing account, or type a new name — it's saved as a label with no login and remembered here next time.
          </span>
        </label>` : ''}

      <label class="field">
        <span>Audio file</span>
        <input type="file" id="audio" accept="audio/*">
        <span class="muted" style="font-size:12px">Optional. Up to 100 MB. Needed only if you want automatic transcription.</span>
      </label>

      <label class="field">
        <span>Transcript</span>
        <textarea id="transcript" rows="6" placeholder="Paste the transcript here, or leave blank and transcribe the audio."></textarea>
        <span class="muted" style="font-size:12px">Speaker labels help — the rubric grades the agent, not the prospect.</span>
      </label>

      <button class="btn btn--primary" type="submit" id="rec-save">Add call</button>
    </form>`;

  newCard.querySelector('#rec-form').addEventListener('submit', async e => {
    e.preventDefault();
    const val = id => newCard.querySelector('#' + id)?.value.trim() ?? '';
    const file = newCard.querySelector('#audio').files[0];
    const transcript = newCard.querySelector('#transcript').value;

    if (!file && !transcript.trim()) {
      return toast('Add an audio file or a transcript.', 'error');
    }

    let agentId = ctx.profile.id;
    let agentName = null;
    if (isAdmin) {
      const typed = val('agent_input');
      if (!typed) return toast('Enter or pick an agent.', 'error');
      const matchedId = nameToId.get(typed.toLowerCase());
      if (matchedId) { agentId = matchedId; } else { agentId = null; agentName = typed; }
    }

    const btn = newCard.querySelector('#rec-save');
    btn.disabled = true;
    btn.textContent = file ? 'Uploading…' : 'Saving…';

    try {
      const storagePath = file ? await db.uploadAudio(file) : null;
      await db.createRecording({
        agent_id: agentId,
        agent_name: agentName,
        title: val('title'),
        call_on: val('call_on'),
        storage_path: storagePath,
        transcript,
      });
      toast('Call added.', 'ok');
      newCard.querySelector('#rec-form').reset();
      newCard.querySelector('#call_on').value = today();
      draw();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add call';
    }
  });

  /* --- list --- */
  const list = document.getElementById('list');

  // Every recording for one person, real account or label — the "folder" an
  // admin opens to see everything scored for that name so far.
  const filterOptions = isAdmin
    ? [
        { value: '', label: 'All calls' },
        ...activePeople.map(p => ({ value: `id:${p.id}`, label: p.full_name || p.email })),
        ...rememberedNames.map(n => ({ value: `name:${n}`, label: n })),
      ]
    : [];

  if (isAdmin) {
    document.querySelector('#list').insertAdjacentHTML('beforebegin', `
      <div class="filters">${selectField('agent-filter', 'Agent', filterOptions, '')}</div>`);
    document.getElementById('agent-filter').addEventListener('change', () => draw());
  }

  async function draw() {
    list.innerHTML = spinner();
    const filter = isAdmin ? document.getElementById('agent-filter').value : '';
    const [kind, value] = filter.split(/:(.*)/s);
    const rows = await db.listRecordings({
      limit: filter ? 500 : 100,
      agentId: kind === 'id' ? value : undefined,
      agentName: kind === 'name' ? value : undefined,
    });

    if (rows.length === 0) {
      list.innerHTML = empty('No calls yet.');
      return;
    }

    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} call${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted">${fmtNum(rows.filter(r => r.status === 'scored').length)} scored</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Date</th><th>Call</th><th>Agent</th><th>Length</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td class="tnum">${esc(fmtDate(r.call_on))}</td>
            <td>${esc(r.title || 'Untitled call')}${r.error_message
              ? `<br><span class="muted">${esc(r.error_message.slice(0, 80))}</span>` : ''}</td>
            <td>${esc(r.agent?.full_name || r.agent_name || '—')}</td>
            <td class="tnum muted">${esc(fmtDuration(r.duration_seconds))}</td>
            <td>${statusChipFor(r.status)}</td>
            <td><a class="btn btn--ghost btn--sm" href="#/reviews/${esc(r.id)}">Open</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  await draw();
}

/* === Single call ========================================================== */
export async function reviewDetail(main, ctx, recordingId) {
  main.innerHTML = `<div class="card">${spinner()}</div>`;

  async function draw() {
    const rec = await db.getRecording(recordingId);
    if (!rec) {
      main.innerHTML = `
        <div class="page__head"><h1>Call not found</h1></div>
        <div class="card">${empty('This call does not exist, or is not visible to your account.')}</div>`;
      return;
    }

    const score = rec.status === 'scored' ? await db.scoreForRecording(rec.id) : null;
    const busy = rec.status === 'transcribing' || rec.status === 'scoring';

    main.innerHTML = `
      <div class="page__head">
        <div>
          <h1>${esc(rec.title || 'Untitled call')}</h1>
          <div class="page__sub">
            ${esc(fmtDate(rec.call_on))} · ${esc(rec.agent?.full_name || rec.agent_name || '—')} · ${statusChipFor(rec.status)}
          </div>
        </div>
        <a class="btn btn--ghost" href="#/reviews">Back</a>
      </div>

      ${rec.error_message ? `
        <div class="card" style="border-color:var(--critical)">
          <h2>Last attempt failed</h2>
          <p class="muted">${esc(rec.error_message)}</p>
        </div>` : ''}

      <div class="card">
        <div class="card__head">
          <h2>Actions</h2>
          ${busy ? `<span class="muted">Working… reload in a moment</span>` : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${rec.storage_path ? `<button class="btn" id="play">Play audio</button>` : ''}
          ${rec.storage_path && !rec.transcript
            ? `<button class="btn" id="transcribe"${busy ? ' disabled' : ''}>Transcribe audio</button>` : ''}
          ${rec.transcript
            ? `<button class="btn btn--primary" id="score"${busy ? ' disabled' : ''}>
                 ${score ? 'Re-score call' : 'Score call'}
               </button>` : ''}
          <button class="btn btn--ghost" id="reload">Reload</button>
        </div>
        <div id="player" style="margin-top:14px"></div>
        ${!rec.transcript ? `
          <form id="paste-form" style="margin-top:18px">
            <label class="field">
              <span>Paste a transcript</span>
              <textarea id="paste" rows="6" placeholder="Speaker 0: ..."></textarea>
            </label>
            <button class="btn" type="submit">Save transcript</button>
          </form>` : ''}
      </div>

      <div id="score-area">${score ? scoreHtml(score) : ''}</div>
      <div id="override-area">${score && ctx.profile.role === 'admin' ? spinner() : ''}</div>
      <div id="review-area">${score ? spinner() : ''}</div>

      ${rec.transcript ? `
        <div class="card">
          <div class="card__head">
            <h2>Full transcript</h2>
            <span class="muted">
              ${fmtNum(rec.transcript.split(/\r?\n/).filter(l => l.trim()).length)} lines ·
              ${fmtNum(rec.transcript.length)} characters ·
              ${esc(rec.transcript_source || 'unknown source')}
            </span>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:14px">
            <button class="btn btn--ghost btn--sm" id="copy-transcript">Copy transcript</button>
            <button class="btn btn--ghost btn--sm" id="toggle-wrap">Toggle raw text</button>
          </div>
          <div id="transcript-view">${transcriptHtml(rec.transcript)}</div>
          <pre id="transcript-raw" class="transcript-raw" hidden>${esc(rec.transcript)}</pre>
        </div>` : ''}`;

    document.getElementById('reload').addEventListener('click', draw);
    if (score && ctx.profile.role === 'admin') drawOverride(score, draw);
    if (score) drawReview(score);

    document.getElementById('play')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const url = await db.audioUrl(rec.storage_path);
        document.getElementById('player').innerHTML =
          `<audio controls src="${esc(url)}" style="width:100%"></audio>`;
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });

    document.getElementById('transcribe')?.addEventListener('click', async e => {
      e.target.disabled = true;
      e.target.textContent = 'Transcribing…';
      try {
        await db.transcribeCall(rec.id);
        toast('Transcript ready.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });

    document.getElementById('score')?.addEventListener('click', async e => {
      e.target.disabled = true;
      e.target.textContent = 'Scoring…';
      try {
        const result = await db.scoreCall(rec.id);
        toast(`Scored. Cost ${fmtMoneyExact(result?.cost_usd ?? 0)}.`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });

    document.getElementById('paste-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const text = document.getElementById('paste').value;
      if (!text.trim()) return toast('Paste a transcript first.', 'error');
      try {
        await db.saveTranscript(rec.id, text);
        toast('Transcript saved.', 'ok');
        draw();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('copy-transcript')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rec.transcript);
        toast('Transcript copied.', 'ok');
      } catch {
        // clipboard API needs a secure context; localhost counts, but a plain
        // http:// LAN address does not — say so rather than failing silently.
        toast('Copy blocked by the browser. Use "Toggle raw text" and select it.', 'error');
      }
    });

    document.getElementById('toggle-wrap')?.addEventListener('click', () => {
      const pretty = document.getElementById('transcript-view');
      const raw = document.getElementById('transcript-raw');
      const showRaw = raw.hidden;
      raw.hidden = !showRaw;
      pretty.hidden = showRaw;
    });
  }

  await draw();
}

/* --- manual override ------------------------------------------------------
   The one admin-made call that's authoritative for a score. Editing starts
   from the model's own numbers so an admin only has to change what's
   actually wrong — re-typing everything to agree with the model would be
   friction with no purpose. Separate from score_reviews below, which never
   overrides anything on its own.
   -------------------------------------------------------------------------- */
function overrideFindingRow(f, idx) {
  return `<div class="rrow" data-idx="${idx}">
    <div style="flex:1;min-width:180px">
      <strong>${esc(FINDING_CODES[f.code] || f.code)}</strong>
      <div class="muted" style="font-size:12px">${esc(f.detail || '')}</div>
    </div>
    <select data-f="severity">
      ${FINDING_SEVERITIES.map(s => `<option value="${s.value}"${s.value === f.severity ? ' selected' : ''}>${s.label}</option>`).join('')}
    </select>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap">
      <input type="checkbox" data-f="dismissed"${f.dismissed ? ' checked' : ''}> Dismiss
    </label>
  </div>`;
}

async function drawOverride(score, onSaved) {
  const host = document.getElementById('override-area');
  if (!host) return;

  let editing = false;
  render();

  function render() {
    host.innerHTML = editing ? editorHtml() : summaryHtml();
    wire();
  }

  function summaryHtml() {
    return `
      <div class="card">
        <div class="card__head">
          <h2>Manual override</h2>
          ${score.is_overridden
            ? `<span class="chip chip--warning"><span aria-hidden="true">!</span>Active</span>`
            : `<span class="muted">Not overridden</span>`}
        </div>
        <p class="muted" style="margin:0 0 14px">
          ${score.is_overridden
            ? (score.manual_notes ? esc(score.manual_notes) : 'No note left for this override.')
            : "The model's score stands. Override it if a reviewer disagrees — the model's own numbers stay visible, this just decides which one counts."}
        </p>
        <div style="display:flex;gap:10px">
          <button class="btn ${score.is_overridden ? '' : 'btn--primary'}" type="button" id="ov-edit">
            ${score.is_overridden ? 'Edit override' : 'Override this score'}
          </button>
          ${score.is_overridden ? `<button class="btn btn--ghost" type="button" id="ov-clear">Revert to model score</button>` : ''}
        </div>
      </div>`;
  }

  function editorHtml() {
    const modelDims = entriesOf(score.dimensions);
    const manualDims = score.manual_dimensions ?? score.dimensions ?? {};
    const findings = (score.manual_findings ?? score.findings ?? []).map(f => ({ dismissed: false, ...f }));
    const complianceNow = score.is_overridden ? score.manual_compliance_passed : score.compliance_passed;

    return `
      <div class="card">
        <div class="card__head"><h2>Override this score</h2></div>
        <form id="override-form">
          <div class="grid-2">
            <label class="field">
              <span>Overall score * <span class="muted">(model said ${score.overall_score})</span></span>
              <input type="number" id="ov-overall" min="0" max="100" required
                     value="${esc(score.is_overridden ? score.manual_overall_score : score.overall_score)}">
            </label>
            <label class="field">
              <span>Compliance verdict</span>
              <select id="ov-compliance">
                <option value="true"${complianceNow ? ' selected' : ''}>Pass</option>
                <option value="false"${!complianceNow ? ' selected' : ''}>Fail</option>
              </select>
            </label>
          </div>

          <h3 style="margin:18px 0 8px">By dimension</h3>
          <div class="grid-2" id="ov-dims">
            ${modelDims.map(([key, v]) => `
              <label class="field" data-dim="${esc(key)}">
                <span>${esc(dimLabel(key, v))} <span class="muted">(model ${v.score ?? 0})</span></span>
                <input type="number" min="0" max="100" data-f="score"
                       value="${esc(manualDims?.[key]?.score ?? v.score ?? 0)}">
              </label>`).join('')}
          </div>

          ${findings.length ? `
            <h3 style="margin:18px 0 8px">Compliance findings</h3>
            <p class="muted" style="margin:0 0 10px;font-size:12px">
              Re-grade severity or dismiss a finding the model got wrong — the code, detail and evidence stay as scored.
            </p>
            <div id="ov-findings">${findings.map(overrideFindingRow).join('')}</div>` : ''}

          <label class="field" style="margin-top:18px">
            <span>Note <span class="muted">(why this was changed)</span></span>
            <textarea id="ov-notes" rows="3">${esc(score.manual_notes || '')}</textarea>
          </label>

          <div style="display:flex;gap:10px;margin-top:14px">
            <button class="btn btn--primary" type="submit" id="ov-save">Save override</button>
            <button class="btn btn--ghost" type="button" id="ov-cancel">Cancel</button>
          </div>
        </form>
      </div>`;
  }

  function wire() {
    document.getElementById('ov-edit')?.addEventListener('click', () => { editing = true; render(); });
    document.getElementById('ov-cancel')?.addEventListener('click', () => { editing = false; render(); });

    document.getElementById('ov-clear')?.addEventListener('click', async () => {
      if (!confirm('Revert to the model score? Your override values are kept and can be re-applied later.')) return;
      try {
        await db.clearScoreOverride(score.id);
        toast('Reverted to model score.', 'ok');
        onSaved();
      } catch (err) { toast(err.message, 'error'); }
    });

    document.getElementById('override-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('ov-save');

      const overall = Number(document.getElementById('ov-overall').value);
      if (!Number.isFinite(overall) || overall < 0 || overall > 100) {
        return toast('Enter a valid overall score (0-100).', 'error');
      }

      const dimensions = {};
      document.querySelectorAll('#ov-dims [data-dim]').forEach(row => {
        const key = row.dataset.dim;
        const n = Number(row.querySelector('[data-f="score"]').value);
        const modelEntry = score.dimensions?.[key] ?? {};
        dimensions[key] = { ...modelEntry, score: Number.isFinite(n) ? n : modelEntry.score };
      });

      const baseFindings = score.manual_findings ?? score.findings ?? [];
      const findings = [...document.querySelectorAll('#ov-findings [data-idx]')].map(row => {
        const idx = Number(row.dataset.idx);
        return {
          ...baseFindings[idx],
          severity: row.querySelector('[data-f="severity"]').value,
          dismissed: row.querySelector('[data-f="dismissed"]').checked,
        };
      });

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveScoreOverride(score.id, {
          overall_score: overall,
          dimensions,
          compliance_passed: document.getElementById('ov-compliance').value === 'true',
          findings,
          notes: document.getElementById('ov-notes').value.trim(),
        });
        toast('Override saved.', 'ok');
        onSaved();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save override';
      }
    });
  }
}

/* --- human grading -------------------------------------------------------
   Grading a call the model already graded is how the rubric gets tuned. The
   model's number is shown beside each input on purpose — anchoring is a real
   risk, but hiding it means reviewers grade a different call in their head
   than the one being compared, and the deltas become noise.
   -------------------------------------------------------------------------- */
async function drawReview(score) {
  const host = document.getElementById('review-area');
  if (!host) return;

  const [mine, all] = await Promise.all([
    db.myReview(score.id),
    db.reviewsForScore(score.id),
  ]);
  const others = all.filter(r => r.id !== mine?.id);
  const dims = dimensionEntries(score);

  const row = (key, v) => {
    const modelScore = Number(v.score) || 0;
    const saved = mine?.dimensions?.[key] ?? {};
    return `
      <tr data-dim="${esc(key)}">
        <td>${esc(dimLabel(key, v))}</td>
        <td class="num tnum muted">${modelScore}</td>
        <td class="num"><input type="number" min="0" max="100" step="1" data-score
              value="${saved.score ?? ''}" placeholder="—" style="width:80px;text-align:right"></td>
        <td><input type="text" data-note maxlength="200" value="${esc(saved.note ?? '')}"
              placeholder="Why (optional)"></td>
      </tr>`;
  };

  host.innerHTML = `
    <div class="card">
      <div class="card__head">
        <h2>Your grade</h2>
        <span class="muted">${mine ? 'You graded this — editing updates it' : 'Not graded yet'}</span>
      </div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        Score the same call yourself. The gaps between your numbers and the model's
        are what the Calibration page uses to show where the rubric needs tightening.
        Leave a dimension blank to skip it.
      </p>
      <form id="review-form">
        <div class="tablewrap"><table>
          <thead><tr><th>Dimension</th><th class="num">Model</th><th class="num">You</th><th>Note</th></tr></thead>
          <tbody>${dims.map(([k, v]) => row(k, v)).join('')}</tbody>
        </table></div>

        <div class="grid-2" style="margin-top:16px">
          <label class="field">
            <span>Your overall score * <span class="muted">(model said ${score.overall_score})</span></span>
            <input type="number" id="rv-overall" min="0" max="100" step="1" required
                   value="${mine?.overall_score ?? ''}" placeholder="0–100">
          </label>
          <label class="field">
            <span>Compliance verdict <span class="muted">(model said ${score.compliance_passed ? 'pass' : 'fail'})</span></span>
            <select id="rv-compliance">
              <option value=""${mine?.compliance_agree == null ? ' selected' : ''}>Not assessed</option>
              <option value="true"${mine?.compliance_agree === true ? ' selected' : ''}>I agree with the model</option>
              <option value="false"${mine?.compliance_agree === false ? ' selected' : ''}>I disagree</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>Notes</span>
          <textarea id="rv-notes" rows="3" maxlength="1000"
            placeholder="What the model missed, over-weighted, or got right">${esc(mine?.notes ?? '')}</textarea>
        </label>

        <button class="btn btn--primary" type="submit" id="rv-save">
          ${mine ? 'Update my grade' : 'Save my grade'}
        </button>
      </form>

      ${others.length ? `
        <h3 style="margin:22px 0 8px">Other reviewers</h3>
        <div class="tablewrap"><table>
          <thead><tr><th>Reviewer</th><th class="num">Overall</th><th class="num">vs model</th><th>Notes</th></tr></thead>
          <tbody>${others.map(o => {
            const d = o.overall_score - score.overall_score;
            return `<tr>
              <td>${esc(o.profiles?.full_name || '—')}</td>
              <td class="num tnum">${o.overall_score}</td>
              <td class="num tnum" style="color:${Math.abs(d) > 10 ? 'var(--serious)' : 'var(--text-muted)'}">
                ${d > 0 ? '+' : ''}${d}</td>
              <td class="muted">${esc(o.notes || '')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>` : ''}
    </div>`;

  document.getElementById('review-form').addEventListener('submit', async e => {
    e.preventDefault();
    const overall = Number(document.getElementById('rv-overall').value);
    if (!Number.isFinite(overall) || overall < 0 || overall > 100) {
      return toast('Overall score must be 0–100.', 'error');
    }

    const dimensions = {};
    for (const tr of host.querySelectorAll('tr[data-dim]')) {
      const raw = tr.querySelector('[data-score]').value.trim();
      if (raw === '') continue;                      // blank = skipped, not zero
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return toast(`Score for ${tr.dataset.dim} must be 0–100.`, 'error');
      }
      dimensions[tr.dataset.dim] = { score: Math.round(n), note: tr.querySelector('[data-note]').value.trim() };
    }

    const complianceRaw = document.getElementById('rv-compliance').value;
    const btn = document.getElementById('rv-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await db.saveReview({
        score_id: score.id,
        recording_id: score.recording_id,
        overall_score: Math.round(overall),
        dimensions,
        compliance_agree: complianceRaw === '' ? null : complianceRaw === 'true',
        notes: document.getElementById('rv-notes').value.trim(),
      });
      toast('Your grade is saved.', 'ok');
      drawReview(score);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Save my grade';
    }
  });
}

// The model's own columns never change after scoring; is_overridden picks
// which set — model or manual — actually counts. Kept in one place so the
// summary tiles, dimension bars and findings table can't disagree about it.
function effectiveOf(score) {
  return {
    overall_score: score.is_overridden ? score.manual_overall_score : score.overall_score,
    dimensions: score.is_overridden ? (score.manual_dimensions ?? score.dimensions) : score.dimensions,
    compliance_passed: score.is_overridden ? score.manual_compliance_passed : score.compliance_passed,
    findings: (score.is_overridden ? (score.manual_findings ?? score.findings) : score.findings) ?? [],
  };
}

function scoreHtml(score) {
  const eff = effectiveOf(score);
  const strengths = Array.isArray(score.strengths) ? score.strengths : [];
  const improvements = Array.isArray(score.improvements) ? score.improvements : [];
  const visibleFindings = eff.findings.filter(f => !f.dismissed);

  return `
    ${score.is_overridden ? `
      <div class="card" style="border-color:var(--warning)">
        <div class="card__head">
          <h2>Manually overridden</h2>
          <span class="chip chip--warning"><span aria-hidden="true">!</span>Overridden</span>
        </div>
        <p class="muted" style="margin:0">
          By ${esc(score.overridden_by_profile?.full_name || 'an admin')}
          ${score.overridden_at ? `· ${esc(fmtDate(score.overridden_at))}` : ''}
          ${score.manual_notes ? `— ${esc(score.manual_notes)}` : ''}
        </p>
      </div>` : ''}

    <div class="kpis">
      ${statTile({
        label: 'Overall score',
        value: String(eff.overall_score),
        note: score.is_overridden
          ? `Model scored ${score.overall_score}`
          : (score.coaching_focus ? `Focus: ${esc(score.coaching_focus)}` : ''),
        meter: { pct: eff.overall_score, aria: `${eff.overall_score} out of 100` },
      })}
      ${statTile({
        label: 'Compliance',
        value: eff.compliance_passed ? 'Pass' : 'Fail',
        note: score.is_overridden
          ? `Model said ${score.compliance_passed ? 'pass' : 'fail'}`
          : (visibleFindings.length
            ? `${fmtNum(visibleFindings.length)} finding${visibleFindings.length === 1 ? '' : 's'}`
            : 'No findings'),
      })}
      ${statTile({
        label: 'Cost to score',
        value: fmtMoneyExact(score.cost_usd),
        note: `${fmtNum(score.input_tokens)} in · ${fmtNum(score.output_tokens)} out · ${fmtNum(score.cache_read_tokens)} cached`,
      })}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Summary</h2>
        <span class="muted">${esc(score.model)} · rubric ${esc(score.rubric_version)}</span>
      </div>
      <p style="margin:0">${esc(score.summary)}</p>
    </div>

    <div class="card">
      <div class="card__head"><h2>By dimension</h2><span class="muted">Scored 0–100</span></div>
      <div class="bars">
        ${entriesOf(eff.dimensions).map(([key, v]) => {
          const n = Number(v.score) || 0;
          const modelN = Number(score.dimensions?.[key]?.score) || 0;
          return barRow({
            rank: null,
            label: dimLabel(key, v),
            sub: score.is_overridden && n !== modelN ? `Model said ${modelN}` : null,
            value: n,
            display: String(n),
            max: SCORE_MAX,
            color: scoreTone(n),
          });
        }).join('')}
      </div>
      <details style="margin-top:16px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Rationale and evidence</summary>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:14px">
          ${dimensionEntries(score).map(([key, v]) => `
              <div>
                <strong>${esc(dimLabel(key, v))} — ${esc(v.score ?? 0)}</strong>
                <div class="muted" style="margin:4px 0">${esc(v.rationale || '')}</div>
                ${v.evidence ? `<blockquote style="margin:0;padding-left:12px;border-left:2px solid var(--grid);font-size:13px">${esc(v.evidence)}</blockquote>` : ''}
              </div>`).join('')}
        </div>
      </details>
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Compliance findings</h2>
        <span class="muted">${eff.compliance_passed ? 'Passed' : 'Needs attention'}</span>
      </div>
      ${visibleFindings.length === 0 ? empty('No compliance issues found.') : `
        <div class="tablewrap"><table>
          <thead><tr><th>Issue</th><th>Severity</th><th>Detail</th></tr></thead>
          <tbody>${visibleFindings.map(f => `
            <tr>
              <td>${esc(FINDING_CODES[f.code] || f.code)}</td>
              <td>${severityChip(f.severity)}</td>
              <td>${esc(f.detail || '')}
                ${f.evidence ? `<br><span class="muted" style="font-size:12px">“${esc(f.evidence)}”</span>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
      ${score.is_overridden && eff.findings.some(f => f.dismissed)
        ? `<p class="muted" style="font-size:12px;margin:10px 0 0">
             ${fmtNum(eff.findings.filter(f => f.dismissed).length)} finding${eff.findings.filter(f => f.dismissed).length === 1 ? '' : 's'} dismissed on override.
           </p>` : ''}
    </div>

    <div class="card">
      <div class="grid-2">
        <div>
          <h3 style="margin-bottom:8px">What went well</h3>
          ${strengths.length === 0 ? `<p class="muted">—</p>` :
            `<ul style="margin:0;padding-left:18px">${strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`}
        </div>
        <div>
          <h3 style="margin-bottom:8px">What to work on</h3>
          ${improvements.length === 0 ? `<p class="muted">—</p>` :
            `<ul style="margin:0;padding-left:18px">${improvements.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`}
        </div>
      </div>
    </div>

    <p class="muted" style="font-size:12px;margin:0 0 18px">
      Scores are model-generated and meant for coaching, not for discipline or
      compliance sign-off. Read the evidence quotes before acting on a finding.
    </p>`;
}

/* === Calibration ==========================================================
   Model vs human, per dimension. Delta is a signed quantity around zero, so it
   is drawn as a diverging bar from a centre line rather than a length from the
   left edge — a plain bar chart would make "-8" and "+8" look like the same
   magnitude of the same thing, when they mean opposite problems.
   ========================================================================== */
export async function calibration(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Calibration</h1>
      <div class="page__sub">Where the model and your reviewers disagree — and what to change</div>
    </div></div>
    <div class="filters">${selectField('cal-range', 'Period', RANGES, 'quarter')}</div>
    <div id="body">${spinner()}</div>`;

  const body = document.getElementById('body');
  const rangeSel = document.getElementById('cal-range');

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const [summary, dims] = await Promise.all([
      db.calibrationSummary(start, end),
      db.calibrationByDimension(start, end),
    ]);

    if (!Number(summary.reviews)) {
      body.innerHTML = `<div class="card">${empty(
        'No human grades in this period yet. Open a scored call and fill in "Your grade" — this page needs at least a few to say anything useful.'
      )}</div>`;
      return;
    }

    const n = Number(summary.reviews);
    const agree10 = Math.round((Number(summary.within_10) / n) * 100);
    const maxAbs = Math.max(5, ...dims.map(d => Math.abs(Number(d.delta) || 0)));

    body.innerHTML = `
      <div class="kpis">
        ${statTile({ label: 'Graded calls', value: fmtNum(n), note: `${esc(fmtDate(start))} – ${esc(fmtDate(end))}` })}
        ${statTile({
          label: 'Overall gap',
          value: `${Number(summary.delta) > 0 ? '+' : ''}${summary.delta ?? '—'}`,
          note: Number(summary.delta) > 0 ? 'Model scores higher than people' : 'People score higher than the model',
        })}
        ${statTile({
          label: 'Within 10 points',
          value: `${agree10}%`,
          note: `${fmtNum(summary.within_5)} of ${fmtNum(n)} within 5`,
          meter: { pct: agree10, aria: `${agree10}% agree within 10 points` },
        })}
        ${statTile({
          label: 'Compliance disputed',
          value: fmtNum(summary.compliance_disputed),
          note: Number(summary.compliance_disputed) ? 'Read these first' : 'No disagreements',
        })}
      </div>

      <div class="card">
        <div class="card__head">
          <h2>Gap by dimension</h2>
          <span class="muted">Model minus human · ${dims.length} dimensions</span>
        </div>
        ${dims.length === 0 ? empty('No per-dimension grades yet.') : `
          <div class="diverge">
            ${dims.map(d => {
              const delta = Number(d.delta) || 0;
              const pct = Math.min(50, (Math.abs(delta) / maxAbs) * 50);
              const warm = delta > 0;
              return `
                <div class="dv">
                  <div class="dv__label">${esc(dimLabel(d.dimension_key, {}))}
                    <span class="bar__sub">${fmtNum(d.reviews)} graded · model ${d.model_avg} vs you ${d.human_avg}</span>
                  </div>
                  <div class="dv__track">
                    <div class="dv__mid"></div>
                    <div class="dv__fill" style="
                      ${warm ? 'left:50%' : `left:${50 - pct}%`};
                      width:${pct}%;
                      background:var(${warm ? '--diverge-warm' : '--diverge-cool'})"></div>
                  </div>
                  <div class="dv__val" style="color:var(${warm ? '--diverge-warm' : '--diverge-cool'})">
                    ${delta > 0 ? '+' : ''}${delta}
                  </div>
                </div>`;
            }).join('')}
          </div>
          <div class="legend" style="margin-top:14px">
            <span class="legend__item"><span class="legend__swatch" style="background:var(--diverge-warm)"></span>Model scores higher — criteria may be too loose</span>
            <span class="legend__item"><span class="legend__swatch" style="background:var(--diverge-cool)"></span>People score higher — criteria may be too harsh</span>
          </div>
          <details style="margin-top:16px">
            <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
            <div class="tablewrap" style="margin-top:10px"><table>
              <thead><tr><th>Dimension</th><th class="num">Graded</th><th class="num">Model avg</th>
                <th class="num">Human avg</th><th class="num">Delta</th><th class="num">Mean gap</th></tr></thead>
              <tbody>${dims.map(d => `
                <tr>
                  <td>${esc(dimLabel(d.dimension_key, {}))}</td>
                  <td class="num">${esc(fmtNum(d.reviews))}</td>
                  <td class="num">${esc(d.model_avg)}</td>
                  <td class="num">${esc(d.human_avg)}</td>
                  <td class="num">${Number(d.delta) > 0 ? '+' : ''}${esc(d.delta)}</td>
                  <td class="num">${esc(d.mean_abs_gap)}</td>
                </tr>`).join('')}
              </tbody>
            </table></div>
          </details>`}
      </div>

      <div class="card">
        <div class="card__head"><h2>How to read this</h2></div>
        <p class="muted" style="margin:0 0 10px">
          <strong>Delta</strong> is the average signed gap — model minus human. A
          <strong>+8</strong> on Discovery means the model is eight points more generous
          than your reviewers, which usually means that dimension's criteria are too easy
          to satisfy. Tighten the wording on the Rubric page and the gap should close.
        </p>
        <p class="muted" style="margin:0 0 10px">
          <strong>Mean gap</strong> is the average distance ignoring direction. A small delta
          with a large mean gap is the tricky case: the model is not biased, it is
          <em>inconsistent</em> — it scores some calls high and others low and they cancel out.
          Tightening criteria will not fix that; adding concrete criteria usually will.
        </p>
        <p class="muted" style="margin:0">
          Before trusting any of this, check your reviewers agree with <em>each other</em>.
          Two managers 20 points apart on the same call means there is no agreed standard yet,
          and no rubric wording will make the model's number feel right.
        </p>
      </div>`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}

/* === Admin scorecard ====================================================== */
export async function scorecard(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Scorecard</h1>
      <div class="page__sub">Average call scores, compliance, and what scoring costs</div>
    </div></div>
    <div class="filters">${selectField('sc-range', 'Period', RANGES, 'month')}</div>
    <div id="body">${spinner()}</div>`;

  const body = document.getElementById('body');
  const rangeSel = document.getElementById('sc-range');

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const [board, spend] = await Promise.all([
      db.scoringLeaderboard(start, end),
      db.scoringSpend(start, end),
    ]);

    if (board.length === 0) {
      body.innerHTML = `<div class="card">${empty('No calls scored in this period.')}</div>`;
      return;
    }

    body.innerHTML = `
      <div class="kpis">
        ${statTile({ label: 'Calls scored', value: fmtNum(spend.calls_scored), note: `${esc(fmtDate(start))} – ${esc(fmtDate(end))}` })}
        ${statTile({ label: 'Scoring spend', value: fmtMoneyExact(spend.total_cost_usd), note: `${fmtMoneyExact(spend.avg_cost_usd)} per call` })}
        ${statTile({
          label: 'Compliance pass rate',
          value: spend.calls_scored > 0
            ? `${Math.round((board.reduce((s, r) => s + Number(r.compliance_ok), 0) / Number(spend.calls_scored)) * 100)}%`
            : '—',
          note: `${fmtNum(board.reduce((s, r) => s + Number(r.open_findings), 0))} findings total`,
        })}
        ${statTile({
          label: 'Cache savings',
          value: fmtNum(spend.cache_read_tokens),
          note: 'Rubric tokens served from cache',
        })}
      </div>

      <div class="card">
        <div class="card__head"><h2>Average score by agent</h2><span class="muted">Scored 0–100</span></div>
        <div class="bars">
          ${board.map(r => barRow({
            rank: r.rank,
            label: r.full_name,
            sub: `${r.team_name} · ${fmtNum(r.calls_scored)} calls · ${fmtNum(r.open_findings)} findings`,
            value: r.avg_score,
            display: String(r.avg_score ?? 0),
            max: SCORE_MAX,
            color: scoreTone(Number(r.avg_score) || 0),
          })).join('')}
        </div>
        <details style="margin-top:16px">
          <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
          <div class="tablewrap" style="margin-top:10px"><table>
            <thead><tr>
              <th>Agent</th><th>Team</th><th class="num">Calls</th>
              <th class="num">Avg score</th><th class="num">Compliance OK</th><th class="num">Findings</th>
            </tr></thead>
            <tbody>${board.map(r => `
              <tr>
                <td>${esc(r.full_name)}</td>
                <td class="muted">${esc(r.team_name)}</td>
                <td class="num">${esc(fmtNum(r.calls_scored))}</td>
                <td class="num">${esc(r.avg_score ?? 0)}</td>
                <td class="num">${esc(fmtNum(r.compliance_ok))}</td>
                <td class="num">${esc(fmtNum(r.open_findings))}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </details>
      </div>`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}
