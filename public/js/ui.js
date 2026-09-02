/* Shared rendering helpers: escaping, formatting, modals, toasts, forms. */
(function () {
  'use strict';

  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function parse(value) {
    if (!value) return null;
    // SQLite datetimes come back as 'YYYY-MM-DD HH:MM:SS' (UTC).
    const s = String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  const UI = {
    esc,
    /** Tagged template that escapes every interpolation. Use `html` for markup. */
    tpl(strings, ...values) {
      return strings.reduce((out, s, i) => out + s + (i < values.length ? esc(values[i]) : ''), '');
    },
    money(v) {
      const n = Number(v || 0);
      return (window.APP && APP.clinic ? APP.clinic.currencySymbol : '₹') +
        n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    num(v, digits = 0) {
      return Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },
    date(value) {
      const d = parse(value);
      if (!d) return '—';
      return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    },
    dateShort(value) {
      const d = parse(value);
      return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : '—';
    },
    time(value) {
      const d = parse(value);
      if (!d) return '—';
      let h = d.getHours();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
    },
    dateTime(value) {
      const d = parse(value);
      return d ? `${DAYS[d.getDay()]}, ${UI.date(value)} · ${UI.time(value)}` : '—';
    },
    ago(value) {
      const d = parse(value);
      if (!d) return '—';
      const mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins} min ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs} hr ago`;
      return UI.date(value);
    },
    /** 'YYYY-MM-DD' for today, in local time. */
    today() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    /** '14:30' → '2:30 PM'. */
    to12h(hhmm) {
      const [h, m] = String(hhmm || '').split(':').map(Number);
      if (Number.isNaN(h)) return String(hhmm || '');
      const ampm = h >= 12 ? 'PM' : 'AM';
      return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
    },
    titleise(s) {
      return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    },

    // ------------------------------------------------------------- toasts
    toast(message, kind = '') {
      const host = document.getElementById('toasts');
      const el = document.createElement('div');
      el.className = 'toast ' + kind;
      el.textContent = message;
      host.appendChild(el);
      setTimeout(() => {
        el.style.transition = 'opacity .25s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 260);
      }, kind === 'err' ? 6500 : 3600);
    },
    ok: (m) => UI.toast(m, 'ok'),
    err: (m) => UI.toast(m, 'err'),
    warn: (m) => UI.toast(m, 'warn'),

    // ------------------------------------------------------------- modals
    /**
     * Open a modal. `render` returns HTML for the body; `footer` returns HTML
     * for the action row. Buttons are wired by `[data-act]`.
     */
    modal({ title, body, footer = '', size = '', onMount, onAction, onClose }) {
      const root = document.getElementById('modal-root');
      // Modals stack: a confirmation opened from inside a modal sits on top of
      // it, and dismissing the confirmation returns you to what you were doing.
      const holder = document.createElement('div');
      holder.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal ${size}" role="dialog" aria-modal="true">
            <header><h2>${esc(title)}</h2><button class="x" data-act="__close" aria-label="Close">×</button></header>
            <div class="body">${body}</div>
            ${footer ? `<footer>${footer}</footer>` : ''}
          </div>
        </div>`;

      // Listeners live on this modal's own backdrop, so they die with it —
      // binding them to #modal-root would leak handlers between modals.
      const backdrop = holder.firstElementChild;
      root.appendChild(backdrop);

      const onKey = (e) => { if (e.key === 'Escape' && UI._modals[UI._modals.length - 1] === close) close(); };
      const close = () => {
        document.removeEventListener('keydown', onKey);
        const i = UI._modals.indexOf(close);
        if (i !== -1) UI._modals.splice(i, 1);
        if (backdrop.isConnected) backdrop.remove();
        // Callers that wait on a modal's answer need to hear about a dismissal
        // as much as about a choice.
        if (onClose) onClose();
      };
      UI._modals.push(close);
      document.addEventListener('keydown', onKey);

      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      backdrop.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !backdrop.contains(btn)) return;
        const act = btn.dataset.act;
        if (act === '__close') return close();
        if (!onAction) return;
        btn.disabled = true;
        try {
          const keep = await onAction(act, backdrop.querySelector('.modal'), btn);
          if (keep !== 'keep') close();
        } catch (err) {
          UI.err(err.message);
        } finally {
          btn.disabled = false;
        }
      });

      const modalEl = backdrop.querySelector('.modal');
      if (onMount) onMount(modalEl);
      const focusable = modalEl.querySelector('.body input, .body select, .body textarea');
      if (focusable) focusable.focus();
      return { close, el: modalEl };
    },
    _modals: [],
    /** Close the top-most modal, returning to whatever is underneath. */
    closeModal() {
      const top = UI._modals[UI._modals.length - 1];
      if (top) top();
    },
    /** Close every open modal — used when navigating away. */
    closeAllModals() {
      while (UI._modals.length) UI._modals[UI._modals.length - 1]();
      document.getElementById('modal-root').innerHTML = '';
    },

    confirm(message, { title = 'Please confirm', danger = false } = {}) {
      return new Promise((resolve) => {
        UI.modal({
          title, size: 'narrow',
          body: `<p>${esc(message)}</p>`,
          footer: `<button class="btn ghost" data-act="__close">Cancel</button>
                   <button class="btn ${danger ? '' : 'teal'}" data-act="yes">Yes, continue</button>`,
          onAction: (act) => { resolve(act === 'yes'); },
        });
      });
    },

    // -------------------------------------------------------------- forms
    /** Collect a form's values into a plain object, by input name. */
    formValues(scope) {
      const out = {};
      scope.querySelectorAll('[name]').forEach((el) => {
        if (el.type === 'checkbox') out[el.name] = el.checked;
        else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
        else if (el.value !== '') out[el.name] = el.value;
      });
      return out;
    },
    field({ name, label, type = 'text', value = '', required = false, placeholder = '', options, rows, step, min, max, hint, disabled }) {
      const req = required ? ' <span class="req">*</span>' : '';
      let control;
      if (options) {
        control = `<select name="${esc(name)}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}>` +
          options.map((o) => {
            const val = o.value !== undefined ? o.value : o;
            const lab = o.label !== undefined ? o.label : o;
            const dis = o.disabled ? ' disabled' : '';
            const sel = !o.disabled && String(val) === String(value) ? ' selected' : '';
            return `<option value="${esc(val)}"${sel}${dis}>${esc(lab)}</option>`;
          }).join('') + '</select>';
      } else if (type === 'textarea' || rows) {
        // `rows` means nothing on an <input>, so asking for rows is asking for a
        // textarea — a radiologist typing findings should not get one line.
        control = `<textarea name="${esc(name)}" rows="${rows || 3}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>${esc(value)}</textarea>`;
      } else {
        control = `<input type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"` +
          `${required ? ' required' : ''}${disabled ? ' disabled' : ''}${step ? ` step="${esc(step)}"` : ''}` +
          `${min !== undefined ? ` min="${esc(min)}"` : ''}${max !== undefined ? ` max="${esc(max)}"` : ''}>`;
      }
      return `<label class="field"><span>${esc(label)}${req}</span>${control}` +
        (hint ? `<span class="muted small">${esc(hint)}</span>` : '') + '</label>';
    },
    /**
     * A password field with a show/hide eye. Mistyping a password you cannot
     * see is the most common cause of a "wrong" login, so every password input
     * in the app uses this.
     */
    password({ name, label, required = false, placeholder = '', autocomplete = 'current-password', hint, meter = false }) {
      const id = `pw-${name}-${Math.random().toString(36).slice(2, 8)}`;
      return `<label class="field" for="${id}">
        <span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span>
        <span class="pw-wrap">
          <input type="password" id="${id}" name="${esc(name)}" placeholder="${esc(placeholder)}"
                 autocomplete="${esc(autocomplete)}"${required ? ' required' : ''}
                 ${meter ? 'data-meter="1"' : ''}>
          <button type="button" class="pw-eye" data-eye="${id}"
                  aria-label="Show password" aria-pressed="false" tabindex="0">${UI.eyeIcon(false)}</button>
        </span>
        ${meter ? '<span class="pw-meter"><i></i></span><span class="pw-hint"></span>' : ''}
        ${hint ? `<span class="muted small">${esc(hint)}</span>` : ''}
      </label>`;
    },

    eyeIcon(shown) {
      return shown
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
             <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
             <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    },

    /** Wire every eye toggle and strength meter inside a container. */
    wirePasswords(scope) {
      scope.querySelectorAll('[data-eye]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          const input = scope.querySelector(`#${CSS.escape(btn.dataset.eye)}`);
          if (!input) return;
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          btn.innerHTML = UI.eyeIcon(show);
          btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
          btn.setAttribute('aria-pressed', String(show));
          // Keep the caret where the user left it.
          const pos = input.value.length;
          input.focus();
          try { input.setSelectionRange(pos, pos); } catch { /* type change can reset it */ }
        });
      });

      scope.querySelectorAll('input[data-meter]').forEach((input) => {
        if (input.dataset.wired) return;
        input.dataset.wired = '1';
        const field = input.closest('.field');
        const bar = field && field.querySelector('.pw-meter i');
        const hint = field && field.querySelector('.pw-hint');
        input.addEventListener('input', () => {
          const s = UI.passwordStrength(input.value);
          if (bar) { bar.style.width = s.pct + '%'; bar.style.background = s.colour; }
          if (hint) { hint.textContent = s.label; hint.className = 'pw-hint ' + s.cls; }
        });
      });
    },

    /** Mirrors the rules the server enforces, so the message matches. */
    passwordStrength(value) {
      const v = String(value || '');
      if (!v) return { pct: 0, colour: 'var(--line)', label: '', cls: '' };
      const problems = [];
      if (v.length < 8) problems.push('at least 8 characters');
      if (!/[A-Za-z]/.test(v)) problems.push('a letter');
      if (!/[0-9]/.test(v)) problems.push('a number');
      if (['password', '12345678', 'samiha@123', 'qwerty123', 'admin123', 'welcome1'].includes(v.toLowerCase())) {
        return { pct: 20, colour: 'var(--danger)', label: 'Too common — pick something else', cls: 'bad' };
      }
      if (problems.length) {
        return { pct: 30, colour: 'var(--danger)', label: 'Still needs ' + problems.join(', '), cls: 'bad' };
      }
      let score = 55;
      if (v.length >= 12) score += 20;
      if (/[^A-Za-z0-9]/.test(v)) score += 15;
      if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score += 10;
      const pct = Math.min(score, 100);
      return {
        pct,
        colour: pct >= 85 ? 'var(--ok)' : pct >= 70 ? 'var(--teal)' : 'var(--warn)',
        label: pct >= 85 ? 'Strong' : pct >= 70 ? 'Good' : 'Acceptable — longer would be better',
        cls: 'ok',
      };
    },

    checkbox({ name, label, checked = false }) {
      return `<label class="inline-check"><input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    },

    // ------------------------------------------------------------- pieces
    badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; },
    /**
     * Render WhatsApp's own markup (*bold*, _italic_, ~strike~, `code`) so the
     * staff panel shows what the patient actually sees. Escapes first, always.
     */
    waText(body) {
      return esc(body || '')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<b>$2</b>')
        .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<i>$2</i>')
        .replace(/(^|[\s(])~([^~\n]+)~(?=[\s.,!?)]|$)/g, '$1<s>$2</s>');
    },
    statusBadge(status) {
      const map = {
        waiting_room: 'warn', financial_screening: 'orange', checked_in: 'info', vitals_done: 'info',
        with_provider: 'teal', labs_pending: 'warn', pharmacy_pending: 'warn', billing_pending: 'warn',
        checked_out: 'ok', cancelled: '', booked: 'info', confirmed: 'teal', in_consult: 'teal',
        completed: 'ok', no_show: 'danger', paid: 'ok', unpaid: 'danger', partial: 'warn',
        written_off: '', draft: '', ordered: 'info', sample_collected: 'info', in_process: 'warn',
        result_entered: 'warn', verified: 'ok', reported: 'ok', admitted: 'teal', discharged: 'ok',
        new: 'info', contacted: 'warn', converted: 'ok', closed: '', lost: 'danger',
        awaiting_counselor: 'warn', with_counselor: 'info', docs_pending: 'orange', declined: 'danger',
        deferred: '', initiated: 'info', pending: 'warn', dispensed: 'ok', partially_dispensed: 'warn',
        active: 'teal', overdue: 'danger', due: 'warn', given: 'ok', missed: 'danger', held: 'warn',
        vacant: 'ok', occupied: 'danger', cleaning: 'warn', blocked: '',
      };
      return UI.badge(UI.titleise(status), map[status] || '');
    },
    empty(text, icon = '📋') {
      return `<div class="empty"><div class="big">${icon}</div><div>${esc(text)}</div></div>`;
    },
    loading() { return '<div class="loading"><span class="spinner"></span></div>'; },
    table(columns, rows, { onRow, emptyText = 'Nothing to show yet.' } = {}) {
      if (!rows || !rows.length) return UI.empty(emptyText);
      const head = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
      const body = rows.map((r, i) => {
        const cells = columns.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.render ? c.render(r, i) : esc(r[c.key])}</td>`).join('');
        return `<tr class="${onRow ? 'clickable' : ''}" data-row="${i}">${cells}</tr>`;
      }).join('');
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    },
    /** Wire row clicks for a table rendered by UI.table. */
    bindRows(scope, rows, handler) {
      scope.querySelectorAll('tr[data-row]').forEach((tr) => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, select')) return;
          handler(rows[Number(tr.dataset.row)], e);
        });
      });
    },
    bars(items, { colour = '' } = {}) {
      if (!items.length) return UI.empty('No data for this period.');
      const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
      return '<div class="bars">' + items.map((i) => `
        <div class="bar-row">
          <span title="${esc(i.label)}">${esc(i.label)}</span>
          <span class="bar-track"><span class="bar-fill ${colour}" style="width:${Math.round((Number(i.value) / max) * 100)}%"></span></span>
          <span class="num">${esc(i.display !== undefined ? i.display : UI.num(i.value))}</span>
        </div>`).join('') + '</div>';
    },
    sparkline(values, labels) {
      const max = Math.max(...values, 1);
      return '<div class="spark">' + values.map((v, i) =>
        `<i style="height:${Math.max(2, Math.round((v / max) * 100))}%" title="${esc((labels && labels[i]) || '')}: ${esc(v)}"></i>`
      ).join('') + '</div>';
    },
    /**
     * Open a document in its own window and print it.
     *
     * `standalone` leaves the application stylesheet out. A sheet that brings
     * its own styles wants nothing from app.css — and app.css carries an
     * `@page` rule of its own, which is exactly the sort of thing that quietly
     * turns an A5 prescription into an A4 one.
     */
    print(html, title, { standalone = false, width = 900, height = 1000, watermark = true } = {}) {
      const w = window.open('', '_blank', `width=${width},height=${height}`);
      if (!w) return UI.err('Allow pop-ups to print this document.');
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
        (standalone ? '' : '<link rel="stylesheet" href="/css/app.css">') +
        `</head><body>${watermark ? UI.watermark() : ''}${html}</body></html>`);
      w.document.close();
      w.onload = () => { w.focus(); w.print(); };
    },

    /**
     * The clinic's logo, ghosted behind every page we print.
     *
     * It is fixed rather than absolute so the browser repeats it on each sheet
     * of a document that runs to several pages, and it is painted over the
     * content rather than under it: the sheets draw their own white page, and
     * anything underneath that would simply be hidden. At four to five percent
     * it tints the paper without competing with a single line of text, and it
     * takes no clicks, so nothing on the page becomes harder to use.
     */
    watermark() {
      return `<style>
        .watermark {
          position: fixed; inset: 0; z-index: 9999; pointer-events: none;
          display: flex; align-items: center; justify-content: center;
        }
        .watermark img {
          width: 62%; max-width: 118mm; opacity: .055;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        /* Ink is dearer than pixels, and paper shows a tint more readily. */
        @media print { .watermark img { opacity: .042; } }
      </style><div class="watermark"><img src="/assets/logo.svg" alt=""></div>`;
    },

    /** Print one of the A5 sheets, which carry their own house style. */
    printSheet(html, title) {
      // Roughly A5 at 96dpi, so the window itself is the shape of the page.
      return UI.print(html, title, { standalone: true, width: 620, height: 900 });
    },
    /**
     * The house style for the A5 sheets a patient takes home — the
     * prescription, the diagnostic and imaging reports, and the investigation
     * request. One stylesheet so they read as one clinic's paperwork.
     *
     * The letterhead is set in a serif, because that is what a clinic's name
     * should look like, and the body in a sans with lining, tabular figures —
     * a serif's old-style numerals make dates and codes look hand-set and
     * amateurish at this size, and every number here is one somebody has to
     * read exactly.
     */
    sheetStyles() {
      return `<style>
        @page { size: A5 portrait; margin: 9mm; }
        .sheet {
          margin: 0 auto; color: #16232B; font-size: 10.5px; line-height: 1.45;
          font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
          font-variant-numeric: lining-nums tabular-nums;
          -webkit-font-smoothing: antialiased;
        }
        .sheet .head { text-align: center; border-bottom: 1.6px solid #9E1B34; padding-bottom: 7px; }
        .sheet .head .clinic {
          font-family: Georgia, "Times New Roman", serif; font-size: 18px; font-weight: 700;
          letter-spacing: .3px; color: #9E1B34; line-height: 1.2;
        }
        .sheet .head .tag {
          font-size: 7.5px; letter-spacing: 2.2px; text-transform: uppercase;
          color: #176B7C; margin-top: 3px; font-weight: 600;
        }
        .sheet .head .addr { font-size: 9px; color: #5A6B74; margin-top: 4px; }
        .sheet .doc-title {
          margin-top: 7px; font-size: 10px; font-weight: 700; letter-spacing: 3px;
          text-transform: uppercase; color: #176B7C;
        }

        /* The patient strip: label above value, so nothing has to be guessed at. */
        .sheet .who {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px 12px;
          padding: 9px 0; border-bottom: 1px solid #E4EAED;
        }
        .sheet .who > div { min-width: 0; }
        .sheet .who .k {
          font-size: 7.5px; letter-spacing: .9px; text-transform: uppercase;
          color: #8B9AA2; font-weight: 600;
        }
        .sheet .who .v { font-size: 11px; font-weight: 600; margin-top: 1px; }
        .sheet .who .v.lead { font-size: 12.5px; font-weight: 700; }

        .sheet .block { margin-top: 9px; }
        .sheet .block .k {
          font-size: 7.5px; letter-spacing: .9px; text-transform: uppercase;
          color: #8B9AA2; font-weight: 600;
        }
        .sheet .block p { margin: 1px 0 0; white-space: pre-wrap; }
        .sheet .block .strong { font-weight: 700; font-size: 11.5px; }
        .sheet .warn { color: #B03A2E; font-weight: 700; margin-top: 7px; }

        .sheet table { width: 100%; border-collapse: collapse; }
        .sheet table th {
          text-align: left; font-size: 7.5px; letter-spacing: .9px; text-transform: uppercase;
          color: #8B9AA2; font-weight: 600; border-bottom: 1px solid #16232B; padding: 0 4px 3px;
        }
        .sheet table td { padding: 6px 4px; border-bottom: 1px solid #EDF1F3; vertical-align: top; }
        .sheet table tr:last-child td { border-bottom: 0; }
        .sheet .num { text-align: right; white-space: nowrap; }

        /* Left blank on purpose: the doctor stamps and signs after printing. */
        .sheet .stamp-row { margin-top: 16px; display: flex; justify-content: flex-end; }
        .sheet .stamp { text-align: center; width: 58mm; }
        .sheet .stamp .box {
          height: 21mm; border: 1px dashed #B9C6CC; border-radius: 3px;
          display: flex; align-items: center; justify-content: center; overflow: hidden;
        }
        /* Signed here: the ink replaces the dashed box, and the doctor need not
           reach for a pen. */
        .sheet .stamp .box.signed { border: 0; border-bottom: 1px solid #16232B; border-radius: 0; }
        .sheet .stamp .box img { max-height: 19mm; max-width: 100%; object-fit: contain; }
        .sheet .stamp .cap {
          margin-top: 4px; font-size: 7.5px; color: #8B9AA2;
          letter-spacing: .9px; text-transform: uppercase; font-weight: 600;
        }
        .sheet .note {
          margin-top: 12px; border-top: 1px solid #E4EAED; padding-top: 6px;
          font-size: 8px; color: #8B9AA2; text-align: center; line-height: 1.5;
        }

        /* On paper the page margin does the framing, so the sheet fills it. */
        @media print {
          html, body { margin: 0; padding: 0; background: #fff; }
          .sheet { width: auto; min-height: 0; padding: 0; box-shadow: none; }
        }
        /* On screen it is drawn as the A5 portrait page it will print as —
           148 × 210 mm — so nobody is surprised by the paper. */
        @media screen {
          html, body { margin: 0; background: #eef1f3; }
          body { padding: 14px 0; }
          .sheet {
            width: 148mm; min-height: 210mm; box-sizing: border-box; padding: 9mm;
            background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.18);
          }
        }
      </style>`;
    },

    /** The letterhead every A5 sheet opens with. */
    sheetHead(title) {
      const c = (window.APP && APP.clinic) || {};
      return `<div class="head">
        <div class="clinic">${esc(c.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS')}</div>
        <div class="tag">Care • Compassion • Commitment</div>
        <div class="addr">${esc(c.address || '')}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
        ${title ? `<div class="doc-title">${esc(title)}</div>` : ''}
      </div>`;
    },

    docHeader(title, meta = []) {
      const c = (window.APP && APP.clinic) || {};
      return `<div class="doc-head">
        <img class="logo" src="/assets/logo-icon.svg" alt="">
        <div class="clinic">
          <h2>${esc(c.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS')}</h2>
          <div class="tag">Care • Compassion • Commitment</div>
          <div class="addr">${esc(c.address || '')}<br>${esc(c.phone || '')} · ${esc(c.email || '')}${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}</div>
        </div>
        <div class="docmeta">${meta.map((m) => `<div>${esc(m)}</div>`).join('')}</div>
      </div><div class="doc-title">${esc(title)}</div>`;
    },
  };

  window.UI = UI;
  window.html = UI.tpl;
})();
