async function adminFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    if (window.location.pathname !== '/admin-login.html') window.location.href = '/admin-login.html';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  return res.json();
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('admin-login-form');
  if (loginForm) {
    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(loginForm).entries());
      const msg = document.getElementById('admin-login-message');
      try {
        await adminFetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });
        window.location.href = '/admin-dashboard.html';
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    return;
  }

  if (document.getElementById('pending-brands')) {
    loadAdminDashboard();
  }
});

async function loadAdminDashboard() {
  await loadOverview();
  await loadPendingBrands();
  await loadPendingPoints();
  await loadActiveBrands();
  await loadInvoices();
  document.getElementById('run-monthly').onclick = async () => {
    const res = await adminFetch('/api/admin/run-monthly-billing', { method: 'POST' });
    document.getElementById('billing-output').textContent = JSON.stringify(res, null, 2);
  };
  document.getElementById('run-annual').onclick = async () => {
    const res = await adminFetch('/api/admin/run-annual-billing', { method: 'POST' });
    document.getElementById('billing-output').textContent = JSON.stringify(res, null, 2);
  };
  document.getElementById('admin-logout').onclick = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/admin-login.html';
  };
  document.getElementById('admin-brand-search').oninput = (e) => {
    loadActiveBrands(e.target.value);
  };
  document.getElementById('invoice-filter').onchange = (e) => loadInvoices(e.target.value);
}

async function loadPendingBrands() {
  const container = document.getElementById('pending-brands');
  const brands = await adminFetch('/api/admin/brands/pending');
  if (!brands.length) {
    container.innerHTML = '<p>No pending brands.</p>';
    return;
  }
  container.innerHTML = brands
    .map(
      (b) => `
        <div class="card">
          <strong>${b.name}</strong> (${b.email})<br>Status: ${b.status}
          <div class="btn-row" style="margin-top:8px;">
            <button class="btn" onclick="approveBrand(${b.id})">Approve</button>
            <button class="btn secondary" onclick="rejectBrand(${b.id})">Reject</button>
          </div>
        </div>`
    )
    .join('');
}

async function loadPendingPoints() {
  const container = document.getElementById('pending-points');
  const points = await adminFetch('/api/admin/supply-points/pending');
  if (!points.length) {
    container.innerHTML = '<p>No pending supply points.</p>';
    return;
  }
  container.innerHTML = points
    .map(
      (p) => `
        <div class="card">
          <strong>${p.title || 'Facility'}</strong> — ${p.brand_name}<br>${p.address || ''}<br>${p.ethical_highlight || ''}
          <div class="btn-row" style="margin-top:8px;">
            <button class="btn" onclick="approvePoint(${p.id})">Approve</button>
            <button class="btn secondary" onclick="rejectPoint(${p.id})">Reject</button>
          </div>
        </div>`
    )
    .join('');
}

async function approveBrand(id) {
  await adminFetch(`/api/admin/brands/${id}/approve`, { method: 'POST' });
  loadPendingBrands();
}

async function rejectBrand(id) {
  await adminFetch(`/api/admin/brands/${id}/reject`, { method: 'POST' });
  loadPendingBrands();
}

async function approvePoint(id) {
  await adminFetch(`/api/admin/supply-points/${id}/approve`, { method: 'POST' });
  loadPendingPoints();
}

async function rejectPoint(id) {
  await adminFetch(`/api/admin/supply-points/${id}/reject`, { method: 'POST' });
  loadPendingPoints();
}

async function loadOverview() {
  const data = await adminFetch('/api/admin/overview');
  const container = document.getElementById('admin-overview');
  container.innerHTML = `
    <div class="card"><strong>${data.brands.active}</strong><br><span class="muted">Active brands</span></div>
    <div class="card"><strong>${data.brands.pending}</strong><br><span class="muted">Pending brands</span></div>
    <div class="card"><strong>${data.points.approved}</strong><br><span class="muted">Approved facilities</span></div>
    <div class="card"><strong>${data.points.pending}</strong><br><span class="muted">Points pending review</span></div>
    <div class="card"><strong>${data.invoices.due}</strong><br><span class="muted">Invoices due</span></div>
    <div class="card"><strong>${data.invoices.total}</strong><br><span class="muted">Total invoices</span></div>
  `;
}

async function loadActiveBrands(query = '') {
  const container = document.getElementById('active-brands');
  const brands = await adminFetch('/api/admin/brands/active');
  const filtered = query
    ? brands.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()) || (b.categories || '').toLowerCase().includes(query.toLowerCase()))
    : brands;
  if (!filtered.length) {
    container.innerHTML = '<p>No matching active brands.</p>';
    return;
  }
  container.innerHTML = `<table class="table"><tr><th>Name</th><th>Email</th><th>Categories</th><th>Updated</th></tr>
    ${filtered
      .map(
        (b) =>
          `<tr><td>${b.name}</td><td>${b.email}</td><td>${b.categories || ''}</td><td>${b.updated_at ? new Date(b.updated_at).toLocaleDateString() : ''}</td></tr>`
      )
      .join('')}</table>`;
}

async function loadInvoices(status = '') {
  const container = document.getElementById('admin-invoices');
  const query = status ? `?status=${status}` : '';
  const invoices = await adminFetch(`/api/admin/invoices${query}`);
  if (!invoices.length) {
    container.innerHTML = '<p>No invoices.</p>';
    return;
  }
  container.innerHTML = `<table class="table"><tr><th>Brand ID</th><th>Amount</th><th>Plan</th><th>Due</th><th>Status</th></tr>
    ${invoices
      .map(
        (inv) =>
          `<tr><td>${inv.brand_id}</td><td>$${inv.amount.toFixed(2)}</td><td>${inv.plan_type}</td><td>${inv.due_date ? new Date(inv.due_date).toLocaleDateString() : ''}</td><td>${inv.status}</td></tr>`
      )
      .join('')}</table>`;
}
