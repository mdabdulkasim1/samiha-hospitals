/**
 * The screen in the waiting room.
 *
 * This is the one page in the ERP nobody operates. It goes on a television
 * on the wall, on one floor, and is then left alone for the day — so it is
 * built for being read across a room rather than for being clicked.
 *
 * The television is split the way the clinic asked for and the way every
 * polyclinic screen is split: numbers on one side, the clinic's own poster
 * on the other. Both halves earn their place. The numbers are why a patient
 * looks up; the poster is why they keep looking when their number is
 * nowhere near, which is the only reason anybody reads it at all.
 *
 * The left half is a table of two columns, token and room, because that is
 * the question being asked — "where do I go with 08-004" — and a table
 * answers it in one glance without the eye hunting between panels. Rows
 * stay in the same place all day: a patient who has learned that
 * Paediatrics is the third row should not have to find it again every time
 * somebody is called.
 *
 * No patient names. A waiting room is a public place; a number on a wall
 * tells the right person everything and everybody else nothing. Doctors'
 * names are on it because those are on the door anyway.
 */
(function () {
  'use strict';

  let timer = null;
  let slideTimer = null;
  let lastCalled = '';
  let slideAt = 0;

  const isManagement = () => Boolean(APP.user && ['owner', 'admin'].includes(APP.user.role));
  const mayEdit = () => isManagement() || APP.can(['reception']);

  APP.register('display', {
    title: 'Waiting-room screen',
    subtitle: 'For the television — pick a floor, then press full screen',

    async render(el, params) {
      const first = await API.get('/api/queue/display');
      const floors = first.floors;
      const floor = params.floor || floors[0] || '';

      APP.actions([
        { id: 'full', label: 'Full screen', onClick: () => goFullScreen(el) },
        ...(mayEdit() ? [{ id: 'slides', label: 'Posters', onClick: () => openSlides() }] : []),
        { id: 'refresh', label: 'Refresh', onClick: () => APP.reload() },
      ]);

      el.innerHTML = `
        <div class="search-row no-print" id="tv-pick">
          ${floors.map((f) => `<button class="btn ${f === floor ? '' : 'ghost'}"
            data-floor="${UI.esc(f)}">${UI.esc(f)}</button>`).join('')}
          <span class="muted small" style="align-self:center">
            Open this on the television and press Full screen. It refreshes itself.</span>
        </div>
        <div class="tv" id="tv"></div>`;

      el.querySelectorAll('[data-floor]').forEach((b) => b.addEventListener('click', () =>
        APP.navigate('display', { floor: b.dataset.floor })));

      const host = el.querySelector('#tv');
      await paint(host, floor);

      /*
       * Five seconds. A waiting-room screen is the one place in this ERP
       * where a stale number has a person standing in front of it, and the
       * payload is a few dozen numbers.
       */
      clearInterval(timer);
      timer = setInterval(() => {
        if (APP.route !== 'display') { clearInterval(timer); clearInterval(slideTimer); return; }
        paint(host, floor).catch(() => {});
      }, 5000);
    },
  });

  // ------------------------------------------------------------- the screen
  async function paint(host, floor) {
    const d = await API.get('/api/queue/display' + API.qs({ floor }));
    /*
     * Nine lines at most. A television cannot be scrolled, so a tenth row
     * is not a row anybody sees — and squeezing more in shrinks the type
     * until the numbers stop being readable from the back of the room,
     * which is the one thing this screen has to do.
     */
    const rows = tableRows(d).slice(0, 9);
    const newest = rows.filter((r) => r.at).sort((a, b) =>
      String(b.at).localeCompare(String(a.at)))[0] || null;

    host.innerHTML = `
      <div class="tv-head">
        <div class="tv-badge">${UI.esc(d.clinic)}</div>
        <div class="tv-floor">${UI.esc(d.floor || 'All floors')}</div>
        <div class="tv-clock">${UI.esc(String(d.at).slice(11, 16))}</div>
      </div>

      <div class="tv-split">
        <div class="tv-board">
          <div class="tv-row tv-row-head">
            <div>Token No</div>
            <div>Room No</div>
          </div>
          <div class="tv-rows">
            ${rows.length ? rows.map((r) => row(r, newest)).join('')
    : '<div class="tv-empty">Please wait — numbers will be called here</div>'}
          </div>
        </div>
        <div class="tv-ad" id="tv-ad"></div>
      </div>

      <div class="tv-foot">Keep your slip · ${UI.esc(UI.date(d.date))}</div>`;

    paintAd(host, d.slides || []);

    // A soft chime when the newest number changes, if the television has any
    // sound at all. Silent failure is the right failure here.
    if (newest && newest.label !== lastCalled) {
      if (lastCalled) chime();
      lastCalled = newest.label;
    }
  }

  /**
   * One line per place a patient can be called to, in a fixed order.
   *
   * Rooms that have nobody in them stay on the board showing a dash rather
   * than dropping off it, so the row a patient has learned to look at does
   * not move under them while they are watching.
   */
  function tableRows(d) {
    const out = d.panels.map((p) => ({
      label: p.nowCalling ? p.nowCalling.label : null,
      room: p.room.name,
      floor: p.room.floor,
      sub: [p.room.doctors.join(' · '), p.nowCalling ? p.nowCalling.category : '']
        .filter(Boolean).join(' — ') || p.room.specialties.join(' · '),
      waiting: p.waiting,
      upNext: p.upNext,
      at: p.nowCalling ? p.nowCalling.at : null,
    }));

    /*
     * The counters sit under the consulting rooms, because the laboratory
     * calling 12-014 is a thing the waiting room needs to see and it is not
     * a room anybody walks to by number.
     */
    for (const c of d.counters) {
      out.push({
        label: c.nowCalling ? c.nowCalling.label : null,
        room: c.counter.name,
        floor: c.counter.location || '',
        sub: c.counter.location || '',
        waiting: c.waiting,
        upNext: c.upNext,
        at: c.nowCalling ? c.nowCalling.at : null,
      });
    }
    return out;
  }

  function row(r, newest) {
    const lit = newest && r.label && r.label === newest.label && r.room === newest.room;
    return `<div class="tv-row ${lit ? 'lit' : ''} ${r.label ? '' : 'idle'}">
      <div class="tv-token">${r.label ? UI.esc(r.label) : '—'}</div>
      <div class="tv-where">
        <div class="tv-room-no">${UI.esc(r.room)}</div>
        ${r.sub ? `<div class="tv-sub">${UI.esc(r.sub)}</div>` : ''}
        ${r.upNext && r.upNext.length
    ? `<div class="tv-next">Next: ${r.upNext.map((t) => UI.esc(t.label)).join('  ')}</div>` : ''}
      </div>
    </div>`;
  }

  /**
   * The clinic's poster, on the other half.
   *
   * Several rotate on their own timers. With none loaded the half is not
   * left blank — it carries the clinic's name and the number being called,
   * in large type, which is better than a grey rectangle on a wall.
   */
  function paintAd(host, slides) {
    const ad = host.querySelector('#tv-ad');
    if (!ad) return;
    clearInterval(slideTimer);

    if (!slides.length) {
      ad.innerHTML = `<div class="tv-ad-none">
        <div class="tv-ad-badge">SAMIHA HEALTHCARE</div>
        <div class="tv-ad-line">Care · Compassion · Commitment</div>
        ${mayEdit() ? '<div class="tv-ad-hint">Posters → add an image to fill this half</div>' : ''}
      </div>`;
      return;
    }

    const show = (i) => {
      slideAt = i % slides.length;
      const s = slides[slideAt];
      ad.innerHTML = `<img src="/api/queue/slides/${s.id}/image" alt="${UI.esc(s.title || '')}">`;
      clearInterval(slideTimer);
      // One image needs no timer at all; several change on their own seconds.
      if (slides.length > 1) {
        slideTimer = setInterval(() => show(slideAt + 1), Math.max(3, s.seconds || 12) * 1000);
      }
    };
    show(slideAt);
  }

  function goFullScreen(el) {
    const target = el.querySelector('#tv') || el;
    target.classList.add('tv-fs');
    if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
  }

  /** Two short tones. No audio file to ship and nothing to fail to load. */
  function chime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [880, 1175].forEach((hz, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = hz;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02 + i * 0.22);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.20 + i * 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.22);
        osc.stop(ctx.currentTime + 0.24 + i * 0.22);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch { /* a television with no sound is still a television */ }
  }

  // -------------------------------------------------------------- the posters
  /**
   * What plays on the other half.
   *
   * Deliberately simple: choose a picture, say how long it stays up, say
   * which floor it is for. The clinic designs its posters wherever it
   * designs them and loads the finished image, which is how a Sunday
   * package gets onto the wall on a Saturday night without anybody
   * touching this system's code.
   */
  async function openSlides() {
    const { rows } = await API.get('/api/queue/slides');
    const floors = (await API.get('/api/queue/display')).floors;

    UI.modal({
      title: 'Posters on the waiting-room screen',
      size: 'wide',
      body: `
        <div class="alert info">A picture — JPEG or PNG, up to 6 MB — sits on the right half of
          the television beside the numbers. Several take turns. Portrait or square images suit
          that half best; a wide one is fitted inside it.</div>
        <div id="sl-list">${slideCards(rows)}</div>
        <fieldset class="mt"><legend>Add a poster</legend>
          <form id="sl-form">
            <input type="file" id="sl-file" accept="image/jpeg,image/png,image/webp,image/gif">
            <div class="grid c3 mt">
              ${UI.field({ name: 'title', label: 'What it is', placeholder: 'Sunday wellness package' })}
              ${UI.field({ name: 'seconds', label: 'Seconds on screen', type: 'number', value: 12, min: 3, max: 120 })}
              ${UI.field({ name: 'floor', label: 'Which screen',
    options: [{ value: '', label: 'Both floors' }].concat(floors.map((f) => ({ value: f, label: f }))) })}
            </div>
          </form>
          <div id="sl-out"></div>
        </fieldset>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="add">Add the poster</button>`,
      onMount(modal) { wireSlides(modal); },
      async onAction(act, modal) {
        if (act !== 'add') return;
        const file = modal.querySelector('#sl-file').files[0];
        if (!file) { UI.err('Choose an image first.'); return 'keep'; }
        const v = UI.formValues(modal.querySelector('#sl-form'));
        try {
          const data = await readFile(file);
          await API.post('/api/queue/slides', {
            data, title: v.title || file.name, seconds: v.seconds, floor: v.floor,
          });
          UI.ok('Poster added.');
          const fresh = await API.get('/api/queue/slides');
          modal.querySelector('#sl-list').innerHTML = slideCards(fresh.rows);
          modal.querySelector('#sl-file').value = '';
          wireSlides(modal);
          return 'keep';
        } catch (err) {
          modal.querySelector('#sl-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  const slideCards = (rows) => (rows.length
    ? `<div class="sl-grid">${rows.map((s) => `
        <div class="sl-card ${s.active ? '' : 'off'}">
          <img src="/api/queue/slides/${s.id}/image" alt="">
          <div class="sl-meta">
            <b>${UI.esc(s.title || 'Untitled')}</b>
            <div class="muted small">${UI.esc(s.seconds)}s · ${UI.esc(s.floor || 'both floors')}
              · ${UI.esc((s.bytes / 1024).toFixed(0))} KB</div>
            <div class="mt">
              <button class="btn ghost sm" data-slide-toggle="${s.id}" data-on="${s.active}">
                ${s.active ? 'Take it off' : 'Put it back'}</button>
              <button class="btn ghost sm" data-slide-del="${s.id}">Remove</button>
            </div>
          </div>
        </div>`).join('')}</div>`
    : UI.empty('No posters yet — the other half of the screen carries the clinic name.', '🖼'));

  function wireSlides(modal) {
    const refresh = async () => {
      const fresh = await API.get('/api/queue/slides');
      modal.querySelector('#sl-list').innerHTML = slideCards(fresh.rows);
      wireSlides(modal);
    };
    modal.querySelectorAll('[data-slide-toggle]').forEach((b) => b.addEventListener('click', async () => {
      await API.patch(`/api/queue/slides/${b.dataset.slideToggle}`, { active: b.dataset.on !== '1' });
      await refresh();
    }));
    modal.querySelectorAll('[data-slide-del]').forEach((b) => b.addEventListener('click', async () => {
      await API.del(`/api/queue/slides/${b.dataset.slideDel}`);
      UI.ok('Poster removed.');
      await refresh();
    }));
  }

  /** A file input hands back bytes; the server takes a data URL. */
  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}());
