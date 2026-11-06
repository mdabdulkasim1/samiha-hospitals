(function () {
  'use strict';
  /**
   * How a bill leaves the counter.
   *
   * It used to leave one way: out of the printer. Most of those sheets are
   * read once on the way to the gate and never again, so the press that used
   * to print now asks first — paper, or the patient's own phone.
   *
   * The number is typed rather than assumed. The one on file is offered,
   * because it usually is the right one, but a patient at a counter very
   * often wants the bill on a son's or a daughter's phone and the number on
   * the record may be a landline the clinic rang once.
   *
   * Whatever happens is said plainly. WhatsApp refuses a free-form message to
   * anybody who has not written to the clinic in the last 24 hours, and that
   * refusal has to reach the cashier while the patient is still standing
   * there and paper is still an option — not later, and not as silence.
   */

  const ENDPOINT = {
    invoice: (id) => `/api/billing/invoices/${id}`,
    pharmacy_sale: (id) => `/api/pharmacy/sales/${id}`,
  };

  /*
   * Who may send one.
   *
   * The ward reads a bill before a discharge and the nurse's station can see
   * what the pharmacy billed, but neither sends it to a patient — that is the
   * counter that took the money. They still get the paper button; the server
   * enforces this either way, and being told up front beats pressing send and
   * being refused in front of the patient.
   */
  const MAY_SEND = {
    invoice: ['owner', 'admin', 'cashier', 'counselor'],
    pharmacy_sale: ['owner', 'admin', 'pharmacy', 'cashier'],
  };
  const maySend = (kind) => Boolean(window.APP && APP.user && MAY_SEND[kind].includes(APP.user.role));

  /** Ten digits is what a counter types; the country code is added for them. */
  function dial(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    if (digits.length >= 11 && digits.length <= 15) return digits;
    return null;
  }

  /** The number as a person reads it back: +91 98765 43210. */
  function pretty(value) {
    const d = dial(value);
    if (!d) return String(value || '');
    if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
    return `+${d}`;
  }

  /**
   * Ask how the bill should go out.
   *
   * `print` is called when the counter chooses paper. It is called straight
   * from the click so the print window is opened while the browser can still
   * see the gesture that asked for it — a window claimed after an await is
   * silently blocked.
   */
  function open({ kind, id, docNo, patientName, suggested, print }) {
    const base = ENDPOINT[kind];
    if (!base) return UI.err('That document cannot be sent.');

    const number = suggested ? String(suggested).replace(/\D/g, '') : '';
    const allowed = maySend(kind);
    let sending = false;

    UI.modal({
      title: `Bill ${docNo || ''}`.trim(),
      size: 'narrow',
      body: `
        <p class="muted" style="margin-top:0">
          ${patientName ? `For <b>${UI.esc(patientName)}</b>. ` : ''}${allowed
    ? 'Print it, or send it to a WhatsApp number as a PDF — the patient keeps the bill and '
                    + 'the clinic keeps the paper.'
    : 'Print it. Sending a bill to a patient is the counter\u2019s to do, not this desk\u2019s.'}
        </p>
        <div class="mt"${allowed ? '' : ' hidden'}>
          ${UI.field({
            name: 'to', label: 'WhatsApp number', type: 'tel',
            value: number ? (number.length === 12 && number.startsWith('91') ? number.slice(2) : number) : '',
            placeholder: '98765 43210',
            hint: number
              ? 'The number on the patient record. Change it to send the bill somewhere else.'
              : 'Ten digits, or with the country code for a number outside India.',
          })}
        </div>
        <div id="bd-result"></div>`,
      footer: `<button class="btn ghost" data-act="print">Print it</button>
               ${allowed ? '<button class="btn teal" data-act="send">Send on WhatsApp</button>' : ''}
               <button class="btn ghost" data-act="__close">Close</button>`,
      onAction: async (act, modal, btn) => {
        if (act === 'print') {
          // Claimed on the click, before anything is fetched.
          if (print) print(UI.openPrintWindow());
          return 'keep';
        }
        if (act === 'copy') {
          try {
            await navigator.clipboard.writeText(btn.dataset.url);
            UI.ok('Link copied.');
          } catch { UI.warn('Copy it from the address shown beside it.'); }
          return 'keep';
        }
        if (act !== 'send' || sending) return 'keep';

        const field = modal.querySelector('[name=to]');
        const to = dial(field && field.value);
        const result = modal.querySelector('#bd-result');
        if (!to) {
          result.innerHTML = '<div class="alert danger mt">That is not a mobile number. '
            + 'Ten digits, or with the country code.</div>';
          return 'keep';
        }

        sending = true;
        result.innerHTML = `<div class="alert info mt">Sending the bill to ${UI.esc(pretty(to))}…</div>`;
        try {
          const res = await API.post(`${base(id)}/whatsapp`, { to });
          result.innerHTML = res.sent
            ? `<div class="alert ok mt"><b>Sent to ${UI.esc(pretty(res.to))}.</b>
                 ${UI.esc(res.filename)} — the link works for 90 days.
                 ${res.provider === 'mock'
    ? '<br><span class="muted">WhatsApp is in demo mode on this system, so nothing left the '
                      + 'building. The message is in WhatsApp → Conversations.</span>'
    : ''}
                 <div class="mt"><a href="${UI.esc(res.url)}" target="_blank" rel="noopener">Open the bill</a>
                 · <button class="btn ghost sm" data-act="copy" data-url="${UI.esc(res.url)}">Copy the link</button></div>
               </div>`
            : `<div class="alert danger mt"><b>WhatsApp would not take it.</b>
                 ${UI.esc(res.error || 'No reason given.')}
                 <br>This is usually because the patient has not messaged the clinic in the last
                 24 hours, which WhatsApp does not allow a business to write into. Print the bill,
                 or read them the link:
                 <div class="mt"><a href="${UI.esc(res.url)}" target="_blank" rel="noopener">${UI.esc(res.url)}</a></div>
               </div>`;
          if (res.sent) UI.ok(`Bill sent to ${pretty(res.to)}.`);
        } catch (err) {
          result.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
        } finally {
          sending = false;
        }
        return 'keep';
      },
    });
  }

  window.BillDelivery = { open, dial, pretty };
})();
