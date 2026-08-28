// ---------------------------------------------------------------------------
// Admin portal: team management, all submissions, reporting.
// Every view here assumes an admin profile; app.js gates the routes.
// ---------------------------------------------------------------------------
import * as db from './db.js';
import { CATEGORIES, STATUSES, ROLES, APPT_STATUSES } from './config.js';
import {
  esc, fmtMoney, fmtMoneyExact, fmtNum, fmtPct, fmtDate, range, RANGES, monthStart,
  toast, barRow, legend, statusChip, apptChip, empty, spinner, selectField,
} from './ui.js';
import { catLabel, SERIES } from './views-agent.js';

/* === Agents =============================================================== */
export async function agents(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Agents</h1>
      <div class="page__sub">Roles, teams, and monthly AP targets</div>
    </div>
    <button class="btn" id="new-team">New team</button></div>
    <div class="card" id="roster">${spinner()}</div>`;

  const roster = document.getElementById('roster');

  document.getElementById('new-team').addEventListener('click', async () => {
    const name = prompt('Team name');
    if (!name?.trim()) return;
    try {
      await db.createTeam(name.trim());
      toast('Team created.', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function draw() {
    roster.innerHTML = spinner();
    const [people, teams] = await Promise.all([db.listAgents(), db.listTeams()]);

    if (people.length === 0) {
      roster.innerHTML = empty('No accounts yet.');
      return;
    }

    const teamOpts = [{ value: '', label: '— unassigned —' }, ...teams.map(t => ({ value: t.id, label: t.name }))];

    roster.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(people.length)} account${people.length === 1 ? '' : 's'}</h2>
        <span class="muted">Targets apply to the current month</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Name</th><th>Email</th><th>Role</th><th>Team</th>
          <th class="num">Month target</th><th>Active</th>
        </tr></thead>
        <tbody>${people.map(p => `
          <tr data-id="${esc(p.id)}">
            <td>${esc(p.full_name || '—')}</td>
            <td class="muted">${esc(p.email)}</td>
            <td>
              <select data-field="role">
                ${ROLES.map(r => `<option value="${r.value}"${r.value === p.role ? ' selected' : ''}>${r.label}</option>`).join('')}
              </select>
            </td>
            <td>
              <select data-field="team_id">
                ${teamOpts.map(t => `<option value="${esc(t.value)}"${t.value === (p.team_id || '') ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
              </select>
            </td>
            <td class="num">
              <input type="number" min="0" step="100" data-field="target" placeholder="—" style="width:110px;text-align:right">
            </td>
            <td>
              <input type="checkbox" data-field="active"${p.active ? ' checked' : ''}>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    // Each control saves on change — no separate save button to forget.
    roster.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;

      tr.querySelector('[data-field="role"]').addEventListener('change', e =>
        save(id, { role: e.target.value }, 'Role updated.'));

      tr.querySelector('[data-field="team_id"]').addEventListener('change', e =>
        save(id, { team_id: e.target.value || null }, 'Team updated.'));

      tr.querySelector('[data-field="active"]').addEventListener('change', e =>
        save(id, { active: e.target.checked }, e.target.checked ? 'Account activated.' : 'Account deactivated.'));

      const target = tr.querySelector('[data-field="target"]');
      target.addEventListener('change', async () => {
        const value = Number(target.value);
        if (!Number.isFinite(value) || value < 0) return toast('Enter a valid target.', 'error');
        try {
          await db.setGoal(id, monthStart(), value);
          toast('Target saved.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function save(id, patch, msg) {
    try {
      await db.updateAgent(id, patch);
      toast(msg, 'ok');
    } catch (err) {
      toast(err.message, 'error');
      draw();
    }
  }

  await draw();
}

/* === All submissions ====================================================== */
export async function submissions(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Submissions</h1>
      <div class="page__sub">Approve, reject, or flag a chargeback</div>
    </div></div>
    <div class="filters">
      ${selectField('sub-range', 'Period', RANGES, 'month')}
      ${selectField('sub-status', 'Status', [{ value: '', label: 'All statuses' }, ...STATUSES], 'pending')}
      ${selectField('sub-agent', 'Agent', [{ value: '', label: 'All agents' }], '')}
    </div>
    <div class="card" id="list">${spinner()}</div>`;

  const list = document.getElementById('list');
  const rangeSel = document.getElementById('sub-range');
  const statusSel = document.getElementById('sub-status');
  const agentSel = document.getElementById('sub-agent');

  const people = await db.listAgents();
  agentSel.innerHTML =
    `<option value="">All agents</option>` +
    people.map(p => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`).join('');

  async function draw() {
    list.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.allSubmissions({
      start, end,
      status: statusSel.value || undefined,
      agentId: agentSel.value || undefined,
    });

    if (rows.length === 0) {
      list.innerHTML = empty('No submissions match these filters.');
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
          <th>Date</th><th>Agent</th><th>Client</th><th>Product</th>
          <th class="num">AP</th><th>Status</th><th>Decision</th>
        </tr></thead>
        <tbody>${rows.map(s => `
          <tr data-id="${esc(s.id)}">
            <td class="tnum">${esc(fmtDate(s.submitted_on))}</td>
            <td>${esc(s.profiles?.full_name || '—')}</td>
            <td>${esc(s.client_name)}${s.notes ? `<br><span class="muted">${esc(s.notes.slice(0, 60))}</span>` : ''}</td>
            <td>${esc(s.products?.name || s.carrier || '—')}<br><span class="muted">${esc(catLabel(s.category))}</span></td>
            <td class="num">${esc(fmtMoneyExact(s.ap_amount))}</td>
            <td>${statusChip(s.status)}</td>
            <td>
              <select data-status>
                ${STATUSES.map(x => `<option value="${x.value}"${x.value === s.status ? ' selected' : ''}>${x.label}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.querySelector('[data-status]').addEventListener('change', async e => {
        try {
          await db.setSubmissionStatus(tr.dataset.id, e.target.value);
          toast('Status updated.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
          draw();
        }
      });
    });
  }

  [rangeSel, statusSel, agentSel].forEach(el => el.addEventListener('change', draw));
  await draw();
}

/* === Dialer activity ====================================================== */
export async function dialers(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Dialer activity</h1>
      <div class="page__sub">Volume, conversion, and the appointment book</div>
    </div></div>
    <div class="filters">
      ${selectField('dl-range', 'Period', RANGES, 'month')}
      ${selectField('dl-status', 'Appointment status', [{ value: '', label: 'All statuses' }, ...APPT_STATUSES], '')}
    </div>
    <div id="dl-body">${spinner()}</div>`;

  const body = document.getElementById('dl-body');
  const rangeSel = document.getElementById('dl-range');
  const statusSel = document.getElementById('dl-status');

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);

    const [board, appts] = await Promise.all([
      db.dialerLeaderboard(start, end),
      db.allAppointments({ start, end, status: statusSel.value || undefined, limit: 200 }),
    ]);

    const live = board.filter(r => Number(r.dials) > 0 || Number(r.appts) > 0);

    if (live.length === 0 && appts.length === 0) {
      body.innerHTML = `<div class="card">${empty('No dialer activity in this period. Dialers log volume from their own portal.')}</div>`;
      return;
    }

    const sum = key => live.reduce((acc, r) => acc + Number(r[key] || 0), 0);
    const dials = sum('dials');
    const contacts = sum('contacts');
    const totalAppts = sum('appts');
    const sold = sum('sold');
    const max = Math.max(...live.map(r => Number(r.appts)), 1);

    body.innerHTML = `
      <div class="kpis">
        ${statTileLite('Dials', fmtNum(dials), `${esc(fmtDate(start))} – ${esc(fmtDate(end))}`)}
        ${statTileLite('Contact rate', dials > 0 ? fmtPct(contacts / dials) : '—', `${fmtNum(contacts)} contacts`)}
        ${statTileLite('Appointments set', fmtNum(totalAppts), contacts > 0 ? `${fmtPct(totalAppts / contacts)} set rate` : 'No contacts yet')}
        ${statTileLite('Sold', fmtNum(sold), totalAppts > 0 ? `${fmtPct(sold / totalAppts)} of appointments` : '—')}
      </div>

      <div class="card">
        <div class="card__head">
          <h2>Appointments set by dialer</h2>
          <span class="muted">Monthly targets apply to the current month</span>
        </div>
        ${live.length === 0 ? empty('No volume logged in this period.') : `
          <div class="bars">
            ${live.map(r => barRow({
              rank: r.rank,
              label: r.full_name,
              sub: `${fmtNum(r.dials)} dials · ${fmtPct(r.contact_rate, 0)} contact · ${fmtPct(r.set_rate, 0)} set`,
              value: r.appts,
              display: fmtNum(r.appts),
              max,
            })).join('')}
          </div>
          <div class="tablewrap" style="margin-top:18px"><table>
            <thead><tr>
              <th>Dialer</th><th>Team</th>
              <th class="num">Dials</th><th class="num">Contacts</th>
              <th class="num">Appts</th><th class="num">Sold</th>
              <th class="num">Dial target</th><th class="num">Appt target</th>
            </tr></thead>
            <tbody>${live.map(r => `
              <tr data-dialer="${esc(r.dialer_id)}">
                <td>${esc(r.full_name)}</td>
                <td class="muted">${esc(r.team_name)}</td>
                <td class="num">${esc(fmtNum(r.dials))}</td>
                <td class="num">${esc(fmtNum(r.contacts))}</td>
                <td class="num">${esc(fmtNum(r.appts))}</td>
                <td class="num">${esc(fmtNum(r.sold))}</td>
                <td class="num"><input type="number" min="0" step="50" data-goal="dials" placeholder="—" style="width:96px;text-align:right"></td>
                <td class="num"><input type="number" min="0" step="1" data-goal="appts" placeholder="—" style="width:96px;text-align:right"></td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
      </div>

      <div class="card">
        <div class="card__head">
          <h2>Appointment book</h2>
          <span class="muted">${fmtNum(appts.length)} in range</span>
        </div>
        ${appts.length === 0 ? empty('No appointments match these filters.') : `
          <div class="tablewrap"><table>
            <thead><tr>
              <th>When</th><th>Lead</th><th>Dialer</th><th>Agent</th>
              <th>Set on</th><th>Status</th><th>Update</th>
            </tr></thead>
            <tbody>${appts.map(a => `
              <tr data-appt="${esc(a.id)}">
                <td class="tnum">${esc(new Date(a.scheduled_at).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                }))}</td>
                <td>${esc(a.lead_name)}</td>
                <td>${esc(a.dialer?.full_name || '—')}</td>
                <td>${esc(a.agent?.full_name || '— unassigned —')}</td>
                <td class="tnum muted">${esc(fmtDate(a.set_on))}</td>
                <td>${apptChip(a.status)}</td>
                <td>
                  <select data-status>
                    ${APPT_STATUSES.map(s => `<option value="${s.value}"${s.value === a.status ? ' selected' : ''}>${s.label}</option>`).join('')}
                  </select>
                </td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
      </div>`;

    // Targets: both inputs write one row, so read the sibling rather than
    // clobbering it with a zero.
    body.querySelectorAll('tr[data-dialer]').forEach(tr => {
      const id = tr.dataset.dialer;
      const dialsInput = tr.querySelector('[data-goal="dials"]');
      const apptsInput = tr.querySelector('[data-goal="appts"]');

      const saveGoal = async () => {
        const d = Number(dialsInput.value || 0);
        const a = Number(apptsInput.value || 0);
        if (!Number.isFinite(d) || d < 0 || !Number.isFinite(a) || a < 0) {
          return toast('Targets must be zero or greater.', 'error');
        }
        try {
          await db.setDialerGoal(id, monthStart(), d, a);
          toast('Target saved.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      };

      dialsInput.addEventListener('change', saveGoal);
      apptsInput.addEventListener('change', saveGoal);
    });

    body.querySelectorAll('tr[data-appt]').forEach(tr => {
      tr.querySelector('[data-status]').addEventListener('change', async e => {
        try {
          await db.setAppointmentStatus(tr.dataset.appt, e.target.value);
          toast('Status updated.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        draw();
      });
    });
  }

  [rangeSel, statusSel].forEach(el => el.addEventListener('change', draw));
  await draw();
}

/* === Reports ============================================================== */
export async function reports(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Reports</h1>
      <div class="page__sub">AP by category, status, and team</div>
    </div></div>
    <div class="filters">${selectField('rep-range', 'Period', RANGES, 'month')}</div>
    <div id="report">${spinner()}</div>`;

  const host = document.getElementById('report');
  const rangeSel = document.getElementById('rep-range');

  async function draw() {
    host.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.adminReport(start, end);

    if (rows.length === 0) {
      host.innerHTML = `<div class="card">${empty('No data in this period.')}</div>`;
      return;
    }

    const pick = bucket => rows.filter(r => r.bucket === bucket);
    const grand = pick('category').reduce((sum, r) => sum + Number(r.total_ap), 0);

    host.innerHTML = `
      <div class="kpis">
        ${statTileLite('Total AP', fmtMoney(grand), `${esc(fmtDate(start))} – ${esc(fmtDate(end))}`)}
        ${statTileLite('Submissions', fmtNum(pick('category').reduce((s, r) => s + Number(r.cnt), 0)), 'All statuses')}
        ${statTileLite('Teams reporting', fmtNum(pick('team').filter(r => Number(r.total_ap) > 0).length), 'With AP this period')}
      </div>

      ${section('AP by category', pick('category'), 'categorical')}
      ${section('AP by status', pick('status'), 'status')}
      ${section('AP by team', pick('team'), 'sequential')}`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}

const statTileLite = (label, value, note) => `
  <div class="kpi">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${esc(value)}</div>
    <div class="kpi__note">${esc(note)}</div>
  </div>`;

// Three breakdowns, three color jobs:
//   category  → categorical (the series ARE the subject; 3 slots, gate-safe)
//   status    → the reserved status palette, always with icon + label
//   team      → sequential, one hue (magnitude comparison, identity irrelevant)
function section(title, rows, colorJob) {
  const live = rows.filter(r => Number(r.total_ap) > 0 || Number(r.cnt) > 0);
  if (live.length === 0) return `<div class="card"><h2>${esc(title)}</h2>${empty('Nothing to show.')}</div>`;

  const max = Math.max(...live.map(r => Number(r.total_ap)));
  const total = live.reduce((sum, r) => sum + Number(r.total_ap), 0);

  const colorFor = row => {
    if (colorJob === 'categorical') return SERIES[row.label] || 'var(--seq-400)';
    if (colorJob === 'status') return `var(--${STATUSES.find(s => s.value === row.label)?.tone || 'seq-400'})`;
    return 'var(--seq-400)';
  };

  const labelFor = row => {
    if (colorJob === 'categorical') return catLabel(row.label);
    if (colorJob === 'status') return STATUSES.find(s => s.value === row.label)?.label || row.label;
    return row.label;
  };

  const legendHtml = colorJob === 'categorical'
    ? legend(live.map(r => ({ color: colorFor(r), label: labelFor(r) })))
    : '';

  return `
    <div class="card">
      <div class="card__head">
        <h2>${esc(title)}</h2>
        <span class="muted tnum">${fmtMoney(total)}</span>
      </div>
      ${legendHtml}
      <div class="bars">
        ${live.map(r => barRow({
          rank: null,
          label: labelFor(r),
          sub: `${fmtNum(r.cnt)} submission${Number(r.cnt) === 1 ? '' : 's'}`,
          value: r.total_ap,
          display: fmtMoney(r.total_ap),
          max,
          color: colorFor(r),
        })).join('')}
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
        <div class="tablewrap" style="margin-top:10px"><table>
          <thead><tr><th>${esc(title.replace('AP by ', ''))}</th><th class="num">AP</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
          <tbody>${live.map(r => `
            <tr>
              <td>${esc(labelFor(r))}</td>
              <td class="num">${esc(fmtMoneyExact(r.total_ap))}</td>
              <td class="num">${esc(fmtNum(r.cnt))}</td>
              <td class="num">${total > 0 ? Math.round((Number(r.total_ap) / total) * 100) : 0}%</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </details>
    </div>`;
}
