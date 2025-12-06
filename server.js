const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, hashPassword } = require('./db');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;
const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  session({
    // Use env override in production; fallback is for local dev only
    secret: process.env.SESSION_SECRET || 'super-secret-session-key',
    resave: false,
    saveUninitialized: false,
  })
);

// Stripe webhook expects raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      return res.status(400).send('Stripe not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const brandId = Number(metadata.brand_id);
      const planType = metadata.plan_type;
      if (brandId && ['MONTHLY', 'ANNUAL'].includes(planType)) {
        const amount = planType === 'MONTHLY' ? 49 : 499;
        const now = timestamp();
        const renewal = planType === 'MONTHLY' ? addMonths(new Date(), 1) : addYears(new Date(), 1);
        const existing = db.prepare('SELECT * FROM subscriptions WHERE brand_id = ?').get(brandId);
        if (existing) {
          db.prepare(`UPDATE subscriptions SET plan_type = ?, status = 'ACTIVE', renewal_date = ?, updated_at = ? WHERE id = ?`)
            .run(planType, renewal, now, existing.id);
        } else {
          db.prepare(`INSERT INTO subscriptions (brand_id, plan_type, status, renewal_date, created_at, updated_at)
            VALUES (?, ?, 'ACTIVE', ?, ?, ?)
          `).run(brandId, planType, renewal, now, now);
        }
        db.prepare(
          `INSERT INTO invoices (brand_id, amount, plan_type, due_date, status, created_at)
           VALUES (?, ?, ?, ?, 'PAID', ?)`
        ).run(brandId, amount, planType, renewal, now);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const timestamp = () => new Date().toISOString();

function requireBrand(req, res, next) {
  if (!req.session.brandId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin only' });
  next();
}

// Auth: Brand register
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, contact_name, description, supply_chain_overview } = req.body;
  if (!name || !email || !password || !supply_chain_overview) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const now = timestamp();
    db.prepare(
      `INSERT INTO brands (name, email, password_hash, contact_name, description, story, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?)`
    ).run(
      name,
      email,
      hashPassword(password),
      contact_name || '',
      description || '',
      supply_chain_overview || '',
      now,
      now
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Auth: Brand login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const brand = db.prepare('SELECT * FROM brands WHERE email = ?').get(email);
  if (!brand || brand.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (brand.status === 'REJECTED') {
    return res.status(403).json({ error: 'Your application was rejected' });
  }
  req.session.brandId = brand.id;
  res.json({ success: true, status: brand.status, pending: brand.status === 'PENDING_APPROVAL' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);
  if (!admin || admin.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.isAdmin = true;
  req.session.adminId = admin.id;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Brand profile routes
app.get('/api/brand/me', requireBrand, (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.session.brandId);
  if (!brand) return res.status(404).json({ error: 'Not found' });
  const { password_hash, ...clean } = brand;
  res.json(clean);
});

app.put('/api/brand/me', requireBrand, (req, res) => {
  const allowed = ['name', 'description', 'logo_url', 'story', 'categories', 'contact_name'];
  const updates = [];
  const values = [];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(timestamp());
  values.push(req.session.brandId);
  const stmt = `UPDATE brands SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(stmt).run(...values);
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.session.brandId);
  const { password_hash, ...clean } = brand;
  res.json(clean);
});

app.post('/api/brand/deactivate', requireBrand, (req, res) => {
  db.prepare("UPDATE brands SET status = 'INACTIVE', updated_at = ? WHERE id = ?").run(timestamp(), req.session.brandId);
  res.json({ success: true, status: 'INACTIVE' });
});

app.post('/api/brand/request-reactivation', requireBrand, (req, res) => {
  const brand = db.prepare('SELECT status FROM brands WHERE id = ?').get(req.session.brandId);
  if (!brand || brand.status !== 'INACTIVE') {
    return res.status(400).json({ error: 'Only inactive accounts can request reactivation' });
  }
  db.prepare("UPDATE brands SET status = 'REACTIVATION_PENDING', updated_at = ? WHERE id = ?").run(timestamp(), req.session.brandId);
  res.json({ success: true, status: 'REACTIVATION_PENDING' });
});

// Supply chain points (brand)
app.get('/api/brand/supply-points', requireBrand, (req, res) => {
  const points = db.prepare('SELECT * FROM supply_chain_points WHERE brand_id = ?').all(req.session.brandId);
  res.json(points);
});

app.post('/api/brand/supply-points', requireBrand, (req, res) => {
  const { title, description, address, latitude, longitude, ethical_highlight, photo_url } = req.body;
  const now = timestamp();
  db.prepare(`INSERT INTO supply_chain_points (brand_id, title, description, address, latitude, longitude, ethical_highlight, photo_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, ?)
  `).run(req.session.brandId, title || '', description || '', address || '', latitude || null, longitude || null, ethical_highlight || '', photo_url || '', now, now);
  res.json({ success: true });
});

app.put('/api/brand/supply-points/:id', requireBrand, (req, res) => {
  const point = db.prepare('SELECT * FROM supply_chain_points WHERE id = ? AND brand_id = ?').get(req.params.id, req.session.brandId);
  if (!point) return res.status(404).json({ error: 'Not found' });
  if (!['PENDING_REVIEW', 'REJECTED'].includes(point.status)) {
    return res.status(400).json({ error: 'Cannot edit approved point' });
  }
  const fields = ['title', 'description', 'address', 'latitude', 'longitude', 'ethical_highlight', 'photo_url'];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No updates supplied' });
  values.push(timestamp());
  values.push(req.params.id);
  const stmt = `UPDATE supply_chain_points SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(stmt).run(...values);
  res.json({ success: true });
});

app.delete('/api/brand/supply-points/:id', requireBrand, (req, res) => {
  const point = db.prepare('SELECT * FROM supply_chain_points WHERE id = ? AND brand_id = ?').get(req.params.id, req.session.brandId);
  if (!point) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM supply_chain_points WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Subscription endpoints
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString();
}

app.get('/api/brand/subscription', requireBrand, (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE brand_id = ?').get(req.session.brandId);
  res.json(sub || null);
});

app.post('/api/brand/subscription', requireBrand, (req, res) => {
  const { plan_type } = req.body;
  if (!['MONTHLY', 'ANNUAL'].includes(plan_type)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  const existing = db.prepare('SELECT * FROM subscriptions WHERE brand_id = ?').get(req.session.brandId);
  const now = timestamp();
  const renewal = plan_type === 'MONTHLY' ? addMonths(new Date(), 1) : addYears(new Date(), 1);
  if (existing) {
    db.prepare(`UPDATE subscriptions SET plan_type = ?, status = 'ACTIVE', renewal_date = ?, updated_at = ? WHERE id = ?`)
      .run(plan_type, renewal, now, existing.id);
  } else {
    db.prepare(`INSERT INTO subscriptions (brand_id, plan_type, status, renewal_date, created_at, updated_at)
      VALUES (?, ?, 'ACTIVE', ?, ?, ?)
    `).run(req.session.brandId, plan_type, renewal, now, now);
  }
  res.json({ success: true });
});

app.get('/api/brand/invoices', requireBrand, (req, res) => {
  const invoices = db.prepare('SELECT * FROM invoices WHERE brand_id = ? ORDER BY created_at DESC').all(req.session.brandId);
  res.json(invoices);
});

// Payments - Stripe Checkout
app.post('/api/payments/create-checkout-session', requireBrand, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  const { plan_type } = req.body;
  if (!['MONTHLY', 'ANNUAL'].includes(plan_type)) return res.status(400).json({ error: 'Invalid plan type' });
  const amount = plan_type === 'MONTHLY' ? 4900 : 49900;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: db.prepare('SELECT email FROM brands WHERE id = ?').get(req.session.brandId)?.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Ethical Supply ${plan_type === 'MONTHLY' ? 'Monthly' : 'Annual'} Plan` },
            recurring: { interval: plan_type === 'MONTHLY' ? 'month' : 'year' },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      metadata: { brand_id: String(req.session.brandId), plan_type },
      success_url: `${appBaseUrl}/dashboard.html?checkout=success&plan=${plan_type}`,
      cancel_url: `${appBaseUrl}/dashboard.html?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error', err);
    res.status(500).json({ error: 'Payment session failed' });
  }
});

// Public endpoints
app.get('/api/public/brands', (req, res) => {
  const brands = db.prepare("SELECT id, name, description, logo_url, story, categories, created_at FROM brands WHERE status = 'ACTIVE'").all();
  res.json(brands);
});

app.get('/api/public/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ brands: [], points: [] });
  const like = `%${q}%`;
  const brands = db
    .prepare(
      `SELECT id, name, description, logo_url, story, categories, created_at
       FROM brands
       WHERE status = 'ACTIVE' AND (name LIKE ? OR description LIKE ? OR story LIKE ? OR categories LIKE ?)`
    )
    .all(like, like, like, like);
  const points = db
    .prepare(
      `SELECT sp.id, sp.brand_id, sp.title, sp.address, sp.latitude, sp.longitude, sp.ethical_highlight, sp.photo_url, b.name as brand_name
       FROM supply_chain_points sp
       JOIN brands b ON sp.brand_id = b.id
       WHERE sp.status = 'APPROVED' AND b.status = 'ACTIVE'
         AND (sp.title LIKE ? OR sp.address LIKE ? OR sp.ethical_highlight LIKE ? OR b.name LIKE ?)`
    )
    .all(like, like, like, like);
  res.json({ brands, points });
});

app.get('/api/public/points', (req, res) => {
  const points = db
    .prepare(`SELECT sp.id, sp.brand_id, sp.title, sp.address, sp.latitude, sp.longitude, sp.ethical_highlight, b.name as brand_name
              FROM supply_chain_points sp
              JOIN brands b ON sp.brand_id = b.id
              WHERE sp.status = 'APPROVED' AND b.status = 'ACTIVE'`)
    .all();
  res.json(points);
});

app.get('/api/public/brands/:id', (req, res) => {
  const brand = db.prepare("SELECT id, name, description, logo_url, story, categories FROM brands WHERE id = ? AND status = 'ACTIVE'").get(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const points = db
    .prepare("SELECT id, title, description, address, latitude, longitude, ethical_highlight, photo_url FROM supply_chain_points WHERE brand_id = ? AND status = 'APPROVED'")
    .all(req.params.id);
  res.json({ brand, points });
});

// Admin routes
app.get('/api/admin/brands/pending', requireAdmin, (req, res) => {
  const pending = db
    .prepare("SELECT * FROM brands WHERE status IN ('PENDING_APPROVAL', 'REACTIVATION_PENDING')")
    .all();
  res.json(pending);
});

app.get('/api/admin/brands/active', requireAdmin, (req, res) => {
  const active = db.prepare("SELECT id, name, email, categories, updated_at FROM brands WHERE status = 'ACTIVE' ORDER BY updated_at DESC").all();
  res.json(active);
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const summary = {
    brands: {
      active: db.prepare("SELECT COUNT(*) as c FROM brands WHERE status = 'ACTIVE'").get().c,
      pending: db
        .prepare("SELECT COUNT(*) as c FROM brands WHERE status IN ('PENDING_APPROVAL', 'REACTIVATION_PENDING')")
        .get().c,
    },
    points: {
      approved: db.prepare("SELECT COUNT(*) as c FROM supply_chain_points WHERE status = 'APPROVED'").get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM supply_chain_points WHERE status = 'PENDING_REVIEW'").get().c,
    },
    invoices: {
      due: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status = 'DUE'").get().c,
      total: db.prepare("SELECT COUNT(*) as c FROM invoices").get().c,
    },
  };
  res.json(summary);
});

app.post('/api/admin/brands/:id/approve', requireAdmin, (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Not found' });
  if (!['PENDING_APPROVAL', 'REACTIVATION_PENDING'].includes(brand.status)) {
    return res.status(400).json({ error: 'Brand not pending' });
  }
  db.prepare("UPDATE brands SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(timestamp(), req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/brands/:id/reject', requireAdmin, (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE brands SET status = 'REJECTED', updated_at = ? WHERE id = ?").run(timestamp(), req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/supply-points/pending', requireAdmin, (req, res) => {
  const points = db
    .prepare(`SELECT sp.*, b.name as brand_name FROM supply_chain_points sp
      JOIN brands b ON sp.brand_id = b.id
      WHERE sp.status = 'PENDING_REVIEW'`)
    .all();
  res.json(points);
});

app.post('/api/admin/supply-points/:id/approve', requireAdmin, (req, res) => {
  db.prepare("UPDATE supply_chain_points SET status = 'APPROVED', updated_at = ? WHERE id = ?")
    .run(timestamp(), req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/supply-points/:id/reject', requireAdmin, (req, res) => {
  db.prepare("UPDATE supply_chain_points SET status = 'REJECTED', updated_at = ? WHERE id = ?")
    .run(timestamp(), req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/invoices', requireAdmin, (req, res) => {
  const { status } = req.query;
  let invoices;
  if (status) {
    invoices = db.prepare('SELECT * FROM invoices WHERE status = ?').all(status);
  } else {
    invoices = db.prepare('SELECT * FROM invoices').all();
  }
  res.json(invoices);
});

function createInvoice(brandId, planType, amount) {
  const now = timestamp();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);
  db.prepare(
    `INSERT INTO invoices (brand_id, amount, plan_type, due_date, status, created_at)
     VALUES (?, ?, ?, ?, 'DUE', ?)`
  ).run(brandId, amount, planType, dueDate.toISOString(), now);
}

function runBilling(planType) {
  const todayIso = new Date().toISOString();
  const subs = db
    .prepare("SELECT * FROM subscriptions WHERE status = 'ACTIVE' AND plan_type = ? AND renewal_date <= ?")
    .all(planType, todayIso);
  const summary = [];
  subs.forEach((sub) => {
    const amount = planType === 'MONTHLY' ? 49 : 499;
    createInvoice(sub.brand_id, planType, amount);
    const newRenewal = planType === 'MONTHLY' ? addMonths(sub.renewal_date, 1) : addYears(sub.renewal_date, 1);
    db.prepare('UPDATE subscriptions SET renewal_date = ?, updated_at = ? WHERE id = ?')
      .run(newRenewal, timestamp(), sub.id);
    summary.push({ brand_id: sub.brand_id, subscription_id: sub.id, new_renewal: newRenewal });
  });
  return summary;
}

app.post('/api/admin/run-monthly-billing', requireAdmin, (req, res) => {
  const result = runBilling('MONTHLY');
  res.json({ processed: result.length, details: result });
});

app.post('/api/admin/run-annual-billing', requireAdmin, (req, res) => {
  const result = runBilling('ANNUAL');
  res.json({ processed: result.length, details: result });
});

// Fallback route to serve landing for unmatched paths if needed
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
