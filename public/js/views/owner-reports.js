/* The owner's report shelf — one screen, every report. */
(function () {
  'use strict';

  /*
   * Thirty-odd reports and one viewer.
   *
   * Each report declares its own columns and the server hands them over with
   * the rows, so adding a report needs no new screen and no new code here.
   * The alternative — a bespoke page each — guarantees that by the tenth one
   * the first three are formatted differently and nobody trusts any of them.
   *
   * Two things this screen does on purpose:
   *
   *   A report with no data behind it is shown greyed, with what is missing
   *   and a way to start recording. It is never shown as an empty table. An
   *   empty complaints register and a clinic with no complaints look
   *   identical on screen and are not remotely the same thing.
   *
   *   Every report's caveats are printed under it rather than hidden behind
   *   a tooltip. The notes are usually the difference between a number that
   *   can be acted on and one that cannot.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const esc = (v) => UI.esc(v === null || v === undefined ? '' : v);

  /** Draw one cell the way its column says to. */
  function cell(row, col) {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
    let out;
    switch (col.type) {
      case 'money': out = money(v); break;
      case 'num': out = UI.num(v) + (col.suffix || ''); break;
      case 'hours': out = `${UI.num(v, 1)} h`; break;
      case 'pct': out = `${esc(v)}%`; break;
      case 'date': out = esc(UI.date(v)); break;
      case 'datetime': out = esc(UI.dateTime(v)); break;
      case 'badge': return UI.badge(UI.titleise(String(v)), badgeTone(String(v)));
      default: out = esc(v);
    }
    if (col.strong || row.emphasis) out = `<b>${out}</b>`;
    if (col.tone === 'warn' && Number(v) > 0) out = `<span style="color:var(--orange-dark)">${out}</span>`;
    if (col.type === 'money' && Number(v) < 0) out = `<span style="color:var(--danger)">${out}</span>`;
    return out;
  }

  /* A badge's colour comes from what the word means, not from where it sits,
     so "expired" is red in every report that uses it. */
  const TONES = {
    danger: ['expired', 'lapsed', 'severe', 'death', 'serious', 'critical', 'absent',
      'out of stock', 'overdue', 'stat', 'no_show', 'cancelled', 'failed'],
    warn: ['due soon', 'open', 'investigating', 'moderate', 'at reorder level',
      'under a week left', 'under_repair', 'pending', 'urgent', 'query_raised',
      'partial', 'unrecorded', 'half_day', 'adjustment'],
    ok: ['in date', 'in stock', 'resolved', 'closed', 'done', 'present', 'paid',
      'verified', 'active', 'came back', 'recovered', 'passed'],
    teal: ['near_miss', 'no_harm', 'booked in', 'in_progress', 'action_agreed', 'leave'],
  };
  function badgeTone(value) {
    const v = value.toLowerCase().replace(/_/g, ' ');
    for (const [tone, words] of Object.entries(TONES)) {
      if (words.some((w) => v === w.replace(/_/g, ' '))) return tone;
    }
    return '';
  }

  const tile = (t) => `
    <div class="stat ${t.tone || 'teal'}">
      <div class="label">${esc(t.label)}</div>
      <div class="value">${t.value === null || t.value === undefined ? '—'
    : t.money ? money(t.value)
      : t.pct ? `${esc(t.value)}%`
        : typeof t.value === 'number' ? UI.num(t.value) + (t.suffix || '')
          : esc(t.value)}</div>
      <div class="foot">${esc(t.foot || '')}</div>
    </div>`;

  const table = (columns, rows) => UI.table(
    columns.map((c) => ({
      label: c.label,
      num: ['money', 'num', 'pct', 'hours'].includes(c.type),
      render: (r) => (r.kind === 'head'
        ? (c === columns[0] ? `<b class="section-row">${esc(r[c.key])}</b>` : '')
        : cell(r, c)),
    })),
    rows,
    { emptyText: 'Nothing in this period.' }
  );

  /** Registers the owner can open straight from the report that needs them. */
  const REGISTER_FOR = {
    complaints: { label: 'Open the complaints register', route: 'registers', tab: 'complaints' },
    incidents: { label: 'Open the incident register', route: 'registers', tab: 'incidents' },
    hygiene: { label: 'Open the hygiene log', route: 'registers', tab: 'hygiene' },
    compliance: { label: 'Open the compliance register', route: 'registers', tab: 'compliance' },
    attendance: { label: 'Open the attendance register', route: 'registers', tab: 'attendance' },
    payroll: { label: 'Open payroll', route: 'registers', tab: 'payroll' },
    'balance-sheet': { label: 'Enter the opening position', position: true },
  };

  async function render(host, state, onState) {
    host.innerHTML = UI.loading();
    const { groups } = await API.get('/api/owner/reports');

    const open = state.report;
    host.innerHTML = `
      <div class="card mb"><div class="card-body owner-filters">
        <label class="inline-label">From
          <input type="date" id="rp-from" value="${esc(state.from)}"></label>
        <label class="inline-label">To
          <input type="date" id="rp-to" value="${esc(state.to)}"></label>
        <span class="muted small">Some reports are live and say so — an overdue
          bill is overdue whichever month you are looking at.</span>
        ${open ? '<button class="btn ghost sm" id="rp-back" style="margin-left:auto">← All reports</button>' : ''}
      </div></div>
      <div id="rp-body">${UI.loading()}</div>`;

    const body = host.querySelector('#rp-body');
    const wire = (id, key) => {
      const el = host.querySelector(id);
      if (el) el.addEventListener('change', (e) => onState({ ...state, [key]: e.target.value }));
    };
    wire('#rp-from', 'from');
    wire('#rp-to', 'to');
    const back = host.querySelector('#rp-back');
    if (back) back.addEventListener('click', () => onState({ ...state, report: null }));

    if (open) await drawReport(body, open, state, onState);
    else drawIndex(body, groups, state, onState);
  }

  function drawIndex(body, groups, state, onState) {
    body.innerHTML = groups.map((g) => `
      <div class="card mb"><div class="card-head"><h3>${esc(g.label)}</h3>
        <span class="muted small">${g.reports.length} report${g.reports.length === 1 ? '' : 's'}</span></div>
        <div class="card-body"><div class="grid c3 report-grid">
          ${g.reports.map((r) => (r.at ? `
            <div class="report-card elsewhere">
              <div class="rc-title">${esc(r.title)}</div>
              <div class="rc-sub muted small">${esc(r.subtitle)}</div>
              <div class="rc-foot">On the <b>${r.at === 'commercial' ? 'Commercial eye' : 'Overview'}</b> tab</div>
            </div>` : `
            <button type="button" class="report-card ${r.needs ? 'needs' : ''}"
                    data-report="${esc(r.key)}">
              <div class="rc-title">${esc(r.title)}</div>
              <div class="rc-sub muted small">${esc(r.subtitle)}</div>
              ${r.needs ? '<div class="rc-foot warn">Nothing recorded yet — open to see what is needed</div>'
    : '<div class="rc-foot go">Open →</div>'}
            </button>`)).join('')}
        </div></div></div>`).join('');

    body.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () =>
      onState({ ...state, report: b.dataset.report })));
  }

  async function drawReport(body, key, state, onState) {
    body.innerHTML = UI.loading();
    const d = await API.get(`/api/owner/reports/${encodeURIComponent(key)}`
      + API.qs({ from: state.from, to: state.to }));

    if (d.needs) {
      const reg = REGISTER_FOR[key];
      body.innerHTML = `
        <div class="card"><div class="card-head"><h3>${esc(d.title)}</h3>
          <span class="muted small">${esc(d.subtitle)}</span></div>
          <div class="card-body">
            <div class="alert warn"><b>There is nothing to report yet, and that is
              not the same as nothing having happened.</b>
              <p style="margin:8px 0 0">${esc(d.needs)}</p></div>
            ${reg ? `<button class="btn mt" id="rp-register">${esc(reg.label)}</button>` : ''}
          </div></div>`;
      const btn = body.querySelector('#rp-register');
      if (btn) {
        btn.addEventListener('click', () => {
          if (reg.position) OWNER_REGISTERS.openPosition(() => onState({ ...state }));
          else OWNER_REGISTERS.open(reg.tab, () => onState({ ...state }));
        });
      }
      return;
    }

    const reg = REGISTER_FOR[key];
    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>${esc(d.title)}</h3>
        <span class="muted small">${esc(d.subtitle)}</span>
        ${reg ? `<button class="btn ghost sm" id="rp-register" style="margin-left:auto">${esc(reg.label)}</button>` : ''}</div>
        ${d.warn ? `<div class="card-body" style="padding-bottom:0">
          <div class="alert danger">${esc(d.warn)}</div></div>` : ''}
        ${d.tiles && d.tiles.length ? `<div class="card-body" style="padding-bottom:0">
          <div class="grid c4">${d.tiles.map(tile).join('')}</div></div>` : ''}
        ${d.empty ? `<div class="card-body">${UI.empty(d.empty, '📋')}</div>`
    : `<div class="card-body tight">${table(d.columns, d.rows)}</div>`}
      </div>

      ${(d.lists || []).map((l) => `
        <div class="card mb"><div class="card-head"><h3>${esc(l.title)}</h3></div>
          <div class="card-body tight">${table(l.columns, l.rows)}</div></div>`).join('')}

      ${(d.notes || []).length ? `<div class="card mb"><div class="card-body">
        <b class="muted small">What this report can and cannot tell you</b>
        <ul class="tight-list">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div></div>` : ''}`;

    const btn = body.querySelector('#rp-register');
    if (btn) {
      btn.addEventListener('click', () => {
        if (reg.position) OWNER_REGISTERS.openPosition(() => onState({ ...state }));
        else OWNER_REGISTERS.open(reg.tab, () => onState({ ...state }));
      });
    }
  }

  window.OWNER_REPORTS = { render };
})();
