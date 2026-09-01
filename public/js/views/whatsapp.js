/* WhatsApp desk: live conversations, the booking simulator, and the outbox. */
(function () {
  'use strict';

  const QUICK = ['Hi', 'MENU', '1', '2', '3', '4', '5', '6', '7', 'YES', 'NO', 'BOOK'];

  APP.register('whatsapp', {
    title: 'WhatsApp',
    subtitle: 'Patient conversations, appointment bot and outbox',

    async render(el) {
      const provider = APP.whatsappProvider;

      el.innerHTML = `
        ${provider === 'mock' ? `<div class="alert info">
          <b>Simulator mode.</b> No messages leave this machine — the bot below is exactly the one the
          Meta Cloud API webhook drives. Set <code>WHATSAPP_PROVIDER=meta</code> with your token and
          phone-number ID in <code>.env</code> to go live.</div>`
          : '<div class="alert ok"><b>Live.</b> Connected to the Meta WhatsApp Cloud API.</div>'}

        <div class="tabs" id="wa-tabs">
          <button class="active" data-tab="chat">Conversations</button>
          <button data-tab="sessions">Live bookings in progress</button>
          <button data-tab="outbox">Outbox</button>
          <button data-tab="guide">Setup guide</button>
        </div>
        <div id="wa-body"></div>`;

      const body = el.querySelector('#wa-body');
      const tabs = { chat: chatTab, sessions: sessionsTab, outbox: outboxTab, guide: guideTab };

      el.querySelectorAll('#wa-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#wa-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab](body);
      }));
      await chatTab(body);
    },
  });

  // ------------------------------------------------------------ conversations
  async function chatTab(body) {
    body.innerHTML = `<div class="card"><div class="card-body tight">
      <div class="wa-shell">
        <div class="wa-list" id="wa-list">${UI.loading()}</div>
        <div class="wa-thread">
          <div class="wa-msgs" id="wa-msgs">
            ${UI.empty('Pick a conversation, or start a new one below.', '💬')}
          </div>
          <div class="wa-quick" id="wa-quick"></div>
          <form class="wa-compose" id="wa-form">
            <input type="tel" id="wa-num" placeholder="Patient number, e.g. 919876500001" style="max-width:210px">
            <input type="text" id="wa-text" placeholder="Type as the patient…" autocomplete="off">
            <button class="btn" type="submit">Send</button>
          </form>
        </div>
      </div></div></div>
      <div class="muted small mt">This panel plays the <b>patient's</b> side of the chat so you can walk the whole
        booking flow. Type <code>Hi</code> to see the menu.</div>`;

    const numInput = body.querySelector('#wa-num');
    const textInput = body.querySelector('#wa-text');

    body.querySelector('#wa-quick').innerHTML = QUICK.map((q) =>
      `<button type="button" data-q="${UI.esc(q)}">${UI.esc(q)}</button>`).join('');
    body.querySelectorAll('#wa-quick button').forEach((b) => b.addEventListener('click', () => {
      textInput.value = b.dataset.q;
      body.querySelector('#wa-form').requestSubmit();
    }));

    const drawThread = (messages) => {
      const host = body.querySelector('#wa-msgs');
      host.innerHTML = messages.length ? messages.map((m) =>
        `<div class="wa-msg ${m.direction === 'in' ? 'in' : 'out'}">${UI.waText(m.body)}
          <span class="t">${UI.esc(UI.time(m.created_at))}${m.direction === 'out' ? ' ✓' : ''}</span></div>`).join('')
        : UI.empty('No messages yet — say hello.', '💬');
      host.scrollTop = host.scrollHeight;
    };

    const loadList = async (active) => {
      const list = await API.get('/api/whatsapp/conversations');
      body.querySelector('#wa-list').innerHTML = list.length ? list.map((c) => `
        <div class="item ${c.wa_number === active ? 'active' : ''}" data-num="${UI.esc(c.wa_number)}">
          <b>${UI.esc(c.patient_name || c.wa_number)}</b>
          <span>${UI.esc(c.wa_number)} · ${UI.esc(c.messages)} msg · ${UI.esc(UI.ago(c.last_at))}</span>
        </div>`).join('') : '<div class="empty small">No conversations yet.</div>';
      body.querySelectorAll('#wa-list .item').forEach((i) => i.addEventListener('click', async () => {
        numInput.value = i.dataset.num;
        const conv = await API.get(`/api/whatsapp/conversations/${i.dataset.num}`);
        drawThread(conv.messages);
        loadList(i.dataset.num);
      }));
    };

    body.querySelector('#wa-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const from = numInput.value.trim();
      const text = textInput.value.trim();
      if (!from) return UI.err('Enter the patient number first.');
      if (!text) return;
      textInput.value = '';
      try {
        const res = await API.post('/api/whatsapp/simulate', { from, text });
        drawThread(res.conversation);
        loadList(from);
        APP.refreshBadges();
      } catch (err) { UI.err(err.message); }
    });

    await loadList();
  }

  // ------------------------------------------------------------- live sessions
  async function sessionsTab(body) {
    const rows = await API.get('/api/whatsapp/sessions');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Bookings in progress</h3>
        <span class="muted small">Patients part-way through the bot conversation</span></div>
      <div class="card-body tight" id="s-list"></div></div>`;
    const host = body.querySelector('#s-list');
    host.innerHTML = UI.table([
      { label: 'Number', render: (s) => `<code>${UI.esc(s.wa_number)}</code>` },
      { label: 'Patient', render: (s) => UI.esc(s.patient_name || 'Not registered') },
      { label: 'Step', render: (s) => UI.badge(UI.titleise(s.state), 'teal') },
      { label: 'Last message', render: (s) => UI.esc(UI.ago(s.last_message_at)) },
      { label: '', render: (s) => `<button class="btn ghost sm" data-reset="${UI.esc(s.wa_number)}">Reset to menu</button>` },
    ], rows, { emptyText: 'No conversation is mid-booking right now.' });
    host.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      await API.post(`/api/whatsapp/conversations/${b.dataset.reset}/reset`);
      UI.ok('Conversation reset to the main menu.');
      sessionsTab(body);
    }));
  }

  // -------------------------------------------------------------------- outbox
  async function outboxTab(body) {
    const rows = await API.get('/api/whatsapp/outbox');
    const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    body.innerHTML = `
      <div class="grid c3 mb">
        <div class="stat ok"><div class="label">Sent</div><div class="value">${UI.num(counts.sent || 0)}</div></div>
        <div class="stat orange"><div class="label">Queued</div><div class="value">${UI.num(counts.queued || 0)}</div>
          <div class="foot">Includes scheduled reminders</div></div>
        <div class="stat crimson"><div class="label">Failed</div><div class="value">${UI.num(counts.failed || 0)}</div></div>
      </div>
      <div class="card"><div class="card-head"><h3>Outbound messages</h3>
        <button class="btn ghost sm" id="dispatch">Send queued now</button></div>
        <div class="card-body tight" id="o-list"></div></div>`;

    body.querySelector('#dispatch').addEventListener('click', async () => {
      const r = await API.post('/api/whatsapp/outbox/dispatch');
      UI.ok(`${r.sent} sent, ${r.failed} failed.`);
      outboxTab(body);
    });

    const host = body.querySelector('#o-list');
    host.innerHTML = UI.table([
      { label: 'To', render: (r) => `<code>${UI.esc(r.to_addr)}</code>` },
      { label: 'Template', render: (r) => UI.badge(UI.titleise(r.template || 'custom'), 'teal') },
      { label: 'Message', render: (r) => `<div class="small">${UI.esc((r.body || '').slice(0, 90))}…</div>` },
      { label: 'Scheduled', render: (r) => UI.esc(UI.dateTime(r.scheduled_at)) },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) +
        (r.error ? `<div class="muted small">${UI.esc(r.error)}</div>` : '') },
      { label: '', render: (r) => r.status === 'failed'
        ? `<button class="btn ghost sm" data-retry="${r.id}">Retry</button>` : '' },
    ], rows, { emptyText: 'Nothing in the outbox.' });
    host.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      await API.post(`/api/whatsapp/outbox/${b.dataset.retry}/retry`);
      UI.ok('Retried.');
      outboxTab(body);
    }));
  }

  // --------------------------------------------------------------- setup guide
  function guideTab(body) {
    body.innerHTML = `<div class="card"><div class="card-body">
      <h3 class="mb">Connecting a real WhatsApp number</h3>
      <p>The ERP speaks the <b>Meta WhatsApp Cloud API</b>. Everything below is free to set up; you pay Meta
         per conversation once you are live.</p>

      <fieldset><legend>1 · Create the app</legend>
        <ol>
          <li>Create a Meta Business account and a <b>Business</b> app at <code>developers.facebook.com</code>.</li>
          <li>Add the <b>WhatsApp</b> product and register the clinic's phone number.</li>
          <li>Copy the <b>Phone number ID</b> and generate a permanent <b>System user access token</b>.</li>
        </ol>
      </fieldset>

      <fieldset><legend>2 · Point the webhook here</legend>
        <p>Callback URL: <code>https://your-domain/api/whatsapp/webhook</code></p>
        <p>Verify token: whatever you set as <code>WHATSAPP_VERIFY_TOKEN</code>.</p>
        <p>Subscribe to the <code>messages</code> field. Meta calls the URL with a challenge — the ERP answers it
           automatically.</p>
      </fieldset>

      <fieldset><legend>3 · Set the environment</legend>
        <pre class="mono small" style="background:var(--line-2);padding:12px;border-radius:8px;overflow-x:auto">WHATSAPP_PROVIDER=meta
WHATSAPP_TOKEN=EAAG...your-permanent-token
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=samiha-verify-token</pre>
        <p class="muted small">Restart the server. The banner at the top of this page will turn green.</p>
      </fieldset>

      <fieldset><legend>What the patient can do in chat</legend>
        <div class="grid c2">
          <div>
            <p><b>Book an appointment</b> — department → doctor → day → time → reason → confirm.
               A confirmed appointment, a token number and an enquiry record are all created.</p>
            <p><b>My appointments</b> — lists upcoming bookings with reference numbers.</p>
            <p><b>Cancel</b> — <code>CANCEL APT2509001</code> from any point in the conversation.</p>
            <p><b>Confirm</b> — <code>CONFIRM APT2509001</code>, usually in reply to the reminder.</p>
          </div>
          <div>
            <p><b>Report status</b> — where their diagnostics have reached.</p>
            <p><b>Refill request</b> — logs an enquiry for the pharmacist.</p>
            <p><b>Clinic timings</b> — OPD, diagnostics and pharmacy hours.</p>
            <p><b>Talk to the front desk</b> — raises a call-back enquiry.</p>
          </div>
        </div>
      </fieldset>

      <fieldset><legend>What the clinic sends automatically</legend>
        <p>Appointment confirmation · reminder the evening before · cancellation · check-in with token ·
           diagnostic report ready · pharmacy ready · payment receipt · payment-plan schedule · visit summary ·
           admission confirmation · discharge summary · financial-assistance outcome.</p>
        <p class="muted small">All of them are queued in the outbox and retried if a send fails.</p>
      </fieldset>
    </div></div>`;
  }
})();
