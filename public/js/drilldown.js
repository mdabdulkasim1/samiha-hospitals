/*
 * Opening the rows behind a number.
 *
 * A figure on a dashboard or a report is the answer to a counting question,
 * and the question that follows it is always "which ones?". This is the one
 * place that answers it, so the dashboard's tiles and the reports screen's
 * behave identically: the same modal, the same shape of list, the same total
 * ruled off underneath, and the same button through to the full screen.
 *
 * It deliberately knows nothing about any particular metric. The caller says
 * which endpoint to ask and how to read a row; the server says what the rows
 * are and where the full screen lives.
 */
(function () {
  'use strict';

  /** Patient, with the UHID underneath — the pairing used all over the app. */
  const who = (r) => `<b>${UI.esc(r.name || '—')}</b>` +
    (r.uhid ? `<div class="muted small">${UI.esc(r.uhid)}</div>` : '');

  /** Where a booking or an enquiry came from. */
  const source = (v) => (v ? UI.badge(UI.titleise(v), v === 'whatsapp' ? 'wa' : 'info') : '—');

  /** Sum a column across the rows on screen. */
  const sumOf = (rows, key) => rows.reduce((a, r) => a + Number(r[key] || 0), 0);

  /**
   * Ask an endpoint for the rows behind a figure and show them.
   *
   * `columns` is a UI.table column spec. `total`, when given, rules a rupee
   * sum off under the list — say `{ label, key }` and it adds that column up.
   */
  async function open(path, { columns, total, title, caption } = {}) {
    let data;
    try {
      data = await API.get(path);
    } catch (err) {
      return UI.err(err.message);
    }

    const cols = columns || [{ label: 'Name', render: (r) => UI.esc(r.name || '—') }];
    const heading = title || data.title || 'Detail';

    UI.modal({
      title: heading,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div class="muted small">${UI.esc(caption || data.caption || '')}</div>
          <div class="muted small">${UI.num(data.total)} row${data.total === 1 ? '' : 's'}${
            data.truncated ? ` · showing the first ${UI.num(data.rows.length)}` : ''}</div>
        </div>
        ${UI.table(cols, data.rows, {
          emptyText: 'Nothing behind this number yet — it is zero for a reason.',
        })}
        ${total && data.rows.length ? `<div class="row-between mt">
          <span class="muted small">${UI.esc(total.label)}${
            data.truncated ? ' (rows shown)' : ''}</span>
          <b style="font-size:16px">${UI.money(sumOf(data.rows, total.key))}</b></div>` : ''}
        ${data.truncated ? `<div class="alert info mt">Only the first ${UI.num(data.rows.length)}
          of ${UI.num(data.total)} are listed here. Open the full screen to work through the rest.</div>` : ''}`,
      footer: `${data.route
        ? `<button class="btn ghost" data-act="open">${UI.esc(data.routeLabel || 'Open the screen')}</button>`
        : ''}
        <button class="btn" data-act="__close">Close</button>`,
      onAction(act) {
        if (act === 'open' && data.route) APP.navigate(data.route, data.routeParams || undefined);
      },
    });
  }

  window.Drilldown = { open, who, source, sumOf };
})();
