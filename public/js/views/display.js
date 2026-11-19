/**
 * The screen in the waiting room.
 *
 * This is the one page in the ERP nobody operates. It goes on a television
 * on the wall, on one floor, and then it is left alone for the day — so it
 * is built for being read across a room rather than for being clicked. Big
 * numbers, few of them, high contrast, and no page furniture: the moment a
 * patient has to lean in to read which room 08-004 is being called to, the
 * screen has failed at its only job.
 *
 * It shows one floor. A screen downstairs that calls people to a room
 * upstairs is worse than no screen, because a patient reads the first large
 * number they see and stands up.
 *
 * And it shows no names. A waiting room is a public place; a number on a
 * wall tells the right person everything and everybody else nothing.
 */
(function () {
  'use strict';

  let timer = null;
  let lastCalled = '';

  APP.register('display', {
    title: 'Waiting-room screen',
    subtitle: 'For the television — pick a floor, then press full screen',

    async render(el, params) {
      const floors = (await API.get('/api/queue/display')).floors;
      const floor = params.floor || floors[0] || '';

      APP.actions([
        { id: 'full', label: 'Full screen', onClick: () => goFullScreen(el) },
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
        if (APP.route !== 'display') return clearInterval(timer);
        paint(host, floor).catch(() => {});
      }, 5000);
    },
  });

  async function paint(host, floor) {
    const d = await API.get('/api/queue/display' + API.qs({ floor }));

    /*
     * The newest call, shown once across the top in the largest type on the
     * screen. It is what somebody looks up for, and showing it apart from
     * the room panels means they do not have to scan four boxes to find
     * which one changed.
     */
    const calls = d.panels.filter((p) => p.nowCalling)
      .map((p) => ({ ...p.nowCalling, where: `${p.room.floor} · ${p.room.name}` }))
      .concat(d.counters.filter((c) => c.nowCalling)
        .map((c) => ({ ...c.nowCalling,
          where: c.counter.location
            ? `${c.counter.name} · ${c.counter.location}` : c.counter.name })))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const head = calls[0] || null;

    host.innerHTML = `
      <div class="tv-head">
        <div class="tv-badge">${UI.esc(d.clinic)}</div>
        <div class="tv-floor">${UI.esc(d.floor || 'All floors')}</div>
        <div class="tv-clock">${UI.esc(String(d.at).slice(11, 16))}</div>
      </div>

      ${head ? `<div class="tv-now">
        <div class="tv-now-label">Now calling</div>
        <div class="tv-now-number">${UI.esc(head.label)}</div>
        <div class="tv-now-where">${UI.esc(head.where)}</div>
        ${head.category ? `<div class="tv-now-cat">${UI.esc(head.category)}</div>` : ''}
      </div>` : `<div class="tv-now tv-idle">
        <div class="tv-now-label">Please wait</div>
        <div class="tv-now-where">Numbers will be called here</div>
      </div>`}

      <div class="tv-grid">${d.panels.map(panel).join('')}</div>
      ${d.counters.length ? `<div class="tv-counters">${d.counters.map(counter).join('')}</div>` : ''}
      <div class="tv-foot">Keep your slip · ${UI.esc(UI.date(d.date))}</div>`;

    // A soft chime when the number at the top changes, if the television has
    // any sound at all. Silent failure is the right failure here.
    if (head && head.label !== lastCalled) {
      if (lastCalled) chime();
      lastCalled = head.label;
    }
  }

  function panel(p) {
    return `<div class="tv-room ${p.nowCalling ? 'lit' : ''}">
      <div class="tv-room-head">
        <b>${UI.esc(p.room.name)}</b>
        <span>${UI.esc(p.room.floor)}</span>
      </div>
      <div class="tv-room-spec">${p.room.specialties.length
        ? UI.esc(p.room.specialties.join(' · ')) : '&nbsp;'}</div>
      ${p.room.doctors && p.room.doctors.length
        ? `<div class="tv-room-doc">${UI.esc(p.room.doctors.join(' · '))}</div>` : ''}
      <div class="tv-room-number">${p.nowCalling ? UI.esc(p.nowCalling.label) : '—'}</div>
      ${p.nowCalling && p.nowCalling.category
        ? `<div class="tv-room-cat">${UI.esc(p.nowCalling.category)}</div>` : ''}
      <div class="tv-room-next">${p.upNext.length
        ? `Next: ${p.upNext.map((t) => UI.esc(t.label)).join('  ')}`
        : (p.waiting ? '&nbsp;' : 'No one waiting')}</div>
    </div>`;
  }

  function counter(c) {
    return `<div class="tv-counter">
      <div class="tv-counter-name">${UI.esc(c.counter.name)}${c.counter.location
        ? `<span class="tv-counter-where"> · ${UI.esc(c.counter.location)}</span>` : ''}</div>
      <div class="tv-counter-number">${c.nowCalling ? UI.esc(c.nowCalling.label) : '—'}</div>
      <div class="tv-counter-next">${c.upNext.length
        ? `Next: ${c.upNext.map((t) => UI.esc(t.label)).join('  ')}` : '&nbsp;'}</div>
    </div>`;
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
}());
