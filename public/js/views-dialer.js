// ---------------------------------------------------------------------------
// Dialer portal: dashboard, log activity, appointment book, dialer leaderboard.
//
// Volume is logged as a daily tally rather than per call — a dialer places
// 150-250 calls a day and per-call entry means the data never gets logged at
// all. Appointments, which are the events that carry money, get real records.
// ---------------------------------------------------------------------------
import * as db from './db.js';
import { APPT_STATUSES } from './config.js';
import {
  esc, fmtNum, fmtPct, fmtDate, today, range, RANGES,
  toast, statTile, barRow, legend, apptChip, empty, spinner, selectField,
} from './ui.js';

/* --- helpers ------------------------------------------------------------- */

// datetime-local wants `YYYY-MM-DDTHH:mm` in *local* time. Round to the next
// half hour so the default is a plausible appointment slot, not 3:47pm.
function defaultSlot() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 30), 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fmtWhen = iso =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

const apptRow = (a, { showDialer = false } = {}) => `
  <tr data-id="${esc(a.id)}">
    <td class="tnum">${esc(fmtWhen(a.scheduled_at))}</td>
    <td>${esc(a.lead_name)}${a.phone ? `<br><span class="muted">${esc(a.phone)}</span>` : ''}</td>
    ${showDialer ? `<td>${esc(a.dialer?.full_name || '—')}</td>` : ''}
    <td>${esc(a.agent?.full_name || '— unassigned —')}</td>
    <td class="tnum muted">${esc(fmtDate(a.set_on))}</td>
    <td>${apptChip(a.status)}</td>
  </tr>`;

/* === Dashboard ============================================================ */
export async function dashboard(main, ctx) {
  main.innerHTML = `
    <div class="page__head">
      <div>
        <h1>Dialer dashboard</h1>
        <div class="page__sub">${esc(ctx.profile.full_name)} · month to date</div>
      </div>
      <a class="btn btn--primary" href="#/dialer/log">Log activity</a>
    </div>
    <div id="kpis">${spinner()}</div>
    <div class="card" id="funnel">${spinner()}</div>
    <div class="card" id="upcoming">${spinner()}</div>`;

  const [m, appts] = await Promise.all([db.myDialerMetrics(), db.myAppointments({ limit: 100 })]);

  const targetAppts = Number(m.target_appointments) || 0;
  const apptsMonth = Number(m.appts_month) || 0;

  let apptMeter = null;
  let apptNote = 'No monthly target set';
  if (targetAppts > 0) {
    const pct = (apptsMonth / targetAppts) * 100;
    apptMeter = { pct, aria: `${Math.round(pct)}% of ${targetAppts} appointments` };
    const gap = targetAppts - apptsMonth;
    apptNote = gap > 0
      ? `${fmtNum(gap)} to go · ${Math.round(pct)}% of ${fmtNum(targetAppts)}`
      : `Target met · ${Math.round(pct)}% of ${fmtNum(targetAppts)}`;
  }

  const paceNote = m.days_elapsed > 0
    ? `Pace ${fmtNum(Math.round(m.appt_pace))} · ${fmtNum(m.days_elapsed)} of ${fmtNum(m.days_in_month)} days`
    : 'Month has not started';

  document.getElementById('kpis').outerHTML = `
    <div class="kpis" id="kpis">
      ${statTile({ label: 'Dials today', value: fmtNum(m.dials_today), note: `${fmtNum(m.contacts_today)} contacts` })}
      ${statTile({ label: 'Appointments today', value: fmtNum(m.appts_today), note: paceNote })}
      ${statTile({ label: 'Appointments this month', value: fmtNum(apptsMonth), note: apptNote, meter: apptMeter })}
      ${statTile({ label: 'Contact rate', value: fmtPct(m.contact_rate), note: `${fmtNum(m.contacts_month)} of ${fmtNum(m.dials_month)} dials` })}
    </div>`;

  // The funnel is four ordered stages of one quantity, so it is one hue getting
  // darker down the stack — not four categorical colors, which would imply the
  // stages are unrelated categories.
  const stages = [
    { label: 'Dials',        value: Number(m.dials_month) || 0,    hue: 'var(--seq-300)' },
    { label: 'Contacts',     value: Number(m.contacts_month) || 0, hue: 'var(--seq-400)' },
    { label: 'Appointments', value: apptsMonth,                    hue: 'var(--seq-500)' },
    { label: 'Sold',         value: Number(m.sold_month) || 0,     hue: 'var(--seq-600)' },
  ];
  const funnelMax = Math.max(...stages.map(s => s.value), 1);

  document.getElementById('funnel').innerHTML = `
    <div class="card__head">
      <h2>This month's funnel</h2>
      <span class="muted">Set rate ${esc(fmtPct(m.set_rate))} · Held ${esc(fmtPct(m.held_rate))} · Close ${esc(fmtPct(m.close_rate))}</span>
    </div>
    <div class="bars">
      ${stages.map(s => barRow({
        rank: null,
        label: s.label,
        sub: null,
        value: s.value,
        display: fmtNum(s.value),
        max: funnelMax,
        color: s.hue,
      })).join('')}
    </div>
    <p class="muted" style="margin:14px 0 0;font-size:12px">
      Rates read <code>—</code> until there is something to divide by; that is different from 0%.
    </p>`;

  const upcoming = appts
    .filter(a => a.status === 'scheduled' && new Date(a.scheduled_at) >= new Date())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
    .slice(0, 8);

  document.getElementById('upcoming').innerHTML = `
    <div class="card__head">
      <h2>Upcoming appointments</h2>
      <a class="linkbtn" href="#/dialer/appointments">View book</a>
    </div>
    ${upcoming.length === 0
      ? empty('Nothing scheduled ahead. Book one from Log activity.')
      : `<div class="tablewrap"><table>
          <thead><tr><th>When</th><th>Lead</th><th>Agent</th><th>Set on</th><th>Status</th></tr></thead>
          <tbody>${upcoming.map(a => apptRow(a)).join('')}</tbody>
        </table></div>`}`;
}

