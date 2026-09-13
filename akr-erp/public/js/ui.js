/* Shared rendering helpers: escaping, formatting, modals, toasts, forms, and
   the house style for the documents this company prints. */
(function () {
  'use strict';

  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parse(value) {
    if (!value) return null;
    const s = String(value);
    // A plain date stays a plain date: shifting '2026-09-08' through a timezone
    // is how an invoice ends up dated the day before it was raised.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const UI = {
    esc,
    tpl(strings, ...values) {
      return strings.reduce((out, s, i) => out + s + (i < values.length ? esc(values[i]) : ''), '');
    },
    round2: (v) => Math.round((Number(v) || 0) * 100) / 100,

    /** AED 12,450.00 — the currency always named, because clients ask. */
    money(v, { symbol = true } = {}) {
      if (v === null || v === undefined) return '—';
      const n = Number(v) || 0;
      const body = n.toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const cur = (window.APP && APP.currencySymbol) || 'AED';
      return symbol ? `${cur} ${body}` : body;
    },
    num(v, digits = 0) {
      if (v === null || v === undefined) return '—';
      return Number(v).toLocaleString('en-AE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },
    /** A quantity, without trailing zeros nobody typed. */
    qty(v) {
      const n = Number(v) || 0;
      return Number.isInteger(n) ? n.toLocaleString('en-AE') : String(Math.round(n * 1000) / 1000);
    },
    date(value) {
      const d = parse(value);
      return d ? `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '—';
    },
    dateShort(value) {
      const d = parse(value);
      return d ? `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}` : '—';
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
      return d ? `${UI.date(value)} · ${UI.time(value)}` : '—';
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
    /** How many days from today, said the way a person would say it. */
    dueIn(value) {
      const d = parse(value);
      if (!d) return '—';
      const days = Math.round((d - new Date(new Date().toDateString())) / 86400000);
      if (days === 0) return 'today';
      if (days === 1) return 'tomorrow';
      if (days === -1) return '1 day overdue';
      return days > 0 ? `in ${days} days` : `${-days} days overdue`;
    },
    today() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    addDays(iso, days) {
      const d = parse(iso) || new Date();
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    titleise(s) {
      return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    },

    // -------------------------------------------------------------- toasts
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
      }, kind === 'err' ? 7000 : 3600);
    },
    ok: (m) => UI.toast(m, 'ok'),
    err: (m) => UI.toast(m, 'err'),
    warn: (m) => UI.toast(m, 'warn'),

    // -------------------------------------------------------------- modals
    modal({ title, body, footer = '', size = '', onMount, onAction, onClose }) {
      const root = document.getElementById('modal-root');
      const holder = document.createElement('div');
      holder.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal ${size}" role="dialog" aria-modal="true">
            <header><h2>${esc(title)}</h2><button class="x" data-act="__close" aria-label="Close">×</button></header>
            <div class="body">${body}</div>
            ${footer ? `<footer>${footer}</footer>` : ''}
          </div>
        </div>`;

      const backdrop = holder.firstElementChild;
      root.appendChild(backdrop);

      const onKey = (e) => { if (e.key === 'Escape' && UI._modals[UI._modals.length - 1] === close) close(); };
      const close = () => {
        document.removeEventListener('keydown', onKey);
        const i = UI._modals.indexOf(close);
        if (i !== -1) UI._modals.splice(i, 1);
        if (backdrop.isConnected) backdrop.remove();
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
    closeModal() {
      const top = UI._modals[UI._modals.length - 1];
      if (top) top();
    },
    closeAllModals() {
      while (UI._modals.length) UI._modals[UI._modals.length - 1]();
      const root = document.getElementById('modal-root');
      if (root) root.innerHTML = '';
    },

    confirm(message, { title = 'Please confirm', danger = false, yes = 'Yes, continue' } = {}) {
      return new Promise((resolve) => {
        UI.modal({
          title,
          size: 'narrow',
          body: `<p>${esc(message)}</p>`,
          footer: `<button class="btn ghost" data-act="__close">Cancel</button>
                   <button class="btn ${danger ? 'danger' : 'green'}" data-act="yes">${esc(yes)}</button>`,
          onAction: (act) => { resolve(act === 'yes'); },
          onClose: () => resolve(false),
        });
      });
    },

    // --------------------------------------------------------------- forms
    formValues(scope) {
      const out = {};
      scope.querySelectorAll('[name]').forEach((el) => {
        if (el.type === 'checkbox') out[el.name] = el.checked;
        else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
        else if (el.value !== '') out[el.name] = el.value;
      });
      return out;
    },
    field({ name, label, type = 'text', value = '', required = false, placeholder = '', options,
      rows, step, min, max, hint, disabled, blank }) {
      const req = required ? ' <span class="req">*</span>' : '';
      let control;
      if (options) {
        const list = blank === undefined ? options : [{ value: '', label: blank }, ...options];
        // An entry carrying its own `options` is a heading with a list under
        // it — clients and suppliers on one picker, without them running into
        // each other.
        const option = (o) => {
          const val = o.value !== undefined ? o.value : o;
          const lab = o.label !== undefined ? o.label : o;
          const sel = String(val) === String(value === null ? '' : value) ? ' selected' : '';
          return `<option value="${esc(val)}"${sel}${o.disabled ? ' disabled' : ''}>${esc(lab)}</option>`;
        };
        control = `<select name="${esc(name)}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}>` +
          list.map((o) => (Array.isArray(o.options)
            ? `<optgroup label="${esc(o.label)}">${o.options.map(option).join('')}</optgroup>`
            : option(o))).join('') + '</select>';
      } else if (type === 'textarea' || rows) {
        control = `<textarea name="${esc(name)}" rows="${rows || 3}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>${esc(value)}</textarea>`;
      } else {
        control = `<input type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"` +
          `${required ? ' required' : ''}${disabled ? ' disabled' : ''}${step ? ` step="${esc(step)}"` : ''}` +
          `${min !== undefined ? ` min="${esc(min)}"` : ''}${max !== undefined ? ` max="${esc(max)}"` : ''}>`;
      }
      return `<label class="field"><span>${esc(label)}${req}</span>${control}` +
        (hint ? `<span class="muted small">${esc(hint)}</span>` : '') + '</label>';
    },
    password({ name, label, required = false, autocomplete = 'current-password', hint, meter = false }) {
      const id = `pw-${name}-${Math.random().toString(36).slice(2, 8)}`;
      return `<label class="field" for="${id}">
        <span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span>
        <span class="pw-wrap">
          <input type="password" id="${id}" name="${esc(name)}" autocomplete="${esc(autocomplete)}"
                 ${required ? 'required' : ''} ${meter ? 'data-meter="1"' : ''}>
          <button type="button" class="pw-eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">${UI.eyeIcon(false)}</button>
        </span>
        ${meter ? '<span class="pw-meter"><i></i></span><span class="pw-hint"></span>' : ''}
        ${hint ? `<span class="muted small">${esc(hint)}</span>` : ''}
      </label>`;
    },
    eyeIcon(shown) {
      return shown
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
             <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
             <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
             <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
             <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    },
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
          btn.setAttribute('aria-pressed', String(show));
          const pos = input.value.length;
          input.focus();
          try { input.setSelectionRange(pos, pos); } catch { /* type change resets it */ }
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
      if (['password', '12345678', 'akr@1234', 'qwerty123', 'admin123', 'welcome1'].includes(v.toLowerCase())) {
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
        colour: pct >= 85 ? 'var(--green)' : pct >= 70 ? 'var(--info)' : 'var(--warn)',
        label: pct >= 85 ? 'Strong' : pct >= 70 ? 'Good' : 'Acceptable — longer would be better',
        cls: 'ok',
      };
    },
    checkbox({ name, label, checked = false }) {
      return `<label class="inline-check"><input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    },

    // -------------------------------------------------------------- pieces
    badge: (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`,
    statusBadge(status) {
      const map = {
        // quotations
        draft: '', requested: 'info', received: 'warn', sent: 'info', under_review: 'warn',
        approved: 'ok', rejected: 'danger', expired: '', converted: 'ok', ordered: 'ok',
        // orders and movement
        acknowledged: 'info', confirmed: 'info', partial: 'warn', delivered: 'ok',
        invoiced: 'ok', closed: '', cancelled: 'danger',
        // money
        unpaid: 'danger', paid: 'ok', overdue: 'danger', disputed: 'warn',
        pending: 'warn', deposited: 'info', cleared: 'ok', bounced: 'danger',
        // enquiries
        open: 'info', quoted: 'warn', won: 'ok', lost: 'danger',
      };
      return UI.badge(UI.titleise(status), map[status] === undefined ? '' : map[status]);
    },
    empty: (text, icon = '📋') => `<div class="empty"><div class="big">${icon}</div><div>${esc(text)}</div></div>`,
    loading: () => '<div class="loading"><span class="spinner"></span></div>',
    table(columns, rows, { onRow, emptyText = 'Nothing to show yet.', foot } = {}) {
      if (!rows || !rows.length) return UI.empty(emptyText);
      const head = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
      const body = rows.map((r, i) => {
        const cells = columns.map((c) =>
          `<td${c.num ? ' class="num"' : ''}>${c.render ? c.render(r, i) : esc(r[c.key])}</td>`).join('');
        return `<tr class="${onRow ? 'clickable' : ''}" data-row="${i}">${cells}</tr>`;
      }).join('');
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>` +
        (foot ? `<tfoot>${foot}</tfoot>` : '') + '</table></div>';
    },
    bindRows(scope, rows, handler) {
      scope.querySelectorAll('tr[data-row]').forEach((tr) => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, select')) return;
          handler(rows[Number(tr.dataset.row)], e);
        });
      });
    },
    stat({ label, value, note, kind = '', route }) {
      return `<div class="stat ${kind}${route ? ' clickable' : ''}"${route ? ` data-goto="${esc(route)}"` : ''}>
        <div class="k">${esc(label)}</div><div class="v">${value}</div>
        ${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
    },
    bindStats(scope) {
      scope.querySelectorAll('[data-goto]').forEach((el) => {
        el.addEventListener('click', () => { window.location.hash = el.dataset.goto; });
      });
    },
    bars(items, { colour = '' } = {}) {
      if (!items.length) return UI.empty('No data for this period.');
      const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
      return '<div class="bars">' + items.map((i) => `
        <div class="bar-row">
          <span title="${esc(i.label)}">${esc(i.label)}</span>
          <span class="bar-track"><span class="bar-fill ${colour}" style="width:${Math.round((Number(i.value) / max) * 100)}%"></span></span>
          <span class="num">${i.display !== undefined ? i.display : UI.num(i.value)}</span>
        </div>`).join('') + '</div>';
    },
    /** Two columns of label/value, for a document's header block. */
    facts(pairs) {
      return '<table class="facts"><tbody>' + pairs.filter(Boolean).map(([k, v]) =>
        `<tr><td class="muted small" style="width:42%">${esc(k)}</td><td>${v}</td></tr>`).join('')
        + '</tbody></table>';
    },
  };

  window.UI = UI;
  window.html = UI.tpl;
})();
