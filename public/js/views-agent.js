// ---------------------------------------------------------------------------
// Agent-facing views: dashboard, log a sale, my sales, leaderboard.
// Every view exports render(main, ctx) and wires its own listeners.
// ---------------------------------------------------------------------------
import * as db from './db.js';
import { CATEGORIES, STATUSES, APPT_STATUSES } from './config.js';
import {
  esc, fmtMoney, fmtMoneyExact, fmtNum, fmtDate, today, range, RANGES,
  toast, statTile, barRow, legend, statusChip, apptChip, empty, spinner, selectField,
} from './ui.js';

const SERIES = {
  mapd:      'var(--series-1)',
  ancillary: 'var(--series-2)',
  combined:  'var(--series-3)',
};

/* === Dashboard ============================================================ */
export async function dashboard(main, ctx) {
  main.innerHTML = `
    <div class="page__head">
      <div>
        <h1>Dashboard</h1>
        <div class="page__sub">${esc(ctx.profile.full_name)} · month to date</div>
      </div>
      <a class="btn btn--primary" href="#/submit">Log a sale</a>
    </div>
    <div id="kpis">${spinner()}</div>
    <div class="card" id="recent">${spinner()}</div>`;

  const [m, mine] = await Promise.all([db.myMetrics(), db.mySubmissions({ limit: 8 })]);

  const target = Number(m.target_ap) || 0;
  const monthAp = Number(m.month_ap) || 0;
  const pace = Number(m.pace) || 0;

  // Pace projects month-end from business days elapsed. Showing the divisor
  // matters: early in a month a single sale projects to an absurd number, and
  // "2 of 21 selling days" is what stops that being read as a forecast.
  const paceNote = m.days_elapsed > 0
    ? `${fmtNum(m.days_elapsed)} of ${fmtNum(m.days_in_month)} selling days elapsed`
    : 'Month has not started';

  let targetNote = 'No monthly target set';
  let meter = null;
  if (target > 0) {
    const pct = (monthAp / target) * 100;
    meter = { pct, aria: `${Math.round(pct)}% of ${fmtMoney(target)} target` };
    const gap = target - monthAp;
    targetNote = gap > 0
      ? `${fmtMoney(gap)} to go · ${Math.round(pct)}% of ${fmtMoney(target)}`
      : `Target met · ${Math.round(pct)}% of ${fmtMoney(target)}`;
  }

  document.getElementById('kpis').outerHTML = `
    <div class="kpis" id="kpis">
      ${statTile({ label: 'Daily AP', value: fmtMoney(m.daily_ap), note: 'Submitted today' })}
      ${statTile({
        label: 'Month AP', value: fmtMoney(monthAp),
        note: `${fmtNum(m.month_count)} submission${Number(m.month_count) === 1 ? '' : 's'}`,
        meter,
      })}
      ${statTile({ label: 'Pace', value: fmtMoney(pace), note: paceNote })}
      ${statTile({ label: 'To target', value: target > 0 ? fmtMoney(Math.max(0, target - monthAp)) : '—', note: targetNote })}
    </div>`;

  const recent = document.getElementById('recent');
  recent.innerHTML = `
    <div class="card__head">
      <h2>Recent submissions</h2>
      <a class="linkbtn" href="#/my-sales">View all</a>
    </div>
    ${mine.length === 0
      ? empty('No submissions yet. Log your first sale to get on the board.')
      : `<div class="tablewrap"><table>
          <thead><tr>
            <th>Date</th><th>Client</th><th>Product</th>
            <th class="num">AP</th><th>Status</th>
          </tr></thead>
          <tbody>${mine.map(rowHtml).join('')}</tbody>
        </table></div>`}`;
}

const rowHtml = s => `
  <tr>
    <td class="tnum">${esc(fmtDate(s.submitted_on))}</td>
    <td>${esc(s.client_name)}</td>
    <td>${esc(s.products?.name || s.carrier || '—')}<br><span class="muted">${esc(catLabel(s.category))}</span></td>
    <td class="num">${esc(fmtMoneyExact(s.ap_amount))}</td>
    <td>${statusChip(s.status)}</td>
  </tr>`;

const catLabel = v => CATEGORIES.find(c => c.value === v)?.label || v;

