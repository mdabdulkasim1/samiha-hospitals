/* =============================================================================
   Paperwork kept against a document.

   The client's LPO arrives as a PDF, and a year later somebody wants to see the
   thing they signed rather than our transcription of it. This is the panel that
   keeps it: drop a file on it, or choose one, and it opens in a tab thereafter.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  const ICONS = {
    'application/pdf': '📄',
    'image/jpeg': '🖼', 'image/png': '🖼', 'image/webp': '🖼',
  };
  const icon = (mime) => ICONS[mime] || '📎';

  const size = (bytes) => (bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  /** Read a chosen file as base64, which is how it is sent. */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
      reader.onerror = () => reject(new Error('That file could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Draw the panel into `host` for one document.
   *
   * @param entityType  sales_order, purchase_order, …
   * @param entityId    the document's id
   * @param kind        what the file is, e.g. 'Client LPO'
   */
  async function panel(host, { entityType, entityId, kind = null, title = 'Attachments' } = {}) {
    const load = async () => {
      const data = await API.get(`/api/attachments/${entityType}/${entityId}`);
      host.innerHTML = `
        <h4 class="mt">${esc(title)}</h4>
        <div class="muted small mb">Kept with the order, on the same volume as the books.
          ${data.canAttach ? `PDF, image, Word or Excel, up to ${data.maxMb} MB.` : ''}</div>
        <div class="attachments">
          ${data.rows.length ? data.rows.map((a) => `
            <div class="attach-row">
              <span class="ico">${icon(a.mime)}</span>
              <span class="who">
                <b>${esc(a.filename)}</b>
                <span class="muted small">${esc(a.kind ? a.kind + ' · ' : '')}${size(a.size_bytes)}
                  · ${esc(a.uploaded_by_name || '')} · ${UI.date(a.uploaded_at)}</span>
              </span>
              <button class="btn ghost sm" data-open="${a.id}">Open</button>
              ${data.canAttach ? `<button class="btn ghost sm" data-drop="${a.id}"
                 title="Remove this file">×</button>` : ''}
            </div>`).join('')
            : '<div class="muted small">Nothing attached yet.</div>'}
        </div>
        ${data.canAttach ? `
          <label class="dropzone mt" id="dz">
            <input type="file" hidden id="file"
                   accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx">
            <span>Drop the file here, or <b>choose one</b></span>
          </label>
          <div id="attach-out"></div>` : ''}`;

      host.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
        // The token lives in localStorage, so the file is fetched and handed to
        // the tab as a blob rather than opened by URL, which would arrive
        // unauthenticated.
        openAttachment(b.dataset.open);
      }));
      host.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
        const sure = await UI.confirm('Remove this file? It is deleted from the server.',
          { danger: true, yes: 'Remove it' });
        if (!sure) return;
        await API.del(`/api/attachments/${b.dataset.drop}`);
        UI.ok('Removed.');
        load();
      }));

      if (!data.canAttach) return;
      const zone = host.querySelector('#dz');
      const input = host.querySelector('#file');
      const out = host.querySelector('#attach-out');

      const send = async (file) => {
        if (!file) return;
        out.innerHTML = UI.loading();
        try {
          const saved = await API.post(`/api/attachments/${entityType}/${entityId}`, {
            data: await readFile(file),
            filename: file.name,
            mime: file.type || null,
            kind,
          });
          out.innerHTML = '';
          UI.ok(`${saved.filename} attached.`);
          load();
        } catch (err) {
          out.innerHTML = `<div class="alert danger mt">${esc(err.message)}</div>`;
        }
      };

      input.addEventListener('change', () => send(input.files[0]));
      ['dragenter', 'dragover'].forEach((e) => zone.addEventListener(e, (ev) => {
        ev.preventDefault();
        zone.classList.add('over');
      }));
      ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, (ev) => {
        ev.preventDefault();
        zone.classList.remove('over');
      }));
      zone.addEventListener('drop', (ev) => send(ev.dataTransfer.files[0]));
    };

    host.innerHTML = UI.loading();
    await load();
  }

  /** Fetch with the session token, then show it. */
  async function openAttachment(id) {
    const headers = {};
    const token = API.getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/attachments/file/${id}`, { headers, credentials: 'same-origin' });
    if (!res.ok) { UI.err('That file could not be opened.'); return; }
    const url = URL.createObjectURL(await res.blob());
    const w = window.open(url, '_blank');
    if (!w) UI.err('Allow pop-ups to open the attachment.');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  window.ATTACH = { panel, open: openAttachment, size };
})();