/* === Log activity ========================================================= */
export async function logActivity(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Log activity</h1>
      <div class="page__sub">One tally per day — saving again corrects the day, it does not add to it</div>
    </div></div>
    <div class="card" id="tally" style="max-width:640px">${spinner()}</div>
    <div class="card" id="book" style="max-width:640px">${spinner()}</div>`;

  const [agents] = await Promise.all([db.bookableAgents()]);

  /* --- daily tally --- */
  const tally = document.getElementById('tally');

  async function drawTally(dateStr) {
    const existing = await db.mySession(dateStr);
    tally.innerHTML = `
      <div class="card__head">
        <h2>Daily tally</h2>
        ${existing ? `<span class="muted">Editing an existing entry</span>` : `<span class="muted">New entry</span>`}
      </div>
      <form id="tally-form">
        <label class="field">
          <span>Date *</span>
          <input type="date" id="logged_on" value="${esc(dateStr)}" max="${today()}" required>
        </label>
        <div class="grid-2">
          <label class="field">
            <span>Dials *</span>
            <input type="number" id="dials" min="0" step="1" required value="${esc(existing?.dials ?? 0)}">
          </label>
          <label class="field">
            <span>Contacts *</span>
            <input type="number" id="contacts" min="0" step="1" required value="${esc(existing?.contacts ?? 0)}">
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>Voicemails</span>
            <input type="number" id="voicemails" min="0" step="1" value="${esc(existing?.voicemails ?? 0)}">
          </label>
          <label class="field">
            <span>Talk time (minutes)</span>
            <input type="number" id="talk_minutes" min="0" step="1" value="${esc(existing?.talk_minutes ?? 0)}">
          </label>
        </div>
        <label class="field">
          <span>Notes</span>
          <textarea id="tally-notes" maxlength="1000">${esc(existing?.notes ?? '')}</textarea>
        </label>
        <button class="btn btn--primary" type="submit" id="tally-save">Save tally</button>
      </form>`;

    // Reloading on date change means switching days shows that day's numbers
    // instead of silently overwriting it with the previous day's.
    tally.querySelector('#logged_on').addEventListener('change', e => drawTally(e.target.value));

    tally.querySelector('#tally-form').addEventListener('submit', async e => {
      e.preventDefault();
      const num = id => Number(tally.querySelector('#' + id).value || 0);
      const dials = num('dials');
      const contacts = num('contacts');
      const voicemails = num('voicemails');

      // Checked here as well as in Postgres so the dialer gets a useful message
      // instead of a raw constraint violation.
      if (contacts > dials) return toast('Contacts cannot exceed dials.', 'error');
      if (voicemails > dials) return toast('Voicemails cannot exceed dials.', 'error');

      const btn = tally.querySelector('#tally-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveSession(tally.querySelector('#logged_on').value, {
          dials, contacts, voicemails,
          talk_minutes: num('talk_minutes'),
          notes: tally.querySelector('#tally-notes').value.trim(),
        });
        toast('Tally saved.', 'ok');
        drawTally(tally.querySelector('#logged_on').value);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save tally';
      }
    });
  }

  await drawTally(today());

  /* --- book an appointment --- */
  const book = document.getElementById('book');
  book.innerHTML = `
    <div class="card__head"><h2>Book an appointment</h2></div>
    <form id="appt-form">
      <div class="grid-2">
        <label class="field">
          <span>Lead name *</span>
          <input type="text" id="lead_name" required maxlength="120">
        </label>
        <label class="field">
          <span>Phone</span>
          <input type="tel" id="phone" maxlength="40">
        </label>
      </div>
      <div class="grid-2">
        <label class="field">
          <span>Scheduled for *</span>
          <input type="datetime-local" id="scheduled_at" value="${defaultSlot()}" required>
        </label>
        <label class="field">
          <span>Agent</span>
          <select id="agent_id">
            <option value="">— unassigned —</option>
            ${agents.map(a => `<option value="${esc(a.id)}">${esc(a.full_name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field">
        <span>Notes</span>
        <textarea id="appt-notes" maxlength="1000"></textarea>
      </label>
      <button class="btn btn--primary" type="submit" id="appt-save">Book appointment</button>
    </form>`;

  book.querySelector('#appt-form').addEventListener('submit', async e => {
    e.preventDefault();
    const val = id => book.querySelector('#' + id).value.trim();
    const when = val('scheduled_at');
    if (!when) return toast('Pick a date and time.', 'error');

    const btn = book.querySelector('#appt-save');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    try {
      await db.createAppointment({
        lead_name: val('lead_name'),
        phone: val('phone'),
        // datetime-local has no zone. new Date() reads it as local time, and
        // toISOString converts to UTC for storage.
        scheduled_at: new Date(when).toISOString(),
        set_on: today(),
        agent_id: val('agent_id'),
        notes: book.querySelector('#appt-notes').value.trim(),
      });
      toast('Appointment booked.', 'ok');
      location.hash = '#/dialer/appointments';
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Book appointment';
    }
  });
}

/* === Appointment book ===================================================== */
export async function appointments(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Appointment book</h1>
      <div class="page__sub">Agents can update status too — whoever knows first</div>
    </div>
    <a class="btn btn--primary" href="#/dialer/log">Book one</a></div>
    <div class="filters">
      ${selectField('appt-status', 'Status', [{ value: '', label: 'All statuses' }, ...APPT_STATUSES], '')}
    </div>
    <div class="card" id="list">${spinner()}</div>`;

  const list = document.getElementById('list');
  const statusSel = document.getElementById('appt-status');

  async function draw() {
    list.innerHTML = spinner();
    const all = await db.myAppointments({ limit: 200 });
    const rows = statusSel.value ? all.filter(a => a.status === statusSel.value) : all;

    if (rows.length === 0) {
      list.innerHTML = empty(all.length === 0 ? 'No appointments booked yet.' : 'None match this filter.');
      return;
    }

    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} appointment${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted">${fmtNum(all.filter(a => a.status === 'sold').length)} sold</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>When</th><th>Lead</th><th>Agent</th><th>Set on</th>
          <th>Status</th><th>Update</th><th></th>
        </tr></thead>
        <tbody>${rows.map(a => `
          <tr data-id="${esc(a.id)}">
            <td class="tnum">${esc(fmtWhen(a.scheduled_at))}</td>
            <td>${esc(a.lead_name)}${a.phone ? `<br><span class="muted">${esc(a.phone)}</span>` : ''}</td>
            <td>${esc(a.agent?.full_name || '— unassigned —')}</td>
            <td class="tnum muted">${esc(fmtDate(a.set_on))}</td>
            <td>${apptChip(a.status)}</td>
            <td>
              <select data-status>
                ${APPT_STATUSES.map(s => `<option value="${s.value}"${s.value === a.status ? ' selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </td>
            <td>${a.status === 'scheduled'
              ? `<button class="btn btn--ghost btn--sm" data-del="${esc(a.id)}">Delete</button>`
              : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.querySelector('[data-status]').addEventListener('change', async e => {
        try {
          await db.setAppointmentStatus(tr.dataset.id, e.target.value);
          toast('Status updated.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        draw();
      });
    });

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this appointment? This cannot be undone.')) return;
        try {
          await db.deleteAppointment(btn.dataset.del);
          toast('Appointment deleted.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  statusSel.addEventListener('change', draw);
  await draw();
}

/* === Dialer leaderboard =================================================== */
export async function leaderboard(main, ctx) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Dialer leaderboard</h1>
      <div class="page__sub">Ranked by appointments set</div>
    </div></div>
    <div class="filters">${selectField('dlb-range', 'Period', RANGES, 'month')}</div>
    <div class="card" id="board">${spinner()}</div>`;

  const board = document.getElementById('board');
  const rangeSel = document.getElementById('dlb-range');

  async function draw() {
    board.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.dialerLeaderboard(start, end);
    const live = rows.filter(r => Number(r.appts) > 0 || Number(r.dials) > 0);

    if (live.length === 0) {
      board.innerHTML = `
        <div class="card__head"><h2>${esc(fmtDate(start))} – ${esc(fmtDate(end))}</h2></div>
        ${empty('No dialer activity in this period.')}`;
      return;
    }

    const max = Math.max(...live.map(r => Number(r.appts)), 1);

    board.innerHTML = `
      <div class="card__head">
        <h2>${esc(fmtDate(start))} – ${esc(fmtDate(end))}</h2>
        <span class="muted tnum">${fmtNum(live.reduce((s, r) => s + Number(r.appts), 0))} appointments</span>
      </div>
      ${legend([
        { color: 'var(--seq-400)', label: 'Appointments set' },
        { color: 'var(--series-2)', label: 'You' },
      ])}
      <div class="bars">
        ${live.map(r => barRow({
          rank: r.rank,
          label: r.full_name,
          sub: `${fmtNum(r.dials)} dials · ${fmtPct(r.contact_rate, 0)} contact · ${fmtPct(r.set_rate, 0)} set`,
          value: r.appts,
          display: fmtNum(r.appts),
          max,
          highlight: r.dialer_id === ctx.profile.id,
        })).join('')}
      </div>
      <details style="margin-top:16px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
        <div class="tablewrap" style="margin-top:10px"><table>
          <thead><tr>
            <th>Dialer</th><th>Team</th><th class="num">Dials</th><th class="num">Contacts</th>
            <th class="num">Appts</th><th class="num">Sold</th>
            <th class="num">Contact rate</th><th class="num">Set rate</th>
          </tr></thead>
          <tbody>${live.map(r => `
            <tr>
              <td>${esc(r.full_name)}</td>
              <td class="muted">${esc(r.team_name)}</td>
              <td class="num">${esc(fmtNum(r.dials))}</td>
              <td class="num">${esc(fmtNum(r.contacts))}</td>
              <td class="num">${esc(fmtNum(r.appts))}</td>
              <td class="num">${esc(fmtNum(r.sold))}</td>
              <td class="num">${esc(fmtPct(r.contact_rate))}</td>
              <td class="num">${esc(fmtPct(r.set_rate))}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </details>`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}
