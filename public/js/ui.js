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
    modal({ title, body, footer = '', size = '', onMount, onAction }) {
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
      } else if (type === 'textarea') {
        control = `<textarea name="${esc(name)}" rows="${rows || 3}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>${esc(value)}</textarea>`;
      } else {
        control = `<input type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"` +
          `${required ? ' required' : ''}${disabled ? ' disabled' : ''}${step ? ` step="${esc(step)}"` : ''}` +
          `${min !== undefined ? ` min="${esc(min)}"` : ''}${max !== undefined ? ` max="${esc(max)}"` : ''}>`;
      }
      return `<label class="field"><span>${esc(label)}${req}</span>${control}` +
        (hint ? `<span class="muted small">${esc(hint)}</span>` : '') + '</label>';
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
    print(html, title) {
      const w = window.open('', '_blank', 'width=900,height=1000');
      if (!w) return UI.err('Allow pop-ups to print this document.');
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<link rel="stylesheet" href="/css/app.css"></head><body>${html}</body></html>`);
      w.document.close();
      w.onload = () => { w.focus(); w.print(); };
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
