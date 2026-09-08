/* =============================================================================
   The conditions editor.

   A block of terms in a textarea is a block nobody edits — the points run
   together, and changing one means finding it in a paragraph. So they are
   shown as what they are: a numbered list, each point on its own, tick to
   include, type to change, drag the order, add one at the end.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  /**
   * @param host      where to draw it
   * @param clauses   [{ text, on }] or plain strings
   * @param onChange  called with the kept points, in order
   */
  function Editor(host, { clauses = [], onChange, readonly = false } = {}) {
    const rows = clauses.map((c) => (typeof c === 'string'
      ? { text: c, on: true, group: null }
      : { text: c.text, on: c.on !== false, group: c.clause_group || c.group || null }));

    const value = () => rows.filter((r) => r.on && r.text.trim()).map((r) => r.text.trim());
    const changed = () => { if (onChange) onChange(value()); };

    function render() {
      let lastGroup = null;
      const body = rows.map((r, i) => {
        const header = r.group && r.group !== lastGroup
          ? `<tr class="group-row"><td colspan="3"><b class="small">${esc(r.group)}</b></td></tr>` : '';
        lastGroup = r.group || lastGroup;
        return header + `<tr data-c="${i}" class="${r.on ? '' : 'dim'}">
          <td style="width:34px" class="num">
            <input type="checkbox" data-on ${r.on ? 'checked' : ''} ${readonly ? 'disabled' : ''}
                   title="Include this point on the document" style="width:auto">
          </td>
          <td><textarea data-text rows="2" ${readonly ? 'disabled' : ''}>${esc(r.text)}</textarea></td>
          <td style="width:96px" class="nowrap">
            ${readonly ? '' : `<button type="button" class="btn ghost sm" data-up title="Move up">↑</button>
            <button type="button" class="btn ghost sm" data-down title="Move down">↓</button>
            <button type="button" class="btn ghost sm" data-drop title="Remove this point">×</button>`}
          </td>
        </tr>`;
      }).join('');

      host.innerHTML = `
        <div class="clauses table-wrap">
          <table><tbody>${body || '<tr><td class="muted">No conditions yet.</td></tr>'}</tbody></table>
        </div>
        <div class="row-between mt">
          <span class="muted small"><b data-count>${value().length}</b> of ${rows.length} points will print.</span>
          ${readonly ? '' : '<button type="button" class="btn ghost sm" data-add>+ Add a point</button>'}
        </div>`;
      wire();
    }

    function wire() {
      if (readonly) return;
      const add = host.querySelector('[data-add]');
      if (add) {
        add.addEventListener('click', () => {
          rows.push({ text: '', on: true, group: null });
          render();
          const boxes = host.querySelectorAll('[data-text]');
          if (boxes.length) boxes[boxes.length - 1].focus();
          changed();
        });
      }
      host.querySelectorAll('tr[data-c]').forEach((tr) => {
        const i = Number(tr.dataset.c);
        tr.querySelector('[data-on]').addEventListener('change', (e) => {
          rows[i].on = e.target.checked;
          tr.classList.toggle('dim', !rows[i].on);
          host.querySelector('[data-count]').textContent = value().length;
          changed();
        });
        tr.querySelector('[data-text]').addEventListener('input', (e) => {
          rows[i].text = e.target.value;
          changed();
        });
        const move = (from, to) => {
          if (to < 0 || to >= rows.length) return;
          // Moving a point out of its heading makes the heading a lie, so the
          // grouping is dropped once the order is changed by hand.
          rows.forEach((r) => { r.group = null; });
          rows.splice(to, 0, rows.splice(from, 1)[0]);
          render();
          changed();
        };
        tr.querySelector('[data-up]').addEventListener('click', () => move(i, i - 1));
        tr.querySelector('[data-down]').addEventListener('click', () => move(i, i + 1));
        tr.querySelector('[data-drop]').addEventListener('click', () => {
          rows.splice(i, 1);
          render();
          changed();
        });
      });
    }

    render();
    return {
      value,
      /** Replace the lot — used when the supplier changes and the names with it. */
      set(next) {
        rows.length = 0;
        for (const c of next) {
          rows.push(typeof c === 'string'
            ? { text: c, on: true, group: null }
            : { text: c.text, on: c.on !== false, group: c.clause_group || null });
        }
        render();
        changed();
      },
      count: () => value().length,
    };
  }

  window.CLAUSES = { Editor };
})();
