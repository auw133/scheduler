# Appointment Scheduler — Setup Guide

A full-stack booking system with Supabase (database), Stripe (payments), and email notifications.

## Project Structure

```
scheduler/
├── backend/
│   ├── server.js          ← Express API (main file)
│   ├── admin-routes.js    ← Paste this block into server.js
│   ├── schema.sql         ← Run this in Supabase SQL editor
│   ├── package.json
│   └── .env.example       ← Copy to .env and fill in your keys
└── frontend/
    └── public/
        ├── index.html     ← Customer-facing booking page
        └── admin.html     ← Your private admin panel
```

---

## Step 1 — Supabase (Database)

1. Go to https://supabase.com and create a free account
2. Create a new project (choose any region close to you)
3. Once created, go to **SQL Editor → New query**
4. Paste the contents of `backend/schema.sql` and click **Run**
5. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 2 — Stripe (Payments)

1. Go to https://stripe.com and create a free account
2. In the Stripe Dashboard, go to **Developers → API keys**
3. Copy your **Secret key** (starts with `sk_test_...`) → `STRIPE_SECRET_KEY`
4. To set up the webhook (so Stripe tells you when payment is complete):
   - Go to **Developers → Webhooks → Add endpoint**
   - URL: `https://your-backend-url.com/webhooks/stripe`
   - Select event: `checkout.session.completed`
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`

> **While testing locally**, use the Stripe CLI:
> ```bash
> stripe listen --forward-to localhost:3001/webhooks/stripe
> ```
> This lets you test payments without deploying.

---

## Step 3 — Email (Gmail)

1. Make sure your Gmail account has **2-Factor Authentication** enabled
2. Go to https://myaccount.google.com/apppasswords
3. Create an app password (name it "Scheduler")
4. Copy the 16-character password → `EMAIL_PASS`
5. Set `EMAIL_USER` to your Gmail address

---

## Step 4 — Configure .env

```bash
cd backend
cp .env.example .env
# Now edit .env with your actual keys
```

---

## Step 5 — Install and Run

```bash
cd backend
npm install
npm run dev   # starts on http://localhost:3001
```

Open `frontend/public/index.html` in your browser (or serve it):
```bash
# Simple way to serve frontend locally:
cd frontend/public
npx serve .
# Open http://localhost:3000
```

---

## Step 6 — Add the Admin Route

Open `backend/server.js` and paste the contents of `admin-routes.js`
just before the `app.listen(...)` line at the bottom.

Visit `http://localhost:3000/admin.html` to manage bookings.

---

## Customer Booking Flow

1. **Customer** picks a time block on `index.html`
2. **Customer** fills in their name, email, phone
3. **Backend** saves booking as `pending`, emails customer + emails you
4. **You** open `admin.html`, find the pending booking, click "Confirm & Send link"
5. **Backend** creates a Stripe Checkout session, emails customer the payment link
6. **Customer** pays $20 via Stripe's hosted checkout page
7. **Stripe** fires a webhook → backend marks booking as `paid`, sends receipt email
8. **Customer** lands on success page

---

## Deploying to Production

### Backend (choose one)
- **Railway** (easiest): https://railway.app → New project → Deploy from GitHub
- **Render**: https://render.com → New Web Service → connect your repo
- **VPS** (DigitalOcean/Linode): install Node.js, run with `pm2 start server.js`

### Frontend
Since it's plain HTML, host anywhere:
- **Netlify**: drag & drop the `frontend/public` folder at https://app.netlify.com
- **Vercel**: `npx vercel` inside `frontend/public`
- **GitHub Pages**: push to a repo, enable Pages

### After deploying
1. Update `FRONTEND_URL` in `.env` to your real frontend URL
2. Update `const API = '...'` in both HTML files to your backend URL
3. Update your Stripe webhook URL to your real backend URL

---

## Protecting Admin Panel

The admin panel (`admin.html`) is currently open to anyone with the URL.
Before going live, add basic password protection to the `/admin/bookings` route:

```js
// Simple bearer token check — add to server.js
app.use('/admin', (req, res, next) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```

Then add `ADMIN_SECRET=your-random-password` to `.env`.

---

## Customizing Time Slots

Edit the `SLOT_DEFS` array in `index.html` and `SLOT_DEFS` in `admin-routes.js`
to change available time blocks. The database stores `slot_id` as `'am'` or `'pm'`
but you can extend this to any string (e.g. `'morning'`, `'slot-1'`, `'10am'`).

---

## Deposit Amount

The deposit is $20 (2000 cents). To change it:
- In `server.js`, find `unit_amount: 2000` and update the value
- Update any text in `index.html` that says "$20"
# scheduler
