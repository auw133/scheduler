require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Email ───────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function sendMail(to, subject, html) {
  try {
    await mailer.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// ─── Middleware ──────────────────────────────────────────────────
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: '*' })); // tighten to FRONTEND_URL in production
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Helpers ─────────────────────────────────────────────────────
function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function slotLabel(slot_id) {
  return slot_id === 'am' ? '9:00 AM – 12:00 PM' : '1:00 PM – 4:00 PM';
}

// "14:00:00" → "2:00 PM"
function fmtTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Generate every N-minute slot within an AM or PM block
// AM = 09:00–12:00, PM = 13:00–16:00
function generateSlots(slot_id, duration_min) {
  const [startH, endH] = slot_id === 'am' ? [9, 12] : [13, 16];
  const slots = [];
  for (let h = startH; h < endH; h++) {
    for (let m = 0; m < 60; m += duration_min) {
      // Don't add a slot that would run past the end of the block
      const totalMins = h * 60 + m + duration_min;
      if (totalMins > endH * 60) break;
      slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
  }
  return slots;
}

// ─── SERVICES ────────────────────────────────────────────────────

// GET /services — list active services (used by booking form)
app.get('/services', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration_min')
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /services/all — list all services including inactive (admin)
app.get('/services/all', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /services — create a new service (admin)
app.post('/services', async (req, res) => {
  const { name, duration_min } = req.body;
  if (!name || !duration_min) return res.status(400).json({ error: 'name and duration_min required' });
  const { data, error } = await supabase
    .from('services')
    .insert({ name, duration_min: Number(duration_min) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /services/:id — update a service (admin)
app.patch('/services/:id', async (req, res) => {
  const { name, duration_min, active } = req.body;
  const updates = {};
  if (name !== undefined)         updates.name = name;
  if (duration_min !== undefined) updates.duration_min = Number(duration_min);
  if (active !== undefined)       updates.active = active;
  const { data, error } = await supabase
    .from('services').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── AVAILABILITY ─────────────────────────────────────────────────

// GET /availability?start=YYYY-MM-DD&end=YYYY-MM-DD&service_id=xxx
// Returns which date+slot_id combos are FULLY booked for a given service
// so the frontend knows what to grey out
app.get('/availability', async (req, res) => {
  const { start, end, service_id } = req.query;
  if (!start || !end || !service_id) {
    return res.status(400).json({ error: 'start, end, service_id required' });
  }

  // Get the service duration
  const { data: svc } = await supabase
    .from('services').select('duration_min').eq('id', service_id).single();
  if (!svc) return res.status(404).json({ error: 'Service not found' });

  // Get confirmed/paid/pending bookings for this service in the date range
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('date, slot_id, confirmed_start')
    .eq('service_id', service_id)
    .gte('date', start)
    .lte('date', end)
    .in('status', ['pending', 'confirmed', 'paid']);

  if (error) return res.status(500).json({ error: error.message });

  // For each date+slot combo, check if ALL time slots are taken
  // Group taken confirmed_starts by date+slot
  const taken = {}; // "2024-05-11-am" => Set of "09:00", "09:15", ...
  for (const b of bookings) {
    if (!b.confirmed_start) {
      // Pending (no confirmed_start yet) — count as 1 pending per slot_id
      const k = `${b.date}-${b.slot_id}-pending`;
      taken[k] = (taken[k] || 0) + 1;
    } else {
      const k = `${b.date}-${b.slot_id}`;
      if (!taken[k]) taken[k] = new Set();
      taken[k].add(b.confirmed_start.substring(0, 5)); // "09:00"
    }
  }

  // Build list of fully-booked date+slot combos
  const fullyBooked = [];
  // Enumerate all date+slot combos in range
  const d = new Date(start + 'T12:00:00');
  const endD = new Date(end + 'T12:00:00');
  while (d <= endD) {
    const dateStr = d.toISOString().split('T')[0];
    for (const slot_id of ['am', 'pm']) {
      const allSlots = generateSlots(slot_id, svc.duration_min);
      const key = `${dateStr}-${slot_id}`;
      const takenSet = taken[key];
      // Fully booked if every possible slot has a booking
      if (takenSet instanceof Set && allSlots.every(s => takenSet.has(s))) {
        fullyBooked.push({ date: dateStr, slot_id });
      }
    }
    d.setDate(d.getDate() + 1);
  }

  res.json(fullyBooked);
});

// GET /available-times?date=YYYY-MM-DD&slot_id=am&service_id=xxx
// Returns available start times within a block for admin to assign
app.get('/available-times', async (req, res) => {
  const { date, slot_id, service_id } = req.query;
  if (!date || !slot_id || !service_id) {
    return res.status(400).json({ error: 'date, slot_id, service_id required' });
  }

  const { data: svc } = await supabase
    .from('services').select('duration_min').eq('id', service_id).single();
  if (!svc) return res.status(404).json({ error: 'Service not found' });

  const allSlots = generateSlots(slot_id, svc.duration_min);

  // Find taken slots for this service on this date+slot
  const { data: bookings } = await supabase
    .from('bookings')
    .select('confirmed_start')
    .eq('date', date)
    .eq('slot_id', slot_id)
    .eq('service_id', service_id)
    .in('status', ['confirmed', 'paid']);

  const takenTimes = new Set(
    (bookings || [])
      .filter(b => b.confirmed_start)
      .map(b => b.confirmed_start.substring(0, 5))
  );

  const available = allSlots.filter(s => !takenTimes.has(s));
  res.json(available);
});

// ─── BOOKINGS ────────────────────────────────────────────────────

// POST /bookings — customer submits a reservation request
app.post('/bookings', async (req, res) => {
  const { date, slot_id, service_id, first_name, last_name, email, phone, notes } = req.body;
  if (!date || !slot_id || !service_id || !first_name || !last_name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Get service info
  const { data: svc } = await supabase
    .from('services').select('name, duration_min').eq('id', service_id).single();
  if (!svc) return res.status(404).json({ error: 'Service not found' });

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({ date, slot_id, service_id, first_name, last_name, email, phone, notes, status: 'pending' })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Email customer
  await sendMail(email, 'We received your appointment request', `
    <p>Hi ${first_name},</p>
    <p>We've received your request for <strong>${svc.name}</strong> on 
    <strong>${formatDate(date)}</strong> (${slotLabel(slot_id)}).</p>
    <p>We'll confirm your exact time within 24 hours. Once confirmed, you'll receive 
    a payment link to secure your spot with a <strong>$20 non-refundable deposit</strong>.</p>
    <p>Thanks for booking with us!</p>
  `);

  // Email business owner
  await sendMail(process.env.EMAIL_USER,
    `New booking: ${svc.name} — ${formatDate(date)} ${slotLabel(slot_id)}`, `
    <p><strong>${first_name} ${last_name}</strong> has requested:</p>
    <ul>
      <li>Service: <strong>${svc.name}</strong> (${svc.duration_min} min)</li>
      <li>Date: ${formatDate(date)}</li>
      <li>Block: ${slotLabel(slot_id)}</li>
      <li>Email: ${email}</li>
      <li>Phone: ${phone || 'not provided'}</li>
      <li>Notes: ${notes || 'none'}</li>
    </ul>
    <p><a href="${process.env.FRONTEND_URL}/admin.html">Open Admin Panel →</a></p>
  `);

  res.status(201).json({ id: booking.id, status: 'pending' });
});

// POST /bookings/:id/confirm — admin confirms with a specific start time
app.post('/bookings/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const { confirmed_start } = req.body; // e.g. "14:00"
  if (!confirmed_start) return res.status(400).json({ error: 'confirmed_start required' });

  const { data: booking, error } = await supabase
    .from('bookings').select('*').eq('id', id).single();
  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'pending') {
    return res.status(400).json({ error: `Booking is already ${booking.status}` });
  }

  // Get service for display
  const { data: svc } = await supabase
    .from('services').select('name, duration_min').eq('id', booking.service_id).single();

  const startLabel = fmtTime(confirmed_start);
  // Calculate end time
  const [h, m] = confirmed_start.split(':').map(Number);
  const endMins = h * 60 + m + (svc?.duration_min || 60);
  const endLabel = fmtTime(`${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`);

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${svc?.name || 'Appointment'} Deposit`,
          description: `${formatDate(booking.date)} at ${startLabel}`,
        },
        unit_amount: 2000,
      },
      quantity: 1,
    }],
    mode: 'payment',
    customer_email: booking.email,
    metadata: { booking_id: booking.id },
    success_url: `${process.env.FRONTEND_URL}/success.html?booking=${booking.id}`,
    cancel_url: `${process.env.FRONTEND_URL}/pay.html?booking=${booking.id}`,
  });

  // Update booking
  await supabase.from('bookings')
    .update({ status: 'confirmed', confirmed_start, stripe_session_id: session.id })
    .eq('id', id);

  // Email customer with confirmed time
  await sendMail(booking.email, `Your ${svc?.name} appointment is confirmed`, `
    <p>Hi ${booking.first_name},</p>
    <p>Great news! Your <strong>${svc?.name}</strong> appointment is confirmed:</p>
    <p style="font-size:18px; margin: 16px 0;">
      📅 <strong>${formatDate(booking.date)}</strong><br/>
      🕐 <strong>Your appointment at ${startLabel} is confirmed</strong>
      ${svc?.duration_min ? `(until ${endLabel})` : ''}
    </p>
    <p>Please pay the <strong>$20 non-refundable deposit</strong> to lock in your spot:</p>
    <p>
      <a href="${session.url}" 
         style="background:#1a3a2a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">
        Pay $20 Deposit →
      </a>
    </p>
    <p style="color:#888;font-size:13px">This deposit is non-refundable. Reply to this email with any questions.</p>
  `);

  res.json({ status: 'confirmed', confirmed_start, payment_url: session.url });
});

// GET /bookings/:id
app.get('/bookings/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, date, slot_id, confirmed_start, service_id, first_name, status')
    .eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// GET /admin/bookings — admin list
app.get('/admin/bookings', async (req, res) => {
  const { status, date } = req.query;
  let query = supabase
    .from('bookings')
    .select('id, date, slot_id, confirmed_start, service_id, first_name, last_name, email, phone, notes, status, created_at, services(name, duration_min)')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (status) query = query.eq('status', status);
  if (date)   query = query.eq('date', date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── STRIPE WEBHOOK ──────────────────────────────────────────────
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { data: booking } = await supabase
      .from('bookings')
      .update({ status: 'paid', stripe_payment_id: session.payment_intent })
      .eq('id', session.metadata.booking_id)
      .select('*, services(name, duration_min)').single();

    if (booking) {
      const startLabel = fmtTime(booking.confirmed_start);
      await sendMail(booking.email, 'Payment received — you\'re all set!', `
        <p>Hi ${booking.first_name},</p>
        <p>We've received your $20 deposit. Your <strong>${booking.services?.name}</strong> 
        appointment on <strong>${formatDate(booking.date)}</strong> at 
        <strong>${startLabel}</strong> is fully confirmed.</p>
        <p>We look forward to seeing you!</p>
      `);
    }
  }

  res.json({ received: true });
});

// ─── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Scheduler backend running on port ${PORT}`));
