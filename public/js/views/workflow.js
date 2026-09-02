/* Workflow map — the clinic flowchart, annotated with where each step lives. */
(function () {
  'use strict';

  const LANES = [
    {
      key: 'checkin', title: 'Check In', colour: 'var(--teal)',
      steps: [
        { n: 'Patient walk-in / M.A. calls patient', where: 'Queue → + Patient arrived', route: 'queue' },
        { n: 'New patient?', decision: true, note: 'Yes → demographic & medical-history paperwork. No → next check.' },
        { n: 'Demographic, med. history paperwork', where: 'Patients → Register patient', route: 'patients' },
        { n: 'Financial situation changed?', decision: true, note: 'Yes → financial screening lane.' },
        { n: 'Time for yearly screening?', decision: true, note: 'Flagged automatically if the last screening was over a year ago.' },
        { n: 'Uninsured / needs financial assistance?', decision: true, note: 'Yes → financial screening. No → check in.' },
        { n: 'Check in · ask reason for visit', where: 'Queue → visit card → Check in', route: 'queue' },
      ],
    },
    {
      key: 'finance', title: 'Financial Screening', colour: 'var(--orange)',
      steps: [
        { n: 'Financial screening paperwork', where: 'Financial Screening → Start screening', route: 'financial' },
        { n: 'Counselor available?', decision: true, note: 'No → the case queues and the patient waits. Yes → counselor calls the patient.' },
        { n: 'Counselor calls patient', where: 'Financial Screening → Claim & call patient', route: 'financial' },
        { n: 'Has pay stub or valid proof of income?', decision: true, note: 'No → held at “documents pending”; no band can be assigned.' },
        { n: 'Run eligible programmes web form', where: 'Screening worksheet → Determine position', route: 'financial' },
        { n: 'Determine "sliding scale" position', where: 'Income vs poverty line → band A–F', route: 'financial' },
        { n: 'Present financial assistance options', where: 'Screening worksheet → programme list', route: 'financial' },
        { n: 'Patient decides to continue?', decision: true, note: 'Yes → back to the waiting room. No → straight to exit.' },
      ],
    },
    {
      key: 'exam', title: 'Examination', colour: 'var(--crimson)',
      steps: [
        { n: 'Waiting room · M.A. calls patient', where: 'Queue board lane', route: 'queue' },
        { n: 'Take patient to the nurse station · check vitals', where: 'Nurse Station', route: 'vitals' },
        { n: 'M.A. logs into the record system', where: 'Nurse signs in — every action is audited', route: 'vitals' },
        { n: 'Update patient pharmacy information', where: 'Nurse Station → pharmacy panel', route: 'vitals' },
        { n: 'M.A. prints medication list', where: 'Queue → visit card → Results page', route: 'queue' },
        { n: 'Patient to exam room · provider paged', where: 'Consultation queue', route: 'consult' },
        { n: 'Provider gives clinical care', where: 'Consultation → SOAP note, diagnoses, prescription', route: 'consult' },
        { n: 'Place lab orders listed on results page', where: 'Consultation → Order tests', route: 'consult' },
        { n: 'Provider gives results page to patient', where: 'Consultation → Sign, then print results page', route: 'consult' },
      ],
    },
    {
      key: 'checkout', title: 'Check Out', colour: 'var(--ok)',
      steps: [
        { n: 'Patient gives results page to check-out desk', where: 'Billing → Assemble bill', route: 'billing' },
        { n: 'Patient able to pay for labs and visit?', decision: true, note: 'Four branches, all supported below.' },
        { n: 'Accept payment', where: 'Bill → Accept payment (cash, UPI, card…)', route: 'billing' },
        { n: 'Payment plan agreement form', where: 'Bill → Payment plan agreement', route: 'billing' },
        { n: 'Document payment exception', where: 'Bill → Document exception', route: 'billing' },
        { n: 'No cost, covered by assistance programme', where: 'Bill → Cover by assistance programme', route: 'billing' },
        { n: 'Schedule future appointments', where: 'Check-out → follow-up picker', route: 'billing' },
        { n: 'Patient leaves', where: 'Check-out issues an exit pass and messages a visit summary', route: 'billing' },
      ],
    },
  ];

  const EXTRAS = [
    ['✆ WhatsApp booking', 'Patients book, confirm, cancel and check report status in chat — every booking lands as an enquiry plus a confirmed appointment.', 'whatsapp'],
    ['⚗ Diagnostics workflow', 'Order → sample barcode → processing → result entry with automatic abnormal flagging → verification → report released to the patient.', 'lab'],
    ['⚕ Pharmacy', 'Batch and expiry stock, first-expiry-first-out allocation, allergy safety check, and the charge folded onto the same invoice.', 'pharmacy'],
    ['⌸ In-patient records', 'Bed board, admission, transfers, doctor rounds and nursing notes, medication administration record, accrued charges, discharge summary.', 'ipd'],
    ['◔ Turnaround analytics', 'Average minutes in each lane, so you can see exactly where the queue jams.', 'reports'],
    ['⚖ Sliding scale', 'Income against the poverty guideline gives an FPL percentage, a band, a discount, and the programmes the patient qualifies for.', 'financial'],
    ['⛨ Insurance & TPA', 'Policies with sum-insured, co-pay and room-rent caps; cashless pre-authorisation with queries and enhancements; claims from the bill through to settlement and receivables ageing.', 'insurance'],
  ];

  APP.register('workflow', {
    title: 'Workflow Map',
    subtitle: 'The clinic flowchart, and where each step lives in this system',

    async render(el) {
      el.innerHTML = `
        <div class="alert info mb">
          This mirrors the visit workflow chart lane by lane. Click any step to jump to the screen that handles it.
        </div>

        <div class="grid c4" style="align-items:start">
          ${LANES.map((lane) => `
            <div class="card">
              <div class="card-head" style="border-top:3px solid ${lane.colour};border-radius:var(--radius) var(--radius) 0 0">
                <h3>${UI.esc(lane.title)}</h3>
              </div>
              <div class="card-body">
                <ul class="timeline">
                  ${lane.steps.map((s) => `
                    <li${s.route ? ` style="cursor:pointer" data-route="${UI.esc(s.route)}"` : ''}>
                      <b>${s.decision ? '◆ ' : ''}${UI.esc(s.n)}</b>
                      ${s.where ? `<div class="muted small">→ ${UI.esc(s.where)}</div>` : ''}
                      ${s.note ? `<div class="muted small"><i>${UI.esc(s.note)}</i></div>` : ''}
                    </li>`).join('')}
                </ul>
              </div>
            </div>`).join('')}
        </div>

        <div class="card mt">
          <div class="card-head"><h3>Beyond the chart</h3>
            <span class="muted small">Added so the clinic can actually run on this</span></div>
          <div class="card-body">
            <div class="grid c3">
              ${EXTRAS.map(([title, text, route]) => `
                <div style="cursor:pointer" data-route="${UI.esc(route)}">
                  <h4 style="color:var(--crimson)">${UI.esc(title)}</h4>
                  <p class="muted small">${UI.esc(text)}</p>
                </div>`).join('')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Guardrails built into the flow</h3></div>
          <div class="card-body">
            <div class="grid c2">
              <ul class="small" style="padding-left:18px;line-height:1.9">
                <li>A visit cannot be checked out with money outstanding unless a <b>payment plan</b> or a
                    <b>documented exception</b> exists — the “No, or not completely” branch is enforced, not optional.</li>
                <li>A sliding-scale band cannot be assigned without <b>proof of income</b> on file.</li>
                <li>The pharmacy refuses to dispense more than the stock on hand, and warns on recorded allergies.</li>
                <li>A diagnostic report cannot be released until every test in the order has a result.</li>
              </ul>
              <ul class="small" style="padding-left:18px;line-height:1.9">
                <li>A bed cannot be double-booked, and a patient cannot be admitted twice.</li>
                <li>Two appointments cannot take the same slot with the same doctor.</li>
                <li>Discharge posts bed-day charges automatically and blocks on an unsettled bill.</li>
                <li>An insurer's approval sits on the bill as cover, so a cashless patient owes only their
                    own share — and any settlement <b>shortfall returns to their balance</b> automatically.</li>
                <li>A pre-authorisation cannot be approved beyond the sum insured left on the policy.</li>
                <li>Every state change is written to an immutable <b>visit trail</b> and the <b>audit log</b>.</li>
              </ul>
            </div>
          </div>
        </div>`;

      el.querySelectorAll('[data-route]').forEach((n) =>
        n.addEventListener('click', () => APP.navigate(n.dataset.route)));
    },
  });
})();
