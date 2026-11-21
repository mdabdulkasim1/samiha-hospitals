'use strict';
const mysql = require('mysql2/promise');

async function main() {
  console.log('='.repeat(70));
  console.log('  FIXING & SYNCHRONIZING ALL MISSING MASTERS TO 76.13.243.217');
  console.log('='.repeat(70));

  const localConn = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'samiha-polyclinic',
    dateStrings: true,
  });

  const remoteConn = await mysql.createConnection({
    host: '76.13.243.217',
    user: 'samihahospitals_app_user',
    password: 'bka@6202#db',
    database: 'samihahospitals_app_db',
    dateStrings: true,
  });

  await remoteConn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    // 1. Activate all Services (Consultations, Nursing Procedures, ECG, Nebulisation, etc.)
    console.log('\n[1/7] Activating all Services...');
    const [srvRes] = await remoteConn.query('UPDATE services SET active = 1');
    console.log(`  ✔ services updated: ${srvRes.affectedRows} set to active = 1`);

    // 2. Activate all Wards & Beds
    console.log('\n[2/7] Activating Wards & Beds...');
    const [wardRes] = await remoteConn.query('UPDATE wards SET active = 1');
    const [bedRes] = await remoteConn.query("UPDATE beds SET active = 1, status = COALESCE(status, 'vacant')");
    console.log(`  ✔ wards updated: ${wardRes.affectedRows} set to active = 1`);
    console.log(`  ✔ beds updated: ${bedRes.affectedRows} set to active = 1 with valid status`);

    // 3. Activate all Insurers & TPAs
    console.log('\n[3/7] Activating Insurers...');
    const [insRes] = await remoteConn.query('UPDATE insurers SET active = 1');
    console.log(`  ✔ insurers updated: ${insRes.affectedRows} set to active = 1`);

    // 4. Activate Financial Assistance & Sliding Scale Bands
    console.log('\n[4/7] Activating Financial Assistance & Sliding Scale...');
    const [asstRes] = await remoteConn.query('UPDATE assistance_programs SET active = 1');
    const [scaleRes] = await remoteConn.query('UPDATE sliding_scale_bands SET active = 1');
    console.log(`  ✔ assistance_programs updated: ${asstRes.affectedRows} set to active = 1`);
    console.log(`  ✔ sliding_scale_bands updated: ${scaleRes.affectedRows} set to active = 1`);

    // 5. Activate Clinical Departments (Urology, Diabetology, Radiology)
    console.log('\n[5/7] Activating All Clinical Departments...');
    const [deptRes] = await remoteConn.query('UPDATE departments SET active = 1');
    console.log(`  ✔ departments updated: ${deptRes.affectedRows} set to active = 1`);

    // 6. Clean empty ghost assets and sync 62 real hospital assets
    console.log('\n[6/7] Syncing Assets & Equipment Registry...');
    await remoteConn.query('DELETE FROM assets WHERE name IS NULL OR asset_no IS NULL');
    const [localAssets] = await localConn.query('SELECT * FROM assets WHERE active = 1');
    if (localAssets.length > 0) {
      const cols = Object.keys(localAssets[0]);
      const colList = cols.map((c) => `\`${c}\``).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insertSql = `INSERT INTO assets (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE name=VALUES(name), active=VALUES(active), status=VALUES(status)`;

      for (const a of localAssets) {
        const vals = cols.map((c) => (a[c] === undefined ? null : a[c]));
        await remoteConn.query(insertSql, vals);
      }
    }
    const [assetVerify] = await remoteConn.query('SELECT COUNT(*) AS c FROM assets WHERE active = 1');
    console.log(`  ✔ assets: ${assetVerify[0].c} real active assets confirmed on remote`);

    // 7. Sync Quality & Governance (Hygiene rounds & Safety incidents)
    console.log('\n[7/7] Syncing Quality & Governance baseline registers...');
    const [localSafety] = await localConn.query('SELECT * FROM safety_incidents');
    for (const r of localSafety) {
      await remoteConn.query(
        `INSERT IGNORE INTO safety_incidents (id, ref_no, happened_on, happened_at, patient_id, department_id, location, kind, harm, detail, immediate_action, root_cause, corrective_action, owner_name, due_date, status, closed_on, reported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.ref_no, r.happened_on, r.happened_at, r.patient_id, r.department_id, r.location, r.kind, r.harm, r.detail, r.immediate_action, r.root_cause, r.corrective_action, r.owner_name, r.due_date, r.status, r.closed_on, r.reported_by]
      );
    }
    const [localHygiene] = await localConn.query('SELECT * FROM hygiene_rounds');
    for (const r of localHygiene) {
      await remoteConn.query(
        `INSERT IGNORE INTO hygiene_rounds (id, on_date, shift, area, kind, score, passed, issues, action_taken, done_by, verified_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.on_date, r.shift, r.area, r.kind, r.score, r.passed, r.issues, r.action_taken, r.done_by, r.verified_by]
      );
    }
    console.log('  ✔ safety_incidents & hygiene_rounds synced');

    console.log('\n' + '='.repeat(70));
    console.log('  ALL MISSING MASTERS & CONFIGURATIONS SUCCESSFULLY SYNCHRONIZED!');
    console.log('='.repeat(70) + '\n');
  } finally {
    await remoteConn.query('SET FOREIGN_KEY_CHECKS = 1');
    await localConn.end();
    await remoteConn.end();
  }
}

main().catch((err) => {
  console.error('Master sync failed:', err);
  process.exit(1);
});