/* === Log a sale =========================================================== */
export async function submit(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Log a sale</h1>
      <div class="page__sub">Goes in as pending until an admin approves it</div>
    </div></div>
    <div class="card" style="max-width:620px">${spinner()}</div>`;

  const products = await db.listProducts();
  const card = main.querySelector('.card');

  card.innerHTML = `
    <form id="sale-form">
      <div class="grid-2">
        <label class="field">
          <span>Client name *</span>
          <input type="text" id="client_name" required maxlength="120">
        </label>
        <label class="field">
          <span>Submitted on *</span>
          <input type="date" id="submitted_on" value="${today()}" max="${today()}" required>
        </label>
      </div>

      <label class="field">
        <span>Product</span>
        <select id="product_id">
          <option value="">— none / other —</option>
          ${products.map(p =>
            `<option value="${esc(p.id)}" data-category="${esc(p.category)}" data-carrier="${esc(p.carrier)}">${esc(p.carrier)} — ${esc(p.name)}</option>`
          ).join('')}
        </select>
      </label>

      <div class="grid-2">
        ${selectField('category', 'Category *', CATEGORIES, 'mapd')}
        <label class="field">
          <span>Annualized premium *</span>
          <input type="number" id="ap_amount" min="0" step="0.01" required placeholder="0.00">
        </label>
      </div>

      <div class="grid-2">
        <label class="field">
          <span>Carrier</span>
          <input type="text" id="carrier" maxlength="80">
        </label>
        <label class="field">
          <span>Policy number</span>
          <input type="text" id="policy_number" maxlength="80">
        </label>
      </div>

      <label class="field">
        <span>Notes</span>
        <textarea id="notes" maxlength="1000"></textarea>
      </label>

      <button class="btn btn--primary" type="submit" id="sale-submit">Submit sale</button>
    </form>`;

  // Picking a product fills category and carrier, but never overwrites a
  // carrier the agent already typed.
  const productSel = card.querySelector('#product_id');
  productSel.addEventListener('change', () => {
    const opt = productSel.selectedOptions[0];
    if (!opt?.value) return;
    card.querySelector('#category').value = opt.dataset.category;
    const carrier = card.querySelector('#carrier');
    if (!carrier.value.trim()) carrier.value = opt.dataset.carrier || '';
  });

  card.querySelector('#sale-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = card.querySelector('#sale-submit');
    const val = id => card.querySelector('#' + id).value.trim();

    const ap = Number(val('ap_amount'));
    if (!Number.isFinite(ap) || ap < 0) return toast('Enter a valid premium amount.', 'error');

    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      await db.createSubmission({
        client_name: val('client_name'),
        submitted_on: val('submitted_on'),
        product_id: val('product_id'),
        category: val('category'),
        ap_amount: ap,
        carrier: val('carrier'),
        policy_number: val('policy_number'),
        notes: val('notes'),
      });
      toast('Sale logged.', 'ok');
      location.hash = '#/my-sales';
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Submit sale';
    }
  });
}

/* === My sales ============================================================= */
export async function mySales(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>My sales</h1>
      <div class="page__sub">Pending rows can still be deleted</div>
    </div>
    <a class="btn btn--primary" href="#/submit">Log a sale</a></div>
    <div class="card" id="list">${spinner()}</div>`;

  const list = document.getElementById('list');

  async function draw() {
    const rows = await db.mySubmissions({ limit: 200 });
    if (rows.length === 0) {
      list.innerHTML = empty('Nothing logged yet.');
      return;
    }

    const total = rows.reduce((sum, r) => sum + Number(r.ap_amount), 0);
    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} submission${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted tnum">${fmtMoneyExact(total)} total AP</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Date</th><th>Client</th><th>Product</th><th>Policy</th>
          <th class="num">AP</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(s => `
          <tr>
            <td class="tnum">${esc(fmtDate(s.submitted_on))}</td>
            <td>${esc(s.client_name)}</td>
            <td>${esc(s.products?.name || s.carrier || '—')}<br><span class="muted">${esc(catLabel(s.category))}</span></td>
            <td>${esc(s.policy_number || '—')}</td>
            <td class="num">${esc(fmtMoneyExact(s.ap_amount))}</td>
            <td>${statusChip(s.status)}</td>
            <td>${s.status === 'pending'
              ? `<button class="btn btn--ghost btn--sm" data-del="${esc(s.id)}">Delete</button>`
              : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this pending submission? This cannot be undone.')) return;
        try {
          await db.deleteSubmission(btn.dataset.del);
          toast('Submission deleted.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  await draw();
}

/* === Leaderboard ========================================================== */
export async function leaderboard(main, ctx) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Leaderboard</h1>
      <div class="page__sub">Pending and approved AP, ranked</div>
    </div></div>
    <div class="filters">
      ${selectField('lb-range', 'Period', RANGES, 'month')}
      ${selectField('lb-cat', 'Category', [{ value: '', label: 'All categories' }, ...CATEGORIES], '')}
    </div>
    <div class="card" id="board">${spinner()}</div>`;

  const board = document.getElementById('board');
  const rangeSel = document.getElementById('lb-range');
  const catSel = document.getElementById('lb-cat');

  async function draw() {
    board.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.leaderboard(start, end, catSel.value || null);

    const ranked = rows.filter(r => Number(r.total_ap) > 0);
    if (ranked.length === 0) {
      board.innerHTML = `
        <div class="card__head"><h2>${esc(fmtDate(start))} – ${esc(fmtDate(end))}</h2></div>
        ${empty('No AP recorded in this period.')}`;
      return;
    }

    // Magnitude comparison → one hue, scaled to the leader. The viewer's own
    // row is the emphasis color so they can find themselves without hunting.
    const max = Math.max(...ranked.map(r => Number(r.total_ap)));
    const total = ranked.reduce((sum, r) => sum + Number(r.total_ap), 0);

    board.innerHTML = `
      <div class="card__head">
        <h2>${esc(fmtDate(start))} – ${esc(fmtDate(end))}</h2>
        <span class="muted tnum">${fmtMoney(total)} total AP</span>
      </div>
      ${legend([
        { color: 'var(--seq-400)', label: 'Agent AP' },
        { color: 'var(--series-2)', label: 'You' },
      ])}
      <div class="bars">
        ${ranked.map(r => barRow({
          rank: r.rank,
          label: r.full_name,
          sub: `${r.team_name} · ${fmtNum(r.submission_count)} sales`,
          value: r.total_ap,
          display: fmtMoney(r.total_ap),
          max,
          highlight: r.agent_id === ctx.profile.id,
        })).join('')}
      </div>`;
  }

  rangeSel.addEventListener('change', draw);
  catSel.addEventListener('change', draw);
  await draw();
}

/* === My appointments (agent side) ========================================= */
// Appointments a dialer booked FOR this agent. The agent is the only person
// who actually knows whether one held, so they can resolve the status from
// here rather than the dialer guessing.
export async function myAppointments(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>My appointments</h1>
      <div class="page__sub">Booked for you by a dialer — mark what happened</div>
    </div></div>
    <div class="card" id="list">${spinner()}</div>`;

  const list = document.getElementById('list');

  async function draw() {
    list.innerHTML = spinner();
    const rows = await db.appointmentsForMe({ limit: 150 });

    if (rows.length === 0) {
      list.innerHTML = empty('No appointments booked for you yet.');
      return;
    }

    const now = new Date();
    const upcoming = rows.filter(a => a.status === 'scheduled' && new Date(a.scheduled_at) >= now).length;

    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} appointment${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted">${fmtNum(upcoming)} still upcoming</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>When</th><th>Lead</th><th>Booked by</th><th>Status</th><th>Update</th>
        </tr></thead>
        <tbody>${rows.map(a => `
          <tr data-id="${esc(a.id)}">
            <td class="tnum">${esc(new Date(a.scheduled_at).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            }))}</td>
            <td>${esc(a.lead_name)}${a.phone ? `<br><span class="muted">${esc(a.phone)}</span>` : ''}</td>
            <td>${esc(a.dialer?.full_name || '—')}</td>
            <td>${apptChip(a.status)}</td>
            <td>
              <select data-status>
                ${APPT_STATUSES.map(s => `<option value="${s.value}"${s.value === a.status ? ' selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </td>
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
  }

  await draw();
}

export { SERIES, catLabel };
