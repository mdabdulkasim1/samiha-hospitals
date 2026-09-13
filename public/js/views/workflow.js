/* Workflow map — the clinic flowchart, annotated with where each step lives. */
(function () {
  'use strict';

  /*
   * The clinic is paid as the patient goes, and the map is drawn that way: the
   * counter appears twice on purpose, once on the way in for the consultation
   * and once after the doctor for anything they ordered. Everything a patient
   * cannot proceed without is marked as a gate, because those are the steps
   * the system actually refuses to let anyone skip.
   */
  const LANES = [
    {
      key: 'checkin', title: '1 · Front desk', colour: 'var(--teal)',
      steps: [
        { n: 'Patient walks in, or arrives for an appointment', where: 'Queue → + Patient arrived', route: 'queue' },
        { n: 'New patient?', decision: true, note: 'Yes → demographic & medical-history paperwork first.' },
        { n: 'Demographic, med. history paperwork', where: 'Patients → Register patient', route: 'patients' },
        { n: 'Check in · ask reason for visit', where: 'Queue → visit card → Check in', route: 'queue' },
        { n: 'Uninsured or circumstances changed?', decision: true,
          note: 'Flagged for the counsellor — it does not hold the patient up.' },
      ],
    },
    {
      key: 'fee', title: '2 · Cashier — consultation fee', colour: 'var(--orange)',
      steps: [
        { n: 'Collect the consultation fee', where: 'Queue → visit card → Collect consultation fee', route: 'queue' },
        { n: 'Charged at the rate on the card', where: 'Services & Rates → CONS-NEW / CONS-FU', route: 'rates' },
        { n: 'A band or programme comes off here', where: 'Applied before the money is taken, never refunded after', route: 'financial' },
        { n: 'Receipt printed, patient sent to the nurse', where: 'Receipt shows what the bill covers', route: 'billing' },
        { n: 'GATE · no fee, no nurse station', gate: true,
          note: 'The nurse station refuses a visit the counter has not taken the fee for.' },
      ],
    },
    {
      key: 'exam', title: '3 · Nurse & doctor', colour: 'var(--crimson)',
      steps: [
        { n: 'Nurse station · check vitals', where: 'Nurse Station', route: 'vitals' },
        { n: 'Patient to the doctor', where: 'Consultation → My patients today', route: 'consult' },
        { n: 'Why they came, on the record', where: 'Consultation → patient summary', route: 'consult' },
        { n: 'Clinical care · SOAP note, diagnoses, prescription', where: 'Consultation', route: 'consult' },
        { n: 'Order any tests', where: 'Consultation → Order tests (no rates on the form)', route: 'consult' },
        { n: 'Any tests ordered?', decision: true,
          note: 'Yes → back to the cashier (lane 4). No → straight to the pharmacy (lane 6).' },
      ],
    },
    {
      key: 'dxpay', title: '4 · Cashier — the tests', colour: 'var(--orange)',
      steps: [
        { n: 'The order arrives with names and no prices', where: 'Billing → Tests to price', route: 'billing' },
        { n: 'Cashier sets a rate against each line', where: 'Prefilled from the tariff, typed where there is none', route: 'billing' },
        { n: 'Posted to the bill and paid in full', where: 'Billing → Accept payment', route: 'billing' },
        { n: 'GATE · no receipt, no test', gate: true,
          note: 'Collect, start, result and verify all refuse an order that has not been paid for. An in-patient\'s tests go on the stay instead; the cashier can wave an emergency through, recorded as a waiver.' },
      ],
    },
    {
      key: 'lab', title: '5 · Diagnostics', colour: 'var(--teal)',
      steps: [
        { n: 'Paid orders appear on the bench worklist', where: 'Diagnostics → Orders', route: 'lab' },
        { n: 'Unpaid ones sit below, greyed and unopenable', where: 'Diagnostics → At the cash counter', route: 'lab' },
        { n: 'Sample collected and labelled', where: 'Diagnostics → Collect sample', route: 'lab' },
        { n: 'Results entered, abnormals flagged automatically', where: 'Diagnostics → Enter results', route: 'lab' },
        { n: 'Verified and reported', where: 'Report signed by the lab in-charge, referring doctor named', route: 'lab' },
      ],
    },
    {
      key: 'pharmacy', title: '6 · Pharmacy, and out', colour: 'var(--ok)',
      steps: [
        { n: 'Prescription waiting at the counter', where: 'Pharmacy → Dispensing queue', route: 'pharmacy' },
        { n: 'Medicines dispensed and paid for here', where: 'At the MRP on the pack that was handed over', route: 'pharmacy' },
        { n: 'Follow-up booked', where: 'Check-out → follow-up picker', route: 'billing' },
        { n: 'Patient leaves', where: 'Check-out issues an exit pass and messages a visit summary', route: 'billing' },
      ],
    },
    {
      key: 'finance', title: 'Alongside · Financial assistance', colour: 'var(--ink-3)',
      steps: [
        { n: 'Not a lane anybody is walked down', note: 'Offered when the clinic decides to, at any point in the visit.', decision: true },
        { n: 'Start a screening', where: 'Financial Assistance → Start screening', route: 'financial' },
        { n: 'Proof of income on file?', decision: true, note: 'No → held at “documents pending”; no band can be assigned.' },
        { n: 'Income against the poverty line → band A–F', where: 'Screening worksheet', route: 'financial' },
        { n: 'Assistance programmes the patient qualifies for', where: 'Screening worksheet → programme list', route: 'financial' },
        { n: 'The band applies to bills from then on', where: 'Taken off at the counter, not refunded afterwards', route: 'financial' },
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
          The walk through the building, lane by lane. The clinic is paid as the patient goes, so the
          cashier appears twice — once on the way in for the consultation, once after the doctor for
          anything ordered. A <b style="color:var(--danger)">⛔ gate</b> is a step the system refuses to
          let anyone past. Click any step to jump to the screen that handles it.
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
                      <b${s.gate ? ' style="color:var(--danger)"' : ''}>${
                        s.gate ? '⛔ ' : (s.decision ? '◆ ' : '')}${UI.esc(s.n)}</b>
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
