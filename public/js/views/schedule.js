/**
 * The duty chart.
 *
 * The clinic keeps this on a sheet of paper and adjusts it in a
 * spreadsheet, so the screen is a grid and not a form: a row per doctor,
 * a column per day, and the hours written in the cells. Somebody who has
 * been editing that spreadsheet for a year should be able to use this
 * without being taught it.
 *
 * Two views of the same week. "The week" is the grid they edit. "One day"
 * draws the printed chart — the hour ruler across the top and a bar for
 * every clinic — which is the thing that goes on the noticeboard and the
 * thing that shows a clash at a glance.
 *
 * Everything written here lands in the weekly rota the rest of the ERP
 * already reads, so the appointment book, the queue board, the token slips
 * and the WhatsApp line all follow from it without a second entry
 * anywhere.
 */
(function () {
  'use strict';

  let meta = null;
  const isManagement = () => Boolean(APP.user && ['owner', 'admin'].includes(APP.user.role));

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const to12h = (hhmm) => UI.to12h(hhmm);
  /*
   * '9:00 AM' is read as '9 AM' by everybody and takes a third less room,
   * which is the difference between seven day columns fitting on the screen
   * and the clinic scrolling sideways to see Saturday.
   */
  const compact = (hhmm) => to12h(hhmm).replace(':00', '');
  const label = (w) => `${compact(w.start_time)}–${compact(w.end_time)}`;

  APP.register('schedule', {
    title: "Doctors' Timing Schedule",
    subtitle: 'The duty chart — who sits where, and when',

    async render(el, params) {
      const tabs = { week: weekTab, day: dayTab };
      const open = tabs[params.tab] ? params.tab : 'week';

      APP.actions([
        { id: 'print', label: 'Print the chart', onClick: () => printChart() },
        { id: 'refresh', label: 'Refresh', onClick: () => APP.reload() },
      ]);

      el.innerHTML = `
        <div class="tabs" id="sc-tabs">
          <button data-tab="week" class="${open === 'week' ? 'active' : ''}">The week</button>
          <button data-tab="day" class="${open === 'day' ? 'active' : ''}">One day, as the chart</button>
        </div>
        <div id="sc-body">${UI.loading()}</div>`;

      const body = el.querySelector('#sc-body');
      el.querySelectorAll('#sc-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#sc-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await tabs[open](body);
    },
  });

  // ============================================================== the week
  async function weekTab(host) {
    const data = await API.get('/api/schedule');
    meta = data;

    host.innerHTML = `
      ${clashBanner(data.clashes)}
      <div class="alert info">The hours entered here are what the appointment book offers, what the
        queue calls patients by, what the token slip prints, and what the WhatsApp line tells anybody
        who asks whether a doctor is in. One chart, and everything follows it.
        ${isManagement() ? 'Click a cell to set that day\'s hours.'
    : 'Only the owner and the administrator can change it.'}</div>

      <div class="table-wrap">
        <table class="sc-grid">
          <thead><tr>
            <th class="sc-who">Doctor</th>
            <th>Specialty</th>
            <th>OP room</th>
            ${SHORT.map((d, i) => `<th class="sc-day ${i === new Date().getDay() ? 'today' : ''}">${d}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${data.doctors.map((doc) => docRow(doc, data.rooms)).join('')}
            ${data.awaiting.map(awaitingRow).join('')}
          </tbody>
        </table>
      </div>

      <div class="muted small mt">A specialty with no doctor is still on the chart — the clinic's
        own sheet keeps those rows, and hiding them would hide the recruiting they stand for.</div>`;

    if (!isManagement()) return;
    host.querySelectorAll('[data-cell]').forEach((td) => td.addEventListener('click', () => {
      const [doctorId, weekday] = td.dataset.cell.split(':').map(Number);
      editCell(data.doctors.find((d) => d.id === doctorId), weekday, data.rooms, host);
    }));
    host.querySelectorAll('[data-room-for]').forEach((sel) => sel.addEventListener('change', async () => {
      await API.post(`/api/schedule/doctors/${sel.dataset.roomFor}/room`,
        { roomId: sel.value ? Number(sel.value) : null });
      UI.ok('Room set — their hours moved with it.');
      weekTab(host);
    }));
  }

  function docRow(doc, rooms) {
    return `<tr>
      <td class="sc-who"><b>${UI.esc(doc.name)}</b>
        ${doc.qualification ? `<div class="muted small">${UI.esc(doc.qualification)}</div>` : ''}</td>
      <td>${UI.esc(doc.category_name || doc.department_name || '—')}</td>
      <td>${isManagement()
    ? `<select data-room-for="${doc.id}">
            <option value="">— none —</option>
            ${rooms.map((r) => `<option value="${r.id}"
              ${doc.room && doc.room.name === r.name ? 'selected' : ''}>${UI.esc(r.name)}</option>`).join('')}
          </select>
          ${doc.room ? `<div class="muted small">${UI.esc(doc.room.floor)}</div>` : ''}`
    : (doc.room ? `${UI.esc(doc.room.name)}<div class="muted small">${UI.esc(doc.room.floor)}</div>`
      : '<span class="muted">—</span>')}</td>
      ${doc.days.map((windows, weekday) => `
        <td class="sc-cell ${windows.length ? 'on' : ''} ${isManagement() ? 'editable' : ''}"
            ${isManagement() ? `data-cell="${doc.id}:${weekday}"` : ''}>
          ${windows.length
    ? windows.map((w) => `<div class="sc-win">${UI.esc(label(w))}</div>`).join('')
    : '<span class="muted small">—</span>'}
        </td>`).join('')}
    </tr>`;
  }

  const awaitingRow = (cat) => `<tr class="sc-awaiting">
    <td class="sc-who"><i>To be confirmed</i></td>
    <td>${UI.esc(cat.name)}</td>
    <td colspan="8"><span class="muted">Doctor and timing to be confirmed${cat.departments
  ? ` — ${UI.esc(cat.departments)}` : ''}</span></td>
  </tr>`;

  const clashBanner = (clashes) => (clashes.length
    ? `<div class="alert warn"><b>${UI.num(clashes.length)} room clash(es).</b>
        ${clashes.slice(0, 4).map((c) => `${UI.esc(c.room)} has ${UI.esc(c.doctors.join(' and '))}
          on ${UI.esc(c.day)}, ${UI.esc(c.from)}–${UI.esc(c.to)}.`).join(' ')}
        ${clashes.length > 4 ? `…and ${UI.num(clashes.length - 4)} more.` : ''}
        <div class="small mt">Recorded rather than refused — two clinics may genuinely share a room
          — but the slip and the screen will send both sets of patients to the same door.</div>
      </div>`
    : '');

  /**
   * One cell: a doctor's hours for one day.
   *
   * Two windows is the normal shape here — a morning and an evening — so
   * the dialog offers both rather than making somebody add a row to find
   * out that it can.
   */
  function editCell(doc, weekday, rooms, host) {
    const windows = doc.days[weekday];
    const w1 = windows[0] || {};
    const w2 = windows[1] || {};
    const roomId = (windows.find((w) => w.op_room_id) || {}).op_room_id
      || (doc.room ? (rooms.find((r) => r.name === doc.room.name) || {}).id : '') || '';

    UI.modal({
      title: `${doc.name} — ${DAYS[weekday]}`,
      size: '',
      body: `
        <div class="muted small mb">${UI.esc(doc.category_name || doc.department_name || '')}
          ${doc.room ? ` · usually ${UI.esc(doc.room.name)}, ${UI.esc(doc.room.floor)}` : ''}</div>
        <form id="sc-form">
          <fieldset><legend>Morning / first session</legend>
            <div class="grid c3">
              ${UI.field({ name: 'start1', label: 'From', type: 'time', value: w1.start_time || '' })}
              ${UI.field({ name: 'end1', label: 'To', type: 'time', value: w1.end_time || '' })}
              ${UI.field({ name: 'slot1', label: 'Minutes per patient', type: 'number', min: 5, max: 120,
    value: w1.slot_minutes || doc.slot_minutes || 15 })}
            </div>
          </fieldset>
          <fieldset><legend>Evening / second session</legend>
            <div class="grid c3">
              ${UI.field({ name: 'start2', label: 'From', type: 'time', value: w2.start_time || '' })}
              ${UI.field({ name: 'end2', label: 'To', type: 'time', value: w2.end_time || '' })}
              ${UI.field({ name: 'slot2', label: 'Minutes per patient', type: 'number', min: 5, max: 120,
    value: w2.slot_minutes || doc.slot_minutes || 15 })}
            </div>
          </fieldset>
          ${UI.field({ name: 'roomId', label: 'Consulting room for this day', value: roomId,
    options: [{ value: '', label: '— wherever the specialty sits —' }]
      .concat(rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.floor}` }))) })}
          ${UI.field({ name: 'note', label: 'Note', value: w1.note || '',
    placeholder: 'Alternate weeks, camp day…' })}
        </form>
        <label class="mt"><input type="checkbox" id="sc-all"> Apply to the whole week
          (Monday to Saturday)</label>
        <div class="muted small">Leave both sessions empty to mark the doctor as not sitting that day.</div>
        <div id="sc-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#sc-form'));
        const windowsOut = [];
        if (v.start1 && v.end1) {
          windowsOut.push({ start: v.start1, end: v.end1, slotMinutes: v.slot1,
            roomId: v.roomId || null, note: v.note || null });
        }
        if (v.start2 && v.end2) {
          windowsOut.push({ start: v.start2, end: v.end2, slotMinutes: v.slot2,
            roomId: v.roomId || null, note: v.note || null });
        }
        try {
          await API.put(`/api/schedule/doctors/${doc.id}/days/${weekday}`, { windows: windowsOut });
          if (modal.querySelector('#sc-all').checked) {
            await API.post(`/api/schedule/doctors/${doc.id}/copy`,
              { from: weekday, to: [1, 2, 3, 4, 5, 6] });
          }
          UI.ok(windowsOut.length
            ? `${doc.name}: ${windowsOut.map((w) => `${to12h(w.start)}–${to12h(w.end)}`).join(', ')}`
            : `${doc.name} is not sitting on ${DAYS[weekday]}.`);
          UI.closeModal();
          weekTab(host);
        } catch (err) {
          modal.querySelector('#sc-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  // =========================================================== one day
  /**
   * The printed chart: an hour ruler and a bar per clinic.
   *
   * Same information as the grid, read differently — the grid answers "when
   * is Dr Prathiba in" and this answers "who is in at six o'clock, and is
   * anybody double-booked". A clinic needs both and the paper version has
   * always been this one.
   */
  async function dayTab(host) {
    let weekday = new Date().getDay();
    let date = UI.today();

    const draw = async () => {
      const d = await API.get(`/api/schedule/day/${weekday}` + API.qs({ date }));
      host.innerHTML = `
        <div class="search-row">
          ${SHORT.map((s, i) => `<button class="btn sm ${i === weekday ? '' : 'ghost'}"
            data-day="${i}">${s}</button>`).join('')}
          <input type="date" id="sc-date" value="${UI.esc(date)}" style="max-width:170px">
          <span class="muted small" style="align-self:center">A date shows what that day actually
            holds — hours fixed for it, and anybody on leave.</span>
        </div>
        ${clashBanner(d.clashes)}

        <div class="card"><div class="card-head">
          <h3>${UI.esc(d.day)}${date ? ` · ${UI.esc(UI.date(date))}` : ''}</h3>
          <span class="muted small">Clinic hours ${UI.esc(to12h(d.dayStart))} – ${UI.esc(to12h(d.dayEnd))}</span>
        </div>
        <div class="card-body tight" id="sc-chart">
          <div class="sc-ruler">
            <div class="sc-rowhead"></div>
            <div class="sc-track">${d.hours.map((h, i) => {
    /*
     * The first and last ticks sit against the edges of the track, so
     * they are anchored rather than centred — a centred 7 AM is half
     * outside the box and reads as "AM".
     */
    const edge = i === 0 ? 'transform:none'
      : (i === d.hours.length - 1 ? 'transform:translateX(-100%)' : '');
    return `<span class="sc-tick" style="left:${h.left}%;${edge}">${UI.esc(h.label)}</span>`;
  }).join('')}</div>
          </div>
          ${d.rows.map(chartRow).join('')}
          ${d.awaiting.map((c) => `<div class="sc-bar-row awaiting">
            <div class="sc-rowhead"><b>To be confirmed</b><div class="muted small">${UI.esc(c.name)}</div></div>
            <div class="sc-track"><span class="sc-tbc">Doctor &amp; timing to be confirmed</span></div>
          </div>`).join('')}
        </div></div>`;

      host.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
        weekday = Number(b.dataset.day);
        /*
         * Changing the weekday by hand means "show me Wednesday", not
         * "show me this Wednesday" — so the date goes, and with it the
         * leave and the one-off windows that belong to a real date.
         */
        date = '';
        draw();
      }));
      host.querySelector('#sc-date').addEventListener('change', (e) => {
        date = e.target.value;
        if (date) weekday = new Date(`${date}T00:00:00`).getDay();
        draw();
      });
    };

    await draw();
  }

  const chartRow = (r) => `<div class="sc-bar-row ${r.windows.length ? '' : 'off'}">
    <div class="sc-rowhead">
      <b>${UI.esc(r.doctor)}</b>
      <div class="muted small">${UI.esc(r.specialty)}${r.room
  ? ` · ${UI.esc(r.room)}, ${UI.esc(r.floor)}` : ''}</div>
    </div>
    <div class="sc-track">
      ${r.windows.length
    ? r.windows.map((w) => `<span class="sc-bar" style="left:${w.left}%;width:${w.width}%"
          title="${UI.esc(w.label)}">${UI.esc(w.label)}</span>`).join('')
    : `<span class="sc-none">${r.onLeave ? 'On leave' : 'Not sitting'}</span>`}
    </div>
  </div>`;

  /** The chart as it goes on the noticeboard: one page per day. */
  async function printChart() {
    const days = [];
    for (let i = 0; i < 7; i += 1) days.push(await API.get(`/api/schedule/day/${i}`));

    const page = (d) => `<div class="doc" style="page-break-after:always">
      ${UI.docHeader(`Duty chart — ${d.day}`, [
    `Clinic hours ${to12h(d.dayStart)} – ${to12h(d.dayEnd)}`,
    'OP-1 & OP-2 Ground Floor · OP-3 & OP-4 First Floor'])}
      <table><thead><tr><th>Doctor</th><th>Specialty</th><th>OP room</th><th>Floor</th>
        <th>Hours</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr>
          <td>${UI.esc(r.doctor)}</td><td>${UI.esc(r.specialty)}</td>
          <td>${UI.esc(r.room || '—')}</td><td>${UI.esc(r.floor || '—')}</td>
          <td>${r.windows.length ? UI.esc(r.windows.map((w) => w.label).join(', '))
    : '<i>Not sitting</i>'}</td></tr>`).join('')}
        ${d.awaiting.map((c) => `<tr><td><i>To be confirmed</i></td><td>${UI.esc(c.name)}</td>
          <td>—</td><td>—</td><td><i>Doctor &amp; timing to be confirmed</i></td></tr>`).join('')}
      </tbody></table>
      ${d.clashes.length ? `<p class="small"><b>Clash:</b> ${d.clashes.map((c) =>
    `${UI.esc(c.room)} has ${UI.esc(c.doctors.join(' and '))} ${UI.esc(c.from)}–${UI.esc(c.to)}`)
    .join('; ')}.</p>` : ''}
      <div class="foot-note">Specialities awaiting a doctor are shown as to be confirmed — names and
        timings are updated here as they are finalised.</div>
    </div>`;

    UI.print(days.map(page).join(''), 'Duty chart');
  }
}());
