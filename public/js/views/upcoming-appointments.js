/* Upcoming Appointment List view with List View, Weekly Diary View, and Monthly Diary View
 * Categorized and filtered based on the clinic's Service List.
 */
(function () {
  'use strict';

  // Helper date math utilities
  function formatYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseYMD(str) {
    if (!str) return new Date();
    const parts = String(str).slice(0, 10).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    date.setDate(date.getDate() + diff);
    return date;
  }

  function getWeekDays(mondayDate) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mondayDate);
      d.setDate(mondayDate.getDate() + i);
      days.push(formatYMD(d));
    }
    return days;
  }

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  APP.register('upcoming-appointments', {
    title: 'Upcoming Appointment List',
    subtitle: 'Upcoming bookings and appointment diary based on the service list',

    async render(el, params) {
      const currentToday = formatYMD(new Date());

      // Active view: 'list' | 'weekly' | 'monthly'
      let activeView = params.view || 'list';
      if (!['list', 'weekly', 'monthly'].includes(activeView)) activeView = 'list';

      // Current anchor dates for weekly & monthly navigation
      let currentWeekMonday = getMonday(parseYMD(params.date || currentToday));
      let currentMonthYear = parseYMD(params.date || currentToday).getFullYear();
      let currentMonthIndex = parseYMD(params.date || currentToday).getMonth(); // 0-indexed

      APP.actions([
        {
          id: 'new',
          label: '+ Book appointment',
          kind: 'teal',
          onClick: () => {
            if (window.Appointments && window.Appointments.openBooking) {
              window.Appointments.openBooking(params);
            }
          },
        },
        {
          id: 'dayview',
          label: '📅 Day View',
          kind: 'ghost',
          onClick: () => APP.navigate('appointments'),
        },
      ]);

      el.innerHTML = `
        <style>
          .diary-nav-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
          .diary-title { font-size:18px; font-weight:700; color:var(--ink); display:flex; align-items:center; gap:8px; }
          
          /* Weekly Grid */
          .week-grid { display:grid; grid-template-columns: repeat(7, minmax(170px, 1fr)); gap:10px; overflow-x:auto; padding-bottom:10px; }
          .week-col { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); display:flex; flex-direction:column; min-height:480px; }
          .week-col.is-today { border-color:var(--teal); box-shadow:0 0 0 1px var(--teal); }
          .week-col-head { padding:10px; border-bottom:1px solid var(--line); background:var(--bg); border-top-left-radius:var(--radius); border-top-right-radius:var(--radius); }
          .week-col.is-today .week-col-head { background:var(--teal-soft); }
          .week-col-head .day-name { font-weight:700; font-size:13px; color:var(--ink); }
          .week-col-head .day-date { font-size:12px; color:var(--ink-3); }
          .week-col-body { padding:8px; display:flex; flex-direction:column; gap:8px; flex:1; overflow-y:auto; max-height:650px; }
          
          /* Appointment Card in Diary */
          .diary-card { background:#fff; border:1px solid var(--line); border-radius:var(--radius-s); padding:8px; cursor:pointer; transition:transform .15s, box-shadow .15s, border-color .15s; position:relative; }
          .diary-card:hover { transform:translateY(-2px); box-shadow:var(--shadow); border-color:var(--teal); }
          .diary-card.status-confirmed { border-left:4px solid var(--ok); }
          .diary-card.status-booked { border-left:4px solid var(--teal); }
          .diary-card.status-checked_in { border-left:4px solid var(--orange); }
          .diary-card.status-cancelled { border-left:4px solid var(--danger); opacity:.6; }
          .diary-card-head { display:flex; align-items:center; justify-content:space-between; gap:4px; margin-bottom:4px; }
          .diary-card-time { font-weight:700; font-size:12px; color:var(--ink); }
          .diary-card-patient { font-weight:600; font-size:13px; color:var(--ink); margin-bottom:3px; line-height:1.3; }
          .diary-card-service { display:inline-block; font-size:11px; padding:2px 6px; border-radius:4px; background:var(--teal-soft); color:var(--teal-dark); font-weight:600; margin-bottom:3px; }
          .diary-card-doc { font-size:11px; color:var(--ink-3); }

          /* Monthly Calendar Grid */
          .month-grid { display:grid; grid-template-columns: repeat(7, 1fr); gap:6px; }
          .month-head-cell { text-align:center; padding:8px 4px; font-weight:700; font-size:13px; color:var(--ink-2); background:var(--bg); border-radius:var(--radius-s); }
          .month-cell { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius-s); min-height:115px; padding:6px; display:flex; flex-direction:column; transition:border-color .15s, background .15s; cursor:pointer; }
          .month-cell:hover { border-color:var(--teal); background:#FAFDFE; }
          .month-cell.not-month { background:#FAFCFC; opacity:.55; }
          .month-cell.is-today { border-color:var(--teal); box-shadow:0 0 0 1px var(--teal); background:var(--teal-soft); }
          .month-cell-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
          .month-day-num { font-weight:700; font-size:13px; color:var(--ink); }
          .month-cell-appts { display:flex; flex-direction:column; gap:3px; flex:1; overflow:hidden; }
          .month-chip { font-size:11px; padding:2px 5px; border-radius:3px; background:#fff; border:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .month-chip.status-confirmed { border-left:3px solid var(--ok); }
          .month-chip.status-booked { border-left:3px solid var(--teal); }
        </style>

        <div class="tabs mb">
          <button type="button" class="${activeView === 'list' ? 'active' : ''}" data-view="list">📋 List View</button>
          <button type="button" class="${activeView === 'weekly' ? 'active' : ''}" data-view="weekly">📅 Weekly Diary</button>
          <button type="button" class="${activeView === 'monthly' ? 'active' : ''}" data-view="monthly">📆 Monthly Diary</button>
        </div>

        <div id="ua-stats" class="grid c4 mb">
          <div class="stat teal"><div class="label">Upcoming Total</div><div class="value">—</div><div class="foot">Active bookings ahead</div></div>
          <div class="stat crimson"><div class="label">Today</div><div class="value">—</div><div class="foot">Upcoming for today</div></div>
          <div class="stat ok"><div class="label">Next 7 Days</div><div class="value">—</div><div class="foot">This week's schedule</div></div>
          <div class="stat orange"><div class="label">Service Filter</div><div class="value" style="font-size:16px;line-height:28px">All Services</div><div class="foot">Based on service catalogue</div></div>
        </div>

        <!-- Filter Bar -->
        <div class="card mb">
          <div class="card-body">
            <div class="row-between" style="flex-wrap:wrap;gap:12px">
              <div class="search-row" style="flex:1;min-width:240px;margin:0">
                <input type="search" id="ua-q" placeholder="Search patient name, phone, UHID or ref…">
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                <select id="ua-service" style="max-width:230px" title="Filter based on the Service List">
                  <option value="">All Services (from Service List)</option>
                </select>
                <select id="ua-dept" style="max-width:170px">
                  <option value="">All Departments</option>
                </select>
                <select id="ua-doctor" style="max-width:170px">
                  <option value="">All Doctors</option>
                </select>
                <select id="ua-status" style="max-width:160px">
                  <option value="">Active (Booked &amp; Confirmed)</option>
                  <option value="booked">Booked only</option>
                  <option value="confirmed">Confirmed only</option>
                  <option value="checked_in">Checked in</option>
                  <option value="ALL">All (incl. cancelled)</option>
                </select>
                <button type="button" class="btn ghost sm" id="ua-reset">Reset</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Main View Container -->
        <div id="ua-view-container">
          ${UI.loading()}
        </div>
      `;

      let cachedServices = [];
      let cachedDepts = [];
      let cachedDoctors = [];

      // Wire Tab Mode Switchers
      el.querySelectorAll('.tabs [data-view]').forEach((tab) => {
        tab.addEventListener('click', () => {
          activeView = tab.dataset.view;
          el.querySelectorAll('.tabs [data-view]').forEach((t) => t.classList.toggle('active', t === tab));
          renderCurrentView();
        });
      });

      // Populate filters from API response
      function syncFilterDropdowns(res) {
        if (!cachedServices.length && res.services && res.services.length) {
          cachedServices = res.services;
          const sSelect = el.querySelector('#ua-service');
          const groups = {};
          for (const s of res.services) {
            const grp = s.bill_group || UI.titleise(s.category || 'Other Services');
            if (!groups[grp]) groups[grp] = [];
            groups[grp].push(s);
          }
          let sHtml = '<option value="">All Services (from Service List)</option>';
          for (const [grpName, items] of Object.entries(groups)) {
            sHtml += `<optgroup label="${UI.esc(grpName)}">` +
              items.map((i) => `<option value="${i.id}">${UI.esc(i.name)} (${UI.money(i.price)})</option>`).join('') +
              '</optgroup>';
          }
          sSelect.innerHTML = sHtml;
        }

        if (!cachedDepts.length && res.departments && res.departments.length) {
          cachedDepts = res.departments;
          const dSelect = el.querySelector('#ua-dept');
          dSelect.innerHTML = '<option value="">All Departments</option>' +
            res.departments.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
        }

        if (!cachedDoctors.length && res.doctors && res.doctors.length) {
          cachedDoctors = res.doctors;
          const docSelect = el.querySelector('#ua-doctor');
          docSelect.innerHTML = '<option value="">All Doctors</option>' +
            res.doctors.map((d) => `<option value="${d.id}">${UI.esc(d.name)} (${UI.esc(d.department_name || '')})</option>`).join('');
        }

        // Update stats
        const sum = res.summary || {};
        const selectedServiceId = el.querySelector('#ua-service').value;
        const selectedServiceObj = cachedServices.find((s) => String(s.id) === selectedServiceId);
        const serviceTitle = selectedServiceObj ? selectedServiceObj.name : 'All Services';

        el.querySelector('#ua-stats').innerHTML = `
          <div class="stat teal">
            <div class="label">Upcoming Total</div>
            <div class="value">${UI.num(sum.total || 0)}</div>
            <div class="foot">Active bookings ahead</div>
          </div>
          <div class="stat crimson">
            <div class="label">Today</div>
            <div class="value">${UI.num(sum.today || 0)}</div>
            <div class="foot">Bookings today (${UI.date(res.today || currentToday)})</div>
          </div>
          <div class="stat ok">
            <div class="label">Next 7 Days</div>
            <div class="value">${UI.num(sum.thisWeek || 0)}</div>
            <div class="foot">Upcoming this week</div>
          </div>
          <div class="stat orange">
            <div class="label">Service Focus</div>
            <div class="value" style="font-size:16px;line-height:28px" title="${UI.esc(serviceTitle)}">${UI.esc(serviceTitle)}</div>
            <div class="foot">${selectedServiceObj ? UI.money(selectedServiceObj.price) : 'Showing all services'}</div>
          </div>
        `;
      }

      function getCommonQueryParams() {
        const sVal = el.querySelector('#ua-status').value;
        const qParams = {
          serviceId: el.querySelector('#ua-service').value,
          departmentId: el.querySelector('#ua-dept').value,
          doctorId: el.querySelector('#ua-doctor').value,
          q: el.querySelector('#ua-q').value.trim(),
        };
        if (sVal === 'ALL') qParams.allStatus = '1';
        else if (sVal) qParams.status = sVal;
        return qParams;
      }

      // =========================================================================
      // 1. LIST VIEW
      // =========================================================================
      async function renderListView() {
        const container = el.querySelector('#ua-view-container');
        container.innerHTML = `
          <div class="card">
            <div class="card-head">
              <h3>Upcoming Appointments (List View)</h3>
              <span class="muted small" id="ua-list-count">Loading…</span>
            </div>
            <div class="card-body tight" id="ua-table-host">${UI.loading()}</div>
          </div>
        `;

        const qParams = {
          ...getCommonQueryParams(),
          days: 30, // next 30 days default for list
        };

        const res = await API.get('/api/appointments/upcoming' + API.qs(qParams));
        syncFilterDropdowns(res);

        el.querySelector('#ua-list-count').textContent = `${res.rows.length} appointment(s) found`;
        const host = el.querySelector('#ua-table-host');

        host.innerHTML = UI.table([
          {
            label: 'When',
            render: (a) => `<b>${UI.esc(UI.date(a.scheduled_at))}</b><div class="muted small">${UI.esc(UI.time(a.scheduled_at))}</div>`,
          },
          {
            label: 'Token',
            render: (a) => `<span class="badge crimson">#${UI.esc(a.token_no || '—')}</span>`,
          },
          {
            label: 'Ref',
            render: (a) => `<code>${UI.esc(a.appt_no)}</code>`,
          },
          {
            label: 'Patient',
            render: (a) => `<b>${UI.esc(a.display_name)}</b>` +
              `<div class="muted small">${UI.esc(a.uhid || 'Not registered')} · ${UI.esc(a.patient_phone || a.guest_phone || '—')}</div>`,
          },
          {
            label: 'Service (Service List)',
            render: (a) => `<span class="badge teal">${UI.esc(a.service_label || a.service_name || 'Consultation')}</span>` +
              (a.service_price ? `<div class="muted small">${UI.money(a.service_price)}</div>` : ''),
          },
          {
            label: 'Doctor / Dept',
            render: (a) => `${UI.esc(a.doctor_name || '—')}<div class="muted small">${UI.esc(a.department_name || '')}</div>`,
          },
          {
            label: 'Source',
            render: (a) => UI.badge(UI.titleise(a.source), a.source === 'whatsapp' ? 'wa' : 'info'),
          },
          {
            label: 'Status',
            render: (a) => UI.statusBadge(a.status),
          },
          {
            label: '',
            render: (a) => {
              let btns = '';
              if (a.status === 'booked') {
                btns += `<button class="btn sm ghost" data-quick-confirm="${a.id}">Confirm</button> `;
              }
              if (['booked', 'confirmed'].includes(a.status) && !a.visit_id) {
                btns += `<button class="btn sm teal" data-quick-checkin="${a.id}">Check in</button>`;
              }
              return btns;
            },
          },
        ], res.rows, { emptyText: 'No upcoming appointments matched the selected service or date filter.' });

        UI.bindRows(host, res.rows, (a) => {
          if (window.Appointments && window.Appointments.openAppointment) {
            window.Appointments.openAppointment(a);
          }
        });

        wireQuickActionButtons(host, renderListView, res.rows);
      }

      // =========================================================================
      // 2. WEEKLY DIARY VIEW
      // =========================================================================
      async function renderWeeklyDiaryView() {
        const container = el.querySelector('#ua-view-container');
        const weekDays = getWeekDays(currentWeekMonday);
        const fromDate = weekDays[0];
        const toDate = weekDays[6];

        const monLabel = UI.date(fromDate);
        const sunLabel = UI.date(toDate);

        container.innerHTML = `
          <div class="card mb">
            <div class="card-body">
              <div class="diary-nav-bar">
                <div class="btn-row">
                  <button type="button" class="btn ghost sm" id="week-prev">← Previous Week</button>
                  <button type="button" class="btn ghost sm" id="week-current">This Week</button>
                  <button type="button" class="btn ghost sm" id="week-next">Next Week →</button>
                </div>
                <div class="diary-title">
                  <span>📅 Week: <b>${monLabel}</b> – <b>${sunLabel}</b></span>
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="muted small">Jump to date:</span>
                  <input type="date" id="week-picker" value="${fromDate}" style="max-width:150px">
                </div>
              </div>
            </div>
          </div>

          <div id="week-grid-host">${UI.loading()}</div>
        `;

        // Wire navigation
        el.querySelector('#week-prev').addEventListener('click', () => {
          currentWeekMonday.setDate(currentWeekMonday.getDate() - 7);
          renderWeeklyDiaryView();
        });
        el.querySelector('#week-next').addEventListener('click', () => {
          currentWeekMonday.setDate(currentWeekMonday.getDate() + 7);
          renderWeeklyDiaryView();
        });
        el.querySelector('#week-current').addEventListener('click', () => {
          currentWeekMonday = getMonday(new Date());
          renderWeeklyDiaryView();
        });
        el.querySelector('#week-picker').addEventListener('change', (e) => {
          currentWeekMonday = getMonday(parseYMD(e.target.value));
          renderWeeklyDiaryView();
        });

        // Query appointments for this week
        const qParams = {
          ...getCommonQueryParams(),
          fromDate,
          toDate,
          diary: '1',
          allStatus: el.querySelector('#ua-status').value === 'ALL' ? '1' : undefined,
        };

        const res = await API.get('/api/appointments/upcoming' + API.qs(qParams));
        syncFilterDropdowns(res);

        // Group appointments by date (YYYY-MM-DD)
        const apptsByDate = {};
        for (const d of weekDays) apptsByDate[d] = [];
        for (const a of res.rows) {
          const dKey = (a.scheduled_at || '').slice(0, 10);
          if (apptsByDate[dKey]) apptsByDate[dKey].push(a);
        }

        const gridHost = el.querySelector('#week-grid-host');
        gridHost.innerHTML = `
          <div class="week-grid">
            ${weekDays.map((dateKey, idx) => {
              const dayAppts = apptsByDate[dateKey] || [];
              const isToday = dateKey === currentToday;
              const dObj = parseYMD(dateKey);
              const dayTitle = DAY_NAMES[idx];
              const dateText = `${dObj.getDate()} ${MONTH_NAMES[dObj.getMonth()].slice(0, 3)}`;

              return `
                <div class="week-col ${isToday ? 'is-today' : ''}" data-col-date="${dateKey}">
                  <div class="week-col-head">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                      <span class="day-name">${dayTitle}</span>
                      <span class="badge ${isToday ? 'teal' : 'ghost'} sm">${dayAppts.length}</span>
                    </div>
                    <div class="day-date">${dateText} ${isToday ? '<b>(TODAY)</b>' : ''}</div>
                  </div>
                  <div class="week-col-body">
                    ${dayAppts.length ? dayAppts.map((a) => `
                      <div class="diary-card status-${a.status}" data-appt-id="${a.id}">
                        <div class="diary-card-head">
                          <span class="diary-card-time">${UI.esc(a.time || UI.time(a.scheduled_at))}</span>
                          <span class="badge crimson sm">#${UI.esc(a.token_no || '—')}</span>
                        </div>
                        <div class="diary-card-patient">${UI.esc(a.display_name)}</div>
                        <div class="diary-card-service" title="${UI.esc(a.service_name || '')}">${UI.esc(a.service_label || a.service_name || 'Consultation')}</div>
                        <div class="diary-card-doc">${UI.esc(a.doctor_name || '—')}${a.department_name ? ' · ' + UI.esc(a.department_name) : ''}</div>
                        <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center">
                          ${UI.statusBadge(a.status)}
                          <span class="muted small">${UI.esc(a.patient_phone || a.guest_phone || '')}</span>
                        </div>
                      </div>
                    `).join('') : '<div class="muted small" style="text-align:center;padding:30px 10px">No bookings</div>'}
                  </div>
                  <div style="padding:8px;border-top:1px solid var(--line);background:var(--bg)">
                    <button type="button" class="btn ghost sm block" data-quick-book="${dateKey}">+ Book</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;

        // Wire card clicks to open appointment modal
        gridHost.querySelectorAll('[data-appt-id]').forEach((card) => {
          card.addEventListener('click', () => {
            const id = Number(card.dataset.apptId);
            const appt = res.rows.find((r) => r.id === id);
            if (appt && window.Appointments && window.Appointments.openAppointment) {
              window.Appointments.openAppointment(appt);
            }
          });
        });

        // Wire quick book on date
        gridHost.querySelectorAll('[data-quick-book]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const date = btn.dataset.quickBook;
            if (window.Appointments && window.Appointments.openBooking) {
              window.Appointments.openBooking({ date });
            }
          });
        });
      }

      // =========================================================================
      // 3. MONTHLY DIARY VIEW
      // =========================================================================
      async function renderMonthlyDiaryView() {
        const container = el.querySelector('#ua-view-container');
        const monthStr = `${currentMonthYear}-${String(currentMonthIndex + 1).padStart(2, '0')}`;
        const monthTitle = `${MONTH_NAMES[currentMonthIndex]} ${currentMonthYear}`;

        container.innerHTML = `
          <div class="card mb">
            <div class="card-body">
              <div class="diary-nav-bar">
                <div class="btn-row">
                  <button type="button" class="btn ghost sm" id="month-prev">← Previous Month</button>
                  <button type="button" class="btn ghost sm" id="month-current">This Month</button>
                  <button type="button" class="btn ghost sm" id="month-next">Next Month →</button>
                </div>
                <div class="diary-title">
                  <span>📆 Month Diary: <b>${monthTitle}</b></span>
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="muted small">Jump to month:</span>
                  <input type="month" id="month-picker" value="${monthStr}" style="max-width:160px">
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-body tight" id="month-grid-host">${UI.loading()}</div>
          </div>
        `;

        // Wire navigation
        el.querySelector('#month-prev').addEventListener('click', () => {
          if (currentMonthIndex === 0) { currentMonthIndex = 11; currentMonthYear--; }
          else { currentMonthIndex--; }
          renderMonthlyDiaryView();
        });
        el.querySelector('#month-next').addEventListener('click', () => {
          if (currentMonthIndex === 11) { currentMonthIndex = 0; currentMonthYear++; }
          else { currentMonthIndex++; }
          renderMonthlyDiaryView();
        });
        el.querySelector('#month-current').addEventListener('click', () => {
          const now = new Date();
          currentMonthYear = now.getFullYear();
          currentMonthIndex = now.getMonth();
          renderMonthlyDiaryView();
        });
        el.querySelector('#month-picker').addEventListener('change', (e) => {
          if (!e.target.value) return;
          const [y, m] = e.target.value.split('-').map(Number);
          currentMonthYear = y;
          currentMonthIndex = m - 1;
          renderMonthlyDiaryView();
        });

        // Compute days grid for this month
        const firstDayOfWeek = new Date(currentMonthYear, currentMonthIndex, 1).getDay(); // 0 is Sun
        const leadCount = (firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1);
        const daysInMonth = new Date(currentMonthYear, currentMonthIndex + 1, 0).getDate();
        const prevMonthTotalDays = new Date(currentMonthYear, currentMonthIndex, 0).getDate();

        const cells = [];
        // Leading days from prev month
        for (let i = leadCount - 1; i >= 0; i--) {
          const d = prevMonthTotalDays - i;
          const prevM = currentMonthIndex === 0 ? 11 : currentMonthIndex - 1;
          const prevY = currentMonthIndex === 0 ? currentMonthYear - 1 : currentMonthYear;
          const key = `${prevY}-${String(prevM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          cells.push({ dayNumber: d, dateKey: key, isCurrentMonth: false });
        }
        // Days of current month
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${currentMonthYear}-${String(currentMonthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          cells.push({ dayNumber: d, dateKey: key, isCurrentMonth: true });
        }
        // Trailing days
        const remaining = (7 - (cells.length % 7)) % 7;
        for (let d = 1; d <= remaining; d++) {
          const nextM = currentMonthIndex === 11 ? 0 : currentMonthIndex + 1;
          const nextY = currentMonthIndex === 11 ? currentMonthYear + 1 : currentMonthYear;
          const key = `${nextY}-${String(nextM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          cells.push({ dayNumber: d, dateKey: key, isCurrentMonth: false });
        }

        // Query appointments for the full month range
        const fromDate = cells[0].dateKey;
        const toDate = cells[cells.length - 1].dateKey;

        const qParams = {
          ...getCommonQueryParams(),
          fromDate,
          toDate,
          diary: '1',
          allStatus: el.querySelector('#ua-status').value === 'ALL' ? '1' : undefined,
        };

        const res = await API.get('/api/appointments/upcoming' + API.qs(qParams));
        syncFilterDropdowns(res);

        // Group appointments by date
        const apptsByDate = {};
        for (const a of res.rows) {
          const dKey = (a.scheduled_at || '').slice(0, 10);
          if (!apptsByDate[dKey]) apptsByDate[dKey] = [];
          apptsByDate[dKey].push(a);
        }

        const gridHost = el.querySelector('#month-grid-host');
        gridHost.innerHTML = `
          <div style="padding:10px">
            <div class="month-grid mb">
              ${SHORT_DAYS.map((d) => `<div class="month-head-cell">${d}</div>`).join('')}
              ${cells.map((c) => {
                const dayAppts = apptsByDate[c.dateKey] || [];
                const isToday = c.dateKey === currentToday;
                const shownAppts = dayAppts.slice(0, 3);
                const extraCount = dayAppts.length - shownAppts.length;

                return `
                  <div class="month-cell ${c.isCurrentMonth ? '' : 'not-month'} ${isToday ? 'is-today' : ''}" data-day-cell="${c.dateKey}">
                    <div class="month-cell-top">
                      <span class="month-day-num">${c.dayNumber}</span>
                      ${isToday ? '<span class="badge teal sm">TODAY</span>' : ''}
                      ${dayAppts.length ? `<span class="badge crimson sm">${dayAppts.length}</span>` : ''}
                    </div>
                    <div class="month-cell-appts">
                      ${shownAppts.map((a) => `
                        <div class="month-chip status-${a.status}" title="${UI.esc(a.display_name)} · ${UI.esc(a.service_label || a.service_name || 'Consultation')}">
                          <b>${UI.esc(a.time || UI.time(a.scheduled_at))}</b> ${UI.esc(a.display_name.split(' ')[0])}
                          <span class="muted">· ${UI.esc((a.service_label || a.service_name || '').split(' ')[0])}</span>
                        </div>
                      `).join('')}
                      ${extraCount > 0 ? `<span class="muted small" style="font-weight:600">+${extraCount} more…</span>` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;

        // Wire clicking on a month cell to show that day's appointments in a modal
        gridHost.querySelectorAll('[data-day-cell]').forEach((cell) => {
          cell.addEventListener('click', () => {
            const dateKey = cell.dataset.dayCell;
            const dayAppts = apptsByDate[dateKey] || [];
            openDayDetailModal(dateKey, dayAppts, renderMonthlyDiaryView);
          });
        });
      }

      // Day detail modal when clicking a day in the monthly diary
      function openDayDetailModal(dateKey, appts, onDone) {
        UI.modal({
          title: `Appointments on ${UI.date(dateKey)}`,
          size: 'wide',
          body: `
            <div class="row-between mb" style="align-items:center">
              <div><b>${appts.length}</b> appointment(s) scheduled for this day.</div>
              <button type="button" class="btn teal sm" id="md-book-day">+ Book appointment on this day</button>
            </div>
            ${appts.length ? UI.table([
              { label: 'Time', render: (a) => `<b>${UI.esc(a.time || UI.time(a.scheduled_at))}</b>` },
              { label: 'Token', render: (a) => `<span class="badge crimson">#${UI.esc(a.token_no || '—')}</span>` },
              { label: 'Ref', render: (a) => `<code>${UI.esc(a.appt_no)}</code>` },
              { label: 'Patient', render: (a) => `<b>${UI.esc(a.display_name)}</b><div class="muted small">${UI.esc(a.patient_phone || a.guest_phone || '—')}</div>` },
              { label: 'Service', render: (a) => `<span class="badge teal">${UI.esc(a.service_label || a.service_name || 'Consultation')}</span>` },
              { label: 'Doctor', render: (a) => `${UI.esc(a.doctor_name || '—')}<div class="muted small">${UI.esc(a.department_name || '')}</div>` },
              { label: 'Status', render: (a) => UI.statusBadge(a.status) },
            ], appts) : '<div class="alert info">No appointments are scheduled for this day yet.</div>'}
          `,
          footer: '<button class="btn ghost" data-act="__close">Close</button>',
          onMount(m) {
            m.querySelector('#md-book-day').addEventListener('click', () => {
              UI.closeAllModals();
              if (window.Appointments && window.Appointments.openBooking) {
                window.Appointments.openBooking({ date: dateKey });
              }
            });
            UI.bindRows(m, appts, (a) => {
              UI.closeAllModals();
              if (window.Appointments && window.Appointments.openAppointment) {
                window.Appointments.openAppointment(a);
              }
            });
          },
        });
      }

      function wireQuickActionButtons(host, refreshFn, rows = []) {
        host.querySelectorAll('[data-quick-confirm]').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.quickConfirm;
            try {
              await API.patch(`/api/appointments/${id}`, { status: 'confirmed' });
              UI.ok('Appointment confirmed.');
              refreshFn();
            } catch (err) {
              UI.err(err.message || 'Could not confirm appointment');
            }
          });
        });

        host.querySelectorAll('[data-quick-checkin]').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.quickCheckin);
            try {
              let appt = (rows || []).find((r) => r.id === id);
              if (!appt) {
                const res = await API.get(`/api/appointments/${id}`);
                appt = res.row || res;
              }
              if (!appt.patient_id) {
                UI.err('Unregistered patient — please register them first from Patients.');
                APP.navigate('patients', { name: appt.guest_name, phone: appt.guest_phone });
                return;
              }
              const arriveRes = await API.post('/api/visits/arrive', {
                patientId: appt.patient_id,
                doctorId: appt.doctor_id,
                departmentId: appt.department_id,
                appointmentId: appt.id,
                reasonForVisit: appt.reason || 'Appointment visit',
              });
              if (arriveRes && arriveRes.queueToken) {
                UI.ok(`${appt.display_name || 'Patient'} checked in — token #${arriveRes.queueToken.label}.`);
                try { if (window.TokenSlip) await TokenSlip.printToken(arriveRes.queueToken.id); } catch (e) {}
              } else {
                UI.ok(`${appt.display_name || 'Patient'} checked in and added to waiting room.`);
              }
              refreshFn();
            } catch (err) {
              UI.err(err.message || 'Could not check in patient');
            }
          });
        });
      }

      function renderCurrentView() {
        if (activeView === 'weekly') {
          renderWeeklyDiaryView();
        } else if (activeView === 'monthly') {
          renderMonthlyDiaryView();
        } else {
          renderListView();
        }
      }

      // Wire filter listeners (re-runs whichever view is currently active)
      el.querySelector('#ua-service').addEventListener('change', renderCurrentView);
      el.querySelector('#ua-dept').addEventListener('change', renderCurrentView);
      el.querySelector('#ua-doctor').addEventListener('change', renderCurrentView);
      el.querySelector('#ua-status').addEventListener('change', renderCurrentView);

      let searchTimer;
      el.querySelector('#ua-q').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderCurrentView, 250);
      });

      el.querySelector('#ua-reset').addEventListener('click', () => {
        el.querySelector('#ua-q').value = '';
        el.querySelector('#ua-service').value = '';
        el.querySelector('#ua-dept').value = '';
        el.querySelector('#ua-doctor').value = '';
        el.querySelector('#ua-status').value = '';
        renderCurrentView();
      });

      renderCurrentView();
    },
  });
})();
