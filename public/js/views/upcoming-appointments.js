/* Upcoming Appointment List view — filtered and categorized based on the service list. */
(function () {
  'use strict';

  APP.register('upcoming-appointments', {
    title: 'Upcoming Appointment List',
    subtitle: 'Upcoming bookings based on the clinic service list',

    async render(el, params) {
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
          label: '📅 Day Schedule',
          kind: 'ghost',
          onClick: () => APP.navigate('appointments'),
        },
      ]);

      el.innerHTML = `
        <div class="tabs mb">
          <button type="button" id="tab-dayview">📅 Day Schedule</button>
          <button type="button" class="active" id="tab-upcoming">◷ Upcoming Appointment List</button>
        </div>

        <div id="ua-stats" class="grid c4 mb">
          <div class="stat teal"><div class="label">Upcoming Total</div><div class="value">—</div><div class="foot">Scheduled bookings ahead</div></div>
          <div class="stat crimson"><div class="label">Today</div><div class="value">—</div><div class="foot">Upcoming for today</div></div>
          <div class="stat ok"><div class="label">Next 7 Days</div><div class="value">—</div><div class="foot">This week's schedule</div></div>
          <div class="stat orange"><div class="label">Service Filter</div><div class="value" style="font-size:16px;line-height:28px">All Services</div><div class="foot">Based on service catalogue</div></div>
        </div>

        <div class="card mb">
          <div class="card-body">
            <div class="row-between" style="flex-wrap:wrap;gap:12px">
              <div class="search-row" style="flex:1;min-width:260px;margin:0">
                <input type="search" id="ua-q" placeholder="Search patient name, phone, UHID or ref…">
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                <select id="ua-service" style="max-width:240px">
                  <option value="">All Services (from Service List)</option>
                </select>
                <select id="ua-dept" style="max-width:180px">
                  <option value="">All Departments</option>
                </select>
                <select id="ua-days" style="max-width:150px">
                  <option value="7" selected>Next 7 days</option>
                  <option value="14">Next 14 days</option>
                  <option value="30">Next 30 days</option>
                  <option value="1">Today only</option>
                  <option value="">All future</option>
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

        <div class="card">
          <div class="card-head">
            <h3>Upcoming Appointments</h3>
            <span class="muted small" id="ua-count">Loading…</span>
          </div>
          <div class="card-body tight" id="ua-list">${UI.loading()}</div>
        </div>
      `;

      el.querySelector('#tab-dayview').addEventListener('click', () => APP.navigate('appointments'));

      let cachedServices = [];
      let cachedDepts = [];

      const load = async () => {
        const host = el.querySelector('#ua-list');
        host.innerHTML = UI.loading();

        const sVal = el.querySelector('#ua-status').value;
        const qParams = {
          days: el.querySelector('#ua-days').value,
          serviceId: el.querySelector('#ua-service').value,
          departmentId: el.querySelector('#ua-dept').value,
          q: el.querySelector('#ua-q').value.trim(),
        };

        if (sVal === 'ALL') {
          qParams.allStatus = '1';
        } else if (sVal) {
          qParams.status = sVal;
        }

        try {
          const res = await API.get('/api/appointments/upcoming' + API.qs(qParams));

          // Populate services dropdown once
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

          // Populate departments dropdown once
          if (!cachedDepts.length && res.departments && res.departments.length) {
            cachedDepts = res.departments;
            const dSelect = el.querySelector('#ua-dept');
            dSelect.innerHTML = '<option value="">All Departments</option>' +
              res.departments.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
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
              <div class="foot">Bookings today (${UI.date(res.today)})</div>
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

          el.querySelector('#ua-count').textContent = `${res.rows.length} appointment(s) found`;

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

          // Wire row clicks for details
          UI.bindRows(host, res.rows, (a) => {
            if (window.Appointments && window.Appointments.openAppointment) {
              window.Appointments.openAppointment(a);
            }
          });

          // Wire quick confirm button
          host.querySelectorAll('[data-quick-confirm]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const id = btn.dataset.quickConfirm;
              await API.patch(`/api/appointments/${id}`, { status: 'confirmed' });
              UI.ok('Appointment confirmed.');
              load();
            });
          });

          // Wire quick checkin button
          host.querySelectorAll('[data-quick-checkin]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const id = Number(btn.dataset.quickCheckin);
              const appt = res.rows.find((r) => r.id === id);
              if (!appt) return;
              if (!appt.patient_id) {
                UI.err('Unregistered patient — please register them first from Patients.');
                APP.navigate('patients', { name: appt.guest_name, phone: appt.guest_phone });
                return;
              }
              try {
                await API.post('/api/visits/arrive', {
                  patientId: appt.patient_id,
                  doctorId: appt.doctor_id,
                  departmentId: appt.department_id,
                  appointmentId: appt.id,
                  reason: appt.reason || 'Appointment visit',
                });
                await API.patch(`/api/appointments/${id}`, { status: 'checked_in' });
                UI.ok('Patient checked in and queued for consultation.');
                load();
              } catch (err) {
                UI.err(err.message || 'Could not check in patient');
              }
            });
          });

          APP.setSubtitle(`${res.rows.length} upcoming booking(s) found`);
        } catch (err) {
          host.innerHTML = `<div class="alert danger">Error loading upcoming appointments: ${UI.esc(err.message)}</div>`;
        }
      };

      // Wire filter listeners
      el.querySelector('#ua-service').addEventListener('change', load);
      el.querySelector('#ua-dept').addEventListener('change', load);
      el.querySelector('#ua-days').addEventListener('change', load);
      el.querySelector('#ua-status').addEventListener('change', load);

      let searchTimer;
      el.querySelector('#ua-q').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(load, 250);
      });

      el.querySelector('#ua-reset').addEventListener('click', () => {
        el.querySelector('#ua-q').value = '';
        el.querySelector('#ua-service').value = '';
        el.querySelector('#ua-dept').value = '';
        el.querySelector('#ua-days').value = '7';
        el.querySelector('#ua-status').value = '';
        load();
      });

      await load();
    },
  });
})();
