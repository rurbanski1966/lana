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

// Shared with matchQuoteToTurn() below — "turn 4" has to mean the same line
// whether it's the transcript view rendering it or a coaching quote jumping
// to it.
function parseTurns(text) {
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
  return turns;
}

function transcriptHtml(text, segments) {
  const turns = parseTurns(text);
  if (turns.length === 0) return empty('Transcript is empty.');

  // Deepgram's segments are one-per-line in the same order the transcript
  // was written in. If the counts don't match, the transcript was edited by
  // hand after transcription and the alignment can no longer be trusted —
  // render without seek points rather than pointing at the wrong line.
  const timed = Array.isArray(segments) && segments.length === turns.length;

  // Stable speaker ordering so the same person keeps the same side/indent
  // through the whole call, regardless of who talks first.
  const speakers = [...new Set(turns.map(t => t.who).filter(Boolean))];

  return `<div class="transcript">${turns.map((t, i) => {
    const idx = t.who ? speakers.indexOf(t.who) % 2 : 0;
    const start = timed ? segments[i].start : null;
    return `
      <div class="turn${t.who ? ` turn--s${idx}` : ' turn--plain'}${start != null ? ' turn--clickable' : ''}"
           id="turn-${i}"${start != null ? ` data-start="${esc(start)}" tabindex="0" role="button" title="Play from here"` : ''}>
        <div class="turn__no">${i + 1}</div>
        ${t.who ? `<div class="turn__who">${esc(t.who)}</div>` : '<div class="turn__who"></div>'}
        <div class="turn__text">${esc(t.text)}</div>
      </div>`;
  }).join('')}</div>`;
}

const normalizeForMatch = s =>
  String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Evidence quotes are meant to be verbatim, so a substring match should catch
