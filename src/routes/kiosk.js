'use strict';
/**
 * Public Kiosk / TV Display API.
 * Unauthenticated so Smart TVs and kiosk displays can run 24/7 without session expiration.
 */
const express = require('express');
const { db } = require('../db');
const config = require('../config');

const router = express.Router();

function maskName(name) {
  if (!name || typeof name !== 'string') return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    const n = parts[0];
    return n.length <= 3 ? n : `${n.slice(0, 3)}***`;
  }
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0] || '';
  return `${first} ${lastInitial}.***`;
}

router.get('/queue', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const date = (req.query.date && typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : today;

    // Optional URL filtering: ?rooms=OPD-1,OPD-2 or ?dept=General Medicine,Pediatrics
    const filterRooms = req.query.rooms
      ? String(req.query.rooms).split(',').map((s) => s.trim().toUpperCase())
      : null;
    const filterDept = req.query.dept
      ? String(req.query.dept).split(',').map((s) => s.trim().toLowerCase())
      : null;

    // Fetch all active doctors with room numbers and departments
    const doctors = db.prepare(`
      SELECT u.id AS doctor_id,
             u.name AS doctor_name,
             d.name AS department_name,
             d.code AS department_code,
             COALESCE(dp.room_no, 'OPD-' || u.id) AS room_no,
             dp.specialization
        FROM users u
        LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
        LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.role = 'doctor' AND u.active = 1
       ORDER BY dp.room_no ASC, u.name ASC
    `).all();

    // Fetch all visits today with patient details and timestamps
    const allVisits = db.prepare(`
      SELECT v.id,
             v.token_no,
             v.status,
             v.doctor_id,
             v.arrived_at,
             COALESCE(v.consult_start_at, v.arrived_at) AS called_at,
             (p.first_name || ' ' || COALESCE(p.last_name, '')) AS patient_name,
             p.uhid,
             p.gender,
             p.age_years
        FROM visits v
        JOIN patients p ON p.id = v.patient_id
       WHERE date(v.arrived_at) = ?
       ORDER BY v.token_no ASC, v.id ASC
    `).all(date);

    // Group visits by doctor
    const visitsByDoctor = new Map();
    const unassignedVisits = [];

    for (const v of allVisits) {
      if (v.doctor_id) {
        if (!visitsByDoctor.has(v.doctor_id)) visitsByDoctor.set(v.doctor_id, []);
        visitsByDoctor.get(v.doctor_id).push(v);
      } else {
        unassignedVisits.push(v);
      }
    }

    let rooms = [];

    for (const doc of doctors) {
      const docVisits = visitsByDoctor.get(doc.doctor_id) || [];
      const servingList = docVisits.filter((v) => v.status === 'with_provider');
      const current = servingList.length > 0 ? servingList[servingList.length - 1] : null;

      const waiting = docVisits.filter((v) =>
        ['waiting_room', 'checked_in', 'vitals_done'].includes(v.status)
      );

      const completed = docVisits.filter((v) =>
        ['billing_pending', 'labs_pending', 'pharmacy_pending', 'checked_out'].includes(v.status)
      );

      rooms.push({
        doctorId: doc.doctor_id,
        doctorName: doc.doctor_name,
        department: doc.department_name || 'General OPD',
        specialization: doc.specialization || '',
        roomNo: doc.room_no,
        status: current ? 'serving' : (waiting.length > 0 ? 'available' : 'idle'),
        nowServing: current ? {
          visitId: current.id,
          tokenNo: current.token_no,
          patientName: current.patient_name.trim(),
          maskedName: maskName(current.patient_name),
          uhid: current.uhid,
          gender: current.gender,
          age: current.age_years,
          calledAt: current.called_at,
        } : null,
        waiting: waiting.map((w) => ({
          visitId: w.id,
          tokenNo: w.token_no,
          patientName: w.patient_name.trim(),
          maskedName: maskName(w.patient_name),
          uhid: w.uhid,
          status: w.status,
        })),
        totalWaiting: waiting.length,
        totalCompleted: completed.length,
      });
    }

    // Apply URL room or department filter if requested
    if (filterRooms && filterRooms.length > 0) {
      rooms = rooms.filter((r) => filterRooms.includes(String(r.roomNo).toUpperCase()));
    }
    if (filterDept && filterDept.length > 0) {
      rooms = rooms.filter((r) => filterDept.some((d) => String(r.department).toLowerCase().includes(d)));
    }

    // If there are unassigned visits and no specific doctor filter, show a general intake counter
    if (!filterRooms && !filterDept && unassignedVisits.length > 0) {
      const current = unassignedVisits.find((v) => v.status === 'checked_in');
      const waiting = unassignedVisits.filter((v) => ['waiting_room', 'checked_in'].includes(v.status));
      rooms.unshift({
        doctorId: 0,
        doctorName: 'Triage / Reception',
        department: 'Front Desk',
        specialization: 'Patient Intake',
        roomNo: 'COUNTER-1',
        status: current ? 'serving' : 'available',
        nowServing: current ? {
          visitId: current.id,
          tokenNo: current.token_no,
          patientName: current.patient_name.trim(),
          maskedName: maskName(current.patient_name),
          uhid: current.uhid,
          calledAt: current.called_at,
        } : null,
        waiting: waiting.map((w) => ({
          visitId: w.id,
          tokenNo: w.token_no,
          patientName: w.patient_name.trim(),
          maskedName: maskName(w.patient_name),
          uhid: w.uhid,
        })),
        totalWaiting: waiting.length,
        totalCompleted: 0,
      });
    }

    // Sort rooms: rooms currently serving or waiting come first
    rooms.sort((a, b) => {
      const weight = (r) => (r.status === 'serving' ? 2 : (r.totalWaiting > 0 ? 1 : 0));
      return weight(b) - weight(a);
    });

    res.json({
      ok: true,
      clinic: {
        name: config.clinic.name,
        phone: config.clinic.phone,
        whatsapp: config.clinic.whatsappNumber,
        address: config.clinic.address,
      },
      date,
      serverTime: new Date().toISOString(),
      stats: {
        totalServing: allVisits.filter((v) => v.status === 'with_provider').length,
        totalWaiting: allVisits.filter((v) => ['waiting_room', 'checked_in', 'vitals_done'].includes(v.status)).length,
        totalCompleted: allVisits.filter((v) => ['billing_pending', 'labs_pending', 'pharmacy_pending', 'checked_out'].includes(v.status)).length,
      },
      rooms,
    });
  } catch (err) {
    console.error('[kiosk-queue-error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