// most of them; a lightly paraphrased or trimmed quote falls back to whoever
// shares the most words. Returns a turn index, or -1 when nothing is close
// enough to point at with any confidence.
function matchQuoteToTurn(quote, turns) {
  const nq = normalizeForMatch(quote);
  if (!nq || turns.length === 0) return -1;
  const normTurns = turns.map(t => normalizeForMatch(t.text));

  // Search the whole transcript as one string first, not turn-by-turn — a
  // verbatim quote can start in one turn and run into the next if Deepgram
  // split an utterance mid-sentence, so no single turn would contain it.
  let offset = 0;
  const starts = normTurns.map(nt => {
    const s = offset;
    offset += nt.length + 1; // +1 for the joining space below
    return s;
  });
  const at = normTurns.join(' ').indexOf(nq);
  if (at !== -1) {
    let idx = 0;
    for (let i = 0; i < starts.length && starts[i] <= at; i++) idx = i;
    return idx;
  }

  // No verbatim hit — the model paraphrased or trimmed the quote. Only trust
  // a fallback when one turn is an unambiguous best fit: a weak or generic
  // word-overlap match is worse than no jump, since a call full of common
  // insurance-sales vocabulary can score two unrelated lines almost equally
  // and land on the wrong one.
  const qWords = [...new Set(nq.split(' ').filter(w => w.length > 4))];
  if (qWords.length < 3) return -1;

  const scores = normTurns.map(nt => {
    const tWords = new Set(nt.split(' '));
    return qWords.filter(w => tWords.has(w)).length / qWords.length;
  });
  const best = scores.reduce((b, s, i) => (s > scores[b] ? i : b), 0);
  const runnerUp = Math.max(0, ...scores.filter((_, i) => i !== best));
  return scores[best] >= 0.8 && scores[best] - runnerUp >= 0.25 ? best : -1;
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
    <div class="card" id="edit-card" style="max-width:680px" hidden></div>
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
        <tbody>${rows.map(r => {
          // Mirrors RLS: an admin can touch any row; anyone else only their
          // own upload, and only before scoring has committed it — matches
          // recordings_update_own's own status check, so a click here never
          // fails against a rule the button should have hidden for.
          const canEdit = isAdmin || (r.uploaded_by === ctx.profile.id && ['uploaded', 'transcribed', 'failed'].includes(r.status));
          const canDelete = isAdmin || r.uploaded_by === ctx.profile.id;
          return `
          <tr data-id="${esc(r.id)}">
            <td class="tnum">${esc(fmtDate(r.call_on))}</td>
            <td>${esc(r.title || 'Untitled call')}${r.error_message
              ? `<br><span class="muted">${esc(r.error_message.slice(0, 80))}</span>` : ''}</td>
            <td>${esc(r.agent?.full_name || r.agent_name || '—')}</td>
            <td class="tnum muted">${esc(fmtDuration(r.duration_seconds))}</td>
            <td>${statusChipFor(r.status)}</td>
            <td style="display:flex;gap:6px;flex-wrap:wrap">
              <a class="btn btn--ghost btn--sm" href="#/reviews/${esc(r.id)}">Open</a>
              ${canEdit ? `<button class="btn btn--ghost btn--sm" data-action="edit" type="button">Edit</button>` : ''}
              ${canDelete ? `<button class="btn btn--ghost btn--sm" data-action="delete" type="button">Delete</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      const row = rows.find(r => r.id === id);

      tr.querySelector('[data-action="edit"]')?.addEventListener('click', () => renderEditForm(row));

      tr.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        if (!confirm(`Delete "${row.title || 'Untitled call'}"? This removes the call record, its transcript, and any score. This cannot be undone.`)) return;
        try {
          await db.deleteRecording(id);
          toast('Call deleted.', 'ok');
          if (editCard.dataset.editing === id) editCard.hidden = true;
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  /* --- edit --- */
  const editCard = document.getElementById('edit-card');

  function renderEditForm(row) {
    editCard.hidden = false;
    editCard.dataset.editing = row.id;
    const currentAgentName = row.agent?.full_name || row.agent_name || '';

    editCard.innerHTML = `
      <div class="card__head"><h2>Edit call</h2></div>
      <form id="edit-form">
        <div class="grid-2">
          <label class="field">
            <span>Title</span>
            <input type="text" id="ed-title" maxlength="120" value="${esc(row.title || '')}">
          </label>
          <label class="field">
            <span>Call date *</span>
            <input type="date" id="ed-call_on" value="${esc(row.call_on)}" max="${today()}" required>
          </label>
        </div>
        ${isAdmin ? `
          <label class="field">
            <span>Agent on the call *</span>
            <input type="text" id="ed-agent" list="agent-datalist" required value="${esc(currentAgentName)}">
          </label>` : ''}
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn btn--primary" type="submit" id="ed-save">Save changes</button>
          <button class="btn btn--ghost" type="button" id="ed-cancel">Cancel</button>
        </div>
      </form>`;

    editCard.querySelector('#ed-cancel').addEventListener('click', () => {
      editCard.hidden = true;
      delete editCard.dataset.editing;
    });

    editCard.querySelector('#edit-form').addEventListener('submit', async e => {
      e.preventDefault();
      const patch = {
        title: editCard.querySelector('#ed-title').value.trim(),
        call_on: editCard.querySelector('#ed-call_on').value,
      };

      if (isAdmin) {
        const typed = editCard.querySelector('#ed-agent').value.trim();
        if (!typed) return toast('Enter or pick an agent.', 'error');
        const matchedId = nameToId.get(typed.toLowerCase());
        patch.agent_id = matchedId || null;
        patch.agent_name = matchedId ? null : typed;
      }

      const btn = editCard.querySelector('#ed-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.updateRecording(row.id, patch);
        toast('Call updated.', 'ok');
        editCard.hidden = true;
        delete editCard.dataset.editing;
        draw();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save changes';
      }
    });
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
    const turns = parseTurns(rec.transcript);

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

      <div id="score-area">${score ? scoreHtml(score, turns) : ''}</div>
      <div id="findings-area">${score ? spinner() : ''}</div>
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
          <div id="transcript-view">${transcriptHtml(rec.transcript, rec.transcript_segments)}</div>
          <pre id="transcript-raw" class="transcript-raw" hidden>${esc(rec.transcript)}</pre>
        </div>` : ''}`;

    document.getElementById('reload').addEventListener('click', draw);
    if (score) drawFindings(score, ctx, turns, draw);
    if (score && ctx.profile.role === 'admin') drawOverride(score, draw);
    if (score) drawReview(score);

    document.getElementById('play')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const url = await db.audioUrl(rec.storage_path);
        document.getElementById('player').innerHTML =
          `<audio controls id="rec-audio" src="${esc(url)}" style="width:100%"></audio>`;
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });

    // Loads the player on demand — a transcript line or a coaching quote can
    // be clicked before "Play audio" ever was — then seeks once the audio
    // actually has a duration to seek within.
    async function ensureAudioAndSeek(startSeconds) {
      if (!rec.storage_path || !Number.isFinite(startSeconds)) return;
      let audio = document.getElementById('rec-audio');
      if (!audio) {
        try {
          const url = await db.audioUrl(rec.storage_path);
          document.getElementById('player').innerHTML =
            `<audio controls id="rec-audio" src="${esc(url)}" style="width:100%"></audio>`;
          audio = document.getElementById('rec-audio');
        } catch (err) {
          toast(err.message, 'error');
          return;
        }
      }
      const seek = () => { audio.currentTime = startSeconds; audio.play(); };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }

    // Clicking a transcript line seeks the audio there directly.
    document.getElementById('transcript-view')?.addEventListener('click', e => {
      const turnEl = e.target.closest('.turn--clickable');
      if (turnEl) ensureAudioAndSeek(Number(turnEl.dataset.start));
    });

    // Clicking a coaching evidence quote scrolls to the transcript line it
    // matched and seeks the audio there — the quote is what the model says
    // proves the score, so verifying it in context is the whole point.
    document.getElementById('score-area')?.addEventListener('click', e => {
      const jumpEl = e.target.closest('[data-turn]');
      if (!jumpEl) return;
      const turnEl = document.getElementById(`turn-${jumpEl.dataset.turn}`);
      if (turnEl) {
        turnEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        turnEl.classList.add('turn--flash');
        setTimeout(() => turnEl.classList.remove('turn--flash'), 1500);
        if (turnEl.dataset.start !== undefined) ensureAudioAndSeek(Number(turnEl.dataset.start));
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

/* --- compliance findings: per-finding manual review ------------------------
   Each finding gets its own Manual review button rather than one shared
   form — a reviewer is usually correcting one specific call, not re-grading
   every finding at once. Editing turns a finding into a 0-100 score
   (0 = most severe, 100 = no issue); severity is DERIVED from that number,
   never chosen separately, so the two can't disagree. Saving recomputes the
   whole call's overall score and compliance verdict from every surviving
   finding's severity plus the current dimension scores — see
   recomputeFromFindings() — so a finding you just fixed immediately changes
   the grade everywhere it's read, not just this table.
   -------------------------------------------------------------------------- */
async function drawFindings(score, ctx, turns, onSaved) {
  const host = document.getElementById('findings-area');
  if (!host) return;
  const isAdmin = ctx.profile.role === 'admin';

  const eff = effectiveOf(score);
  // Editing always starts from whatever is currently authoritative — the
  // last override if there is one, otherwise the model's own findings.
  const findings = (score.manual_findings ?? score.findings ?? []).map(f => ({ ...f }));

  let editingIdx = null;
  render();

  function render() {
    host.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2>Compliance findings</h2>
          <span class="muted">${eff.compliance_passed ? 'Passed' : 'Needs attention'}</span>
        </div>
        ${findings.length === 0 ? empty('No compliance issues found.') : `
          <div class="tablewrap"><table>
            <thead><tr><th>Issue</th><th>Severity</th><th>Detail</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
            <tbody>${findings.map((f, i) => i === editingIdx ? editRowHtml(f, i) : viewRowHtml(f, i)).join('')}</tbody>
          </table></div>`}
      </div>`;
    wire();
  }

  function viewRowHtml(f, i) {
    return `
      <tr>
        <td>${esc(FINDING_CODES[f.code] || f.code)}</td>
        <td>${severityChip(f.severity)}</td>
        <td>${esc(f.detail || '')}
          ${evidenceHtml(f.evidence, turns, { inline: true })}
          ${f.reason ? `<br><span class="muted" style="font-size:12px">Reviewer note: ${esc(f.reason)}</span>` : ''}</td>
        ${isAdmin ? `<td><button class="btn btn--ghost btn--sm" data-review="${i}" type="button">Manual review</button></td>` : ''}
      </tr>`;
  }

  function editRowHtml(f, i) {
    const current = f.manual_score ?? severityToScore(f.severity);
    return `
      <tr>
        <td colspan="4">
          <div style="display:flex;flex-direction:column;gap:10px;padding:6px 0">
            <div><strong>${esc(FINDING_CODES[f.code] || f.code)}</strong> — currently ${severityChip(f.severity)}</div>
            <div class="muted" style="font-size:13px">${esc(f.detail || '')}</div>
            <div class="grid-2">
              <label class="field">
                <span>Corrected score * <span class="muted">(0 = most severe, 100 = no issue)</span></span>
                <input type="number" min="0" max="100" required id="fr-score" value="${esc(current)}">
              </label>
              <label class="field">
                <span>New severity</span>
                <input type="text" id="fr-preview" disabled value="${scoreToSeverity(current)}">
              </label>
            </div>
            <label class="field">
              <span>Explanation *</span>
              <textarea id="fr-reason" rows="2" required placeholder="Why this finding was re-graded">${esc(f.reason || '')}</textarea>
            </label>
            <div style="display:flex;gap:10px">
              <button class="btn btn--primary" type="button" data-save="${i}">Save</button>
              <button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function wire() {
    host.querySelectorAll('[data-review]').forEach(btn => {
      btn.addEventListener('click', () => { editingIdx = Number(btn.dataset.review); render(); });
    });
    host.querySelector('[data-cancel]')?.addEventListener('click', () => { editingIdx = null; render(); });

    const scoreInput = host.querySelector('#fr-score');
    scoreInput?.addEventListener('input', () => {
      const n = Number(scoreInput.value);
      host.querySelector('#fr-preview').value = Number.isFinite(n) ? scoreToSeverity(n) : '—';
    });

    host.querySelector('[data-save]')?.addEventListener('click', async btnEvent => {
      const btn = btnEvent.currentTarget;
      const i = Number(btn.dataset.save);
      const n = Number(host.querySelector('#fr-score').value);
      const reason = host.querySelector('#fr-reason').value.trim();

      if (!Number.isFinite(n) || n < 0 || n > 100) return toast('Enter a score between 0 and 100.', 'error');
      if (!reason) return toast('Add an explanation for the change.', 'error');

      const updated = findings.map((f, idx) => idx === i
        ? { ...f, manual_score: n, severity: scoreToSeverity(n), reason }
        : f);
      const { overallScore, compliancePassed } = recomputeFromFindings(eff.dimensions, updated);

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveScoreOverride(score.id, {
          overall_score: overallScore,
          dimensions: eff.dimensions,
          compliance_passed: compliancePassed,
          findings: updated,
          notes: score.manual_notes || '',
        });
        toast('Finding updated.', 'ok');
        onSaved();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }
}

// Overall score and the compliance verdict are never typed directly here —
// recomputeFromFindings() derives both from dimension scores plus whatever
// findings currently stand, the same formula drawFindings() uses when a
// single finding is re-graded. Typing an overall number here and a severity
// there could disagree; deriving one from the other can't.
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
          <h2>Dimension scores</h2>
          ${score.is_overridden
            ? `<span class="chip chip--warning"><span aria-hidden="true">!</span>Overridden</span>`
            : `<span class="muted">Not overridden</span>`}
        </div>
        <p class="muted" style="margin:0 0 14px">
          ${score.is_overridden
            ? (score.manual_notes ? esc(score.manual_notes) : 'No note left for this override.')
            : "Adjust a dimension if the model scored it wrong — the overall score and compliance verdict recompute from these plus the compliance findings, so there's nothing else to set here."}
        </p>
        <div style="display:flex;gap:10px">
          <button class="btn ${score.is_overridden ? '' : 'btn--primary'}" type="button" id="ov-edit">
            ${score.is_overridden ? 'Edit dimensions' : 'Override dimension scores'}
          </button>
          ${score.is_overridden ? `<button class="btn btn--ghost" type="button" id="ov-clear">Revert to model score</button>` : ''}
        </div>
      </div>`;
  }

  function editorHtml() {
    const modelDims = entriesOf(score.dimensions);
    const manualDims = score.manual_dimensions ?? score.dimensions ?? {};
    const currentFindings = score.manual_findings ?? score.findings ?? [];
    const preview = recomputeFromFindings(manualDims, currentFindings);

    return `
      <div class="card">
        <div class="card__head"><h2>Override dimension scores</h2></div>
        <form id="override-form">
          <div class="grid-2" id="ov-preview" style="margin-bottom:6px">
            <div class="field"><span class="muted">Overall score (computed)</span><strong id="ov-overall-preview">${preview.overallScore}</strong></div>
            <div class="field"><span class="muted">Compliance (computed)</span><strong id="ov-compliance-preview">${preview.compliancePassed ? 'Pass' : 'Fail'}</strong></div>
          </div>

          <div class="grid-2" id="ov-dims">
            ${modelDims.map(([key, v]) => `
              <label class="field" data-dim="${esc(key)}">
                <span>${esc(dimLabel(key, v))} <span class="muted">(model ${v.score ?? 0})</span></span>
                <input type="number" min="0" max="100" data-f="score"
                       value="${esc(manualDims?.[key]?.score ?? v.score ?? 0)}">
              </label>`).join('')}
          </div>

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

  function currentDimensions() {
    const dimensions = {};
    host.querySelectorAll('#ov-dims [data-dim]').forEach(row => {
      const key = row.dataset.dim;
      const n = Number(row.querySelector('[data-f="score"]').value);
      const modelEntry = score.dimensions?.[key] ?? {};
      dimensions[key] = { ...modelEntry, score: Number.isFinite(n) ? n : modelEntry.score };
    });
    return dimensions;
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

    // Live preview: typing a dimension score updates the computed overall
    // score/compliance immediately, before Save is even clicked.
    host.querySelectorAll('#ov-dims [data-f="score"]').forEach(input => {
      input.addEventListener('input', () => {
        const currentFindings = score.manual_findings ?? score.findings ?? [];
        const preview = recomputeFromFindings(currentDimensions(), currentFindings);
        host.querySelector('#ov-overall-preview').textContent = preview.overallScore;
        host.querySelector('#ov-compliance-preview').textContent = preview.compliancePassed ? 'Pass' : 'Fail';
      });
    });

    document.getElementById('override-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('ov-save');

      const dimensions = currentDimensions();
      const currentFindings = score.manual_findings ?? score.findings ?? [];
      const { overallScore, compliancePassed } = recomputeFromFindings(dimensions, currentFindings);

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveScoreOverride(score.id, {
          overall_score: overallScore,
          dimensions,
          compliance_passed: compliancePassed,
          findings: currentFindings,
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

/* --- finding score <-> severity ------------------------------------------
   A finding never had a number, only a severity — the rubric assigns one
   directly. A manual re-grade puts a number in (0 = most severe, 100 = no
   issue) and severity is derived from it, per Ryan 2026-09-17, so the two
   can never drift apart the way a separate severity dropdown could.
   -------------------------------------------------------------------------- */
const scoreToSeverity = n =>
  n <= 39 ? 'critical' : n <= 59 ? 'high' : n <= 79 ? 'medium' : 'low';

// Starting point when a finding has no manual score yet — the midpoint of
// its current severity's band, so the input opens already agreeing with
// what the AI decided rather than an arbitrary number.
const severityToScore = sev => ({ critical: 20, high: 50, medium: 70, low: 90 }[sev] ?? 70);

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// Per Ryan 2026-09-17: overall score starts from the dimension average, then
// gets capped by the worst surviving finding — a Critical finding can never
// let the call read better than "critical" overall, High never better than
// "serious", matching the tone bands used everywhere else in the app
// (scoreTone: <40 critical, 40-59 serious). Compliance passes only when
// nothing High or Critical survived — same rule the rubric itself uses.
function recomputeFromFindings(dimensions, findings) {
  const dims = entriesOf(dimensions).map(([, v]) => Number(v.score) || 0);
  const dimensionAvg = dims.length ? Math.round(dims.reduce((a, b) => a + b, 0) / dims.length) : 0;

  const worst = findings
    .filter(f => !f.dismissed)
    .reduce((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'low');

  const cap = worst === 'critical' ? 39 : worst === 'high' ? 59 : 100;
  return {
    overallScore: Math.min(dimensionAvg, cap),
    compliancePassed: worst !== 'critical' && worst !== 'high',
  };
}

// Wraps an evidence quote so a click scrolls the transcript to the matching
// line and seeks the audio there — but only when a match was actually found;
// an unmatched quote (paraphrased, or from a manually pasted transcript with
// no timing) stays plain text rather than promising a jump that goes nowhere.
function evidenceHtml(text, turns, { inline = false } = {}) {
  if (!text) return '';
  const idx = matchQuoteToTurn(text, turns);
  const jumpAttrs = idx !== -1 ? ` data-turn="${idx}" role="button" tabindex="0" title="Play from here"` : '';
  const jumpClass = idx !== -1 ? ' evidence--jump' : '';
  return inline
    ? `<br><span class="muted evidence${jumpClass}" style="font-size:12px"${jumpAttrs}>“${esc(text)}”</span>`
    : `<blockquote class="evidence${jumpClass}" style="margin:0;padding-left:12px;border-left:2px solid var(--grid);font-size:13px"${jumpAttrs}>${esc(text)}</blockquote>`;
}

function scoreHtml(score, turns = []) {
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
                ${evidenceHtml(v.evidence, turns)}
              </div>`).join('')}
        </div>
      </details>
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

/* === Agent leaderboard (by call score) ====================================
   Ranks every scored agent by average call score, highest first — the same
   number the Scorecard shows, just framed for a quick team-accountability
   view instead of a spend/compliance rollup. Tabs filter by team; "All
   agents" is the scoring_leaderboard RPC's own order, since it already ranks
   across every team combined.
   -------------------------------------------------------------------------- */
const scoreLevel = score => {
  const n = Number(score) || 0;
  return n >= 80 ? 'good' : n >= 70 ? 'warning' : 'critical';
};

const scoreLevelChip = level => {
  const meta = {
    good:     { label: 'Good',         icon: '✓' },
    warning:  { label: 'Needs review', icon: '!' },
    critical: { label: 'Critical',     icon: '✕' },
  }[level];
  return `<span class="chip chip--${level}"><span aria-hidden="true">${meta.icon}</span>${meta.label}</span>`;
};

export async function agentLeaderboard(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Leaderboard</h1>
      <div class="page__sub">Average call score, ranked highest to lowest</div>
    </div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card__head"><h2>What the colors mean</h2></div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div>${scoreLevelChip('critical')} <span class="muted">0–69% average — needs immediate coaching and a performance review.</span></div>
        <div>${scoreLevelChip('warning')} <span class="muted">70–79% average — needs agent review.</span></div>
        <div>${scoreLevelChip('good')} <span class="muted">80% or higher — good to go, no coaching needed.</span></div>
      </div>
    </div>
    <div class="filters">${selectField('alb-range', 'Period', RANGES, 'year')}</div>
    <div id="alb-tabs" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"></div>
    <div class="card" id="alb-body">${spinner()}</div>`;

  const rangeSel = document.getElementById('alb-range');
  const tabsHost = document.getElementById('alb-tabs');
  const body = document.getElementById('alb-body');

  const teams = await db.listTeams();
  let activeTab = 'all';

  function renderTabs() {
    const tabs = [{ key: 'all', label: 'All agents' }, ...teams.map(t => ({ key: t.name, label: t.name }))];
    tabsHost.innerHTML = tabs.map(t =>
      `<button type="button" class="btn ${t.key === activeTab ? 'btn--primary' : 'btn--ghost'}" data-tab="${esc(t.key)}">${esc(t.label)}</button>`
    ).join('');
    tabsHost.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        draw();
      });
    });
  }

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.scoringLeaderboard(start, end);
    const filtered = activeTab === 'all' ? rows : rows.filter(r => r.team_name === activeTab);

    if (filtered.length === 0) {
      body.innerHTML = empty('No scored calls in this period.');
      return;
    }

    // Re-rank within the filtered set — a team tab should read 1..N for that
    // team, not carry the gaps left by agents on other teams.
    const ranked = filtered
      .slice()
      .sort((a, b) => Number(b.avg_score) - Number(a.avg_score))
      .map((r, i) => ({ ...r, displayRank: i + 1 }));

    body.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(ranked.length)} agent${ranked.length === 1 ? '' : 's'}</h2>
        <span class="muted">${esc(fmtDate(start))} – ${esc(fmtDate(end))}</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Rank</th><th>Agent</th><th>Team</th>
          <th class="num">Calls scored</th><th class="num">Avg score</th><th></th>
        </tr></thead>
        <tbody>${ranked.map(r => {
          const level = scoreLevel(r.avg_score);
          return `
            <tr class="lb-row--${level}">
              <td class="tnum">${r.displayRank}</td>
              <td>${esc(r.full_name)}</td>
              <td class="muted">${esc(r.team_name)}</td>
              <td class="num">${esc(fmtNum(r.calls_scored))}</td>
              <td class="num tnum"><strong>${esc(r.avg_score ?? 0)}</strong></td>
              <td>${scoreLevelChip(level)}</td>
            </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;
  }

  rangeSel.addEventListener('change', draw);
  renderTabs();
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
