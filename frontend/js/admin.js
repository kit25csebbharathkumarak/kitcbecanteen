const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.href = 'login.html';
}
const socket = io({
  auth: { token }
});
// --- DOM ---
const ordersBoard              = document.getElementById('orders-board');
const recentlyScannedContainer = document.getElementById('recently-scanned-container');
const scannedOrderDetails      = document.getElementById('scanned-order-details');
const orderSearchInput         = document.getElementById('order-search');

let orders          = [];
let lastScannedId   = null;
let searchQuery     = '';

// --- QR Scanner ---
const html5QrcodeScanner = new Html5QrcodeScanner(
  'reader',
  { fps: 10, qrbox: { width: 250, height: 250 } },
  false
);
html5QrcodeScanner.render(onScanSuccess, () => {});

function onScanSuccess(decodedText) {
  fetchOrderAndFulfill(decodedText);
}

// --- HTML Sanitization Helper to prevent Stored XSS ---
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

async function fetchOrderAndFulfill(orderId) {
  try {
    const res = await fetch(`${API_URL}/orders/${encodeURIComponent(orderId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { 
      scannedOrderDetails.innerHTML = `<div style="color: #c0392b; font-weight: bold; font-size: 1.1rem; padding: 1rem; background: #fadbd8; border-radius: var(--border-radius);"><i class="fa-solid fa-triangle-exclamation"></i> Order not found: ${escapeHtml(orderId)}</div>`;
      recentlyScannedContainer.style.display = 'flex';
      
      if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
      window.scanDismissTimeout = setTimeout(() => {
        recentlyScannedContainer.style.display = 'none';
      }, 5000);
      return; 
    }

    const order = await res.json();

    if (order.status === 'Delivered') {
      return;
    }

    lastScannedId = order.id;
    renderScannedOrderDetails(order);
    
    // Add success message
    const msgDiv = document.createElement('div');
    msgDiv.className = 'scan-success-message';
    msgDiv.innerHTML = `<i class="fa-solid fa-check-circle"></i> Successfully marked Order ${escapeHtml(orderId)} as Delivered.`;
    scannedOrderDetails.appendChild(msgDiv);

    // Call API to update status in DB
    await updateOrderStatus(orderId, 'Delivered');

    // Auto dismiss
    if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
    window.scanDismissTimeout = setTimeout(() => {
      recentlyScannedContainer.style.display = 'none';
    }, 5000);
  } catch (err) {
    console.error(err);
  }
}

function renderScannedOrderDetails(order) {
  const items    = JSON.parse(order.items);
  const itemsStr = items.map(i =>
    `<li style="margin-bottom:0.8rem;font-size:2rem;line-height:1.2;"><strong>${escapeHtml(i.quantity)}×</strong> ${escapeHtml(i.name)}</li>`
  ).join('');

  const txnLine = order.txn_id
    ? `<div style="margin-bottom:0.8rem;font-size:0.85rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.3rem 0.5rem;background:#fff;border-radius:var(--border-radius);display:inline-block;">
         <i class="fa-solid fa-receipt"></i> UPI Txn ID: ${escapeHtml(order.txn_id)}
       </div>`
    : '';

  scannedOrderDetails.innerHTML = `
    <div style="display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <div style="font-family:monospace;font-size:0.8rem;margin-bottom:0.2rem;color:var(--text-muted);">Order ID: ${escapeHtml(order.id)}</div>
        <div style="font-weight:600;font-size:0.9rem;color:var(--text-muted);margin-bottom:1rem;">Ordered by: ${escapeHtml(order.user_name)}</div>
        ${txnLine}
        <ul style="list-style:none;padding:0;color:var(--text-main);">${itemsStr}</ul>
      </div>
      <div style="text-align:right;">
        <div style="font-size:1.4rem;font-weight:700;color:var(--primary-color);">₹${escapeHtml(order.total)}</div>
        <div style="margin-top:0.5rem;"><span class="badge ${escapeHtml((order.status||'').toLowerCase().replace(/\s+/g,'-'))}">${escapeHtml(order.status)}</span></div>
      </div>
    </div>
  `;
  recentlyScannedContainer.style.display = 'flex';
  
  // Auto dismiss after 5 seconds
  if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
  window.scanDismissTimeout = setTimeout(() => {
    recentlyScannedContainer.style.display = 'none';
  }, 5000);

  renderOrders();
}

// --- Order Status Update ---
async function updateOrderStatus(id, status) {
  try {
    await fetch(`${API_URL}/orders/${encodeURIComponent(id)}/status`, {
      method:  'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status })
    });
    fetchOrders();
  } catch (err) {
    console.error(err);
  }
}
window.updateOrderStatus = updateOrderStatus;

// Admin confirms payment manually (e.g. verified in UPI/Paytm app)
async function confirmPayment(orderId) {
  const txnId = prompt('Enter UPI Reference / UTR Number (optional, leave blank to auto-generate):');
  if (txnId === null) return; // User cancelled

  try {
    const res = await fetch(`${API_URL}/orders/${encodeURIComponent(orderId)}/confirm-payment`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ txnId: txnId.trim() })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to confirm payment');
      return;
    }

    fetchOrders();
  } catch (err) {
    console.error('Error confirming payment:', err);
    alert('Network error while confirming payment');
  }
}
window.confirmPayment = confirmPayment;

// --- Clear Delivered Orders ---
const clearDeliveredBtn = document.getElementById('clear-delivered-btn');
if (clearDeliveredBtn) {
  clearDeliveredBtn.onclick = async () => {
    if (!confirm('Are you sure you want to clear all delivered orders?')) return;
    try {
      await fetch(`${API_URL}/orders/delivered`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchOrders();
    } catch (err) {
      console.error('Failed to clear delivered orders:', err);
    }
  };
}

// --- Fetch & Render Orders ---
async function fetchOrders() {
  try {
    const res = await fetch(`${API_URL}/orders`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.clear();
      window.location.href = 'login.html';
      return;
    }
    orders = await res.json();
    renderOrders();
  } catch (err) {
    console.error(err);
  }
}

function renderOrders() {
  ordersBoard.innerHTML = '';

  const filtered = orders.filter(o =>
    o.status !== 'Pending Payment' &&
    o.status !== 'Failed' &&
    o.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    ordersBoard.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);">No orders found matching "${escapeHtml(searchQuery)}"</div>`;
    return;
  }

  filtered.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');
    const isHighlight = lastScannedId === order.id;

    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.4rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> UPI Txn: ${escapeHtml(order.txn_id)}
         </div>`
      : '';

    // Action buttons per status
    let actionBtns = '';
    const safeOrderId = escapeHtml(order.id);
    if (order.status === 'Pending Payment') {
      actionBtns = `
        <button class="btn btn-primary"
          style="margin-top:0.6rem;display:block;font-size:0.8rem;padding:0.4rem 0.8rem;background:#2ecc71;border-color:#2ecc71;"
          onclick="confirmPayment('${safeOrderId}')">
          <i class="fa-solid fa-check"></i> Confirm Payment
        </button>`;
    } else if (order.status === 'Pending') {
      actionBtns = `
        <div style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;">
          <button class="btn btn-primary"
            style="font-size:0.8rem;padding:0.35rem 0.7rem;background:#e67e22;border-color:#e67e22;"
            onclick="updateOrderStatus('${safeOrderId}', 'Ready for Pickup')">
            <i class="fa-solid fa-bell"></i> Food Ready (Alert)
          </button>
          <button class="btn btn-secondary"
            style="font-size:0.8rem;padding:0.3rem 0.6rem;"
            onclick="updateOrderStatus('${safeOrderId}', 'Delivered')">
            <i class="fa-solid fa-check"></i> Mark Delivered
          </button>
        </div>`;
    } else if (order.status === 'Ready for Pickup') {
      actionBtns = `
        <div style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;">
          <button class="btn btn-secondary"
            style="font-size:0.78rem;padding:0.3rem 0.6rem;background:#27ae60;border-color:#27ae60;color:#fff;"
            onclick="updateOrderStatus('${safeOrderId}', 'Delivered')">
            <i class="fa-solid fa-circle-check"></i> Mark Delivered
          </button>
          <button class="btn btn-secondary"
            style="font-size:0.75rem;padding:0.25rem 0.5rem;opacity:0.85;"
            onclick="updateOrderStatus('${safeOrderId}', 'Ready for Pickup')">
            <i class="fa-solid fa-bell"></i> Re-alert Customer
          </button>
        </div>`;
    }

    const div = document.createElement('div');
    div.id        = `order-card-${safeOrderId}`;
    div.className = `order-card glass-panel ${statusLc} ${isHighlight ? 'highlight' : ''}`;
    div.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;">${safeOrderId}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.5rem;">${escapeHtml(order.user_name)}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.2rem;">
          ${items.map(i => `<div>• ${escapeHtml(i.quantity)}× ${escapeHtml(i.name)}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:0.8rem;font-size:1.1rem;">₹${escapeHtml(order.total)}</div>
        ${txnLine}
      </div>
      <div style="text-align:right;">
        <span class="badge ${statusLc}">${escapeHtml(order.status)}</span>
        ${actionBtns}
      </div>
    `;
    ordersBoard.appendChild(div);
  });
}

// --- Socket Events ---
socket.on('new_order', () => fetchOrders());
socket.on('order_status_update', () => fetchOrders());
socket.on('payment_confirmed', () => fetchOrders());

socket.on('menu_updated', () => { /* menu change doesn't affect admin orders view */ });

// --- Clear Delivered Orders ---
async function clearDeliveredOrders() {
  if (!confirm('Delete all delivered orders? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API_URL}/orders/delivered`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { alert('Failed to clear delivered orders.'); return; }
    alert('Delivered orders cleared successfully.');
    fetchOrders();
  } catch (err) {
    console.error(err);
    alert('Error clearing delivered orders.');
  }
}

// --- Logout ---
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = 'Logout';
  logoutBtn.style.cssText = 'color:var(--primary-color);font-weight:700;';
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// --- Init ---
fetchOrders();

document.getElementById('clear-delivered-btn').addEventListener('click', clearDeliveredOrders);

orderSearchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderOrders();
});

// --- Shop Status Toggle ---
const shopStatusToggle = document.getElementById('shop-status-toggle');
if (shopStatusToggle) {
  // Fetch initial status
  fetch(`${API_URL}/shop-status`)
    .then(res => res.json())
    .then(data => {
      shopStatusToggle.checked = data.isOpen;
    })
    .catch(err => console.error('Error fetching shop status:', err));

  // Handle toggle change
  shopStatusToggle.addEventListener('change', async (e) => {
    const isOpen = e.target.checked;
    try {
      const res = await fetch(`${API_URL}/shop-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ isOpen })
      });
      if (!res.ok) {
        shopStatusToggle.checked = !isOpen; // revert
        alert('Failed to update shop status');
      }
    } catch (err) {
      console.error(err);
      shopStatusToggle.checked = !isOpen; // revert
    }
  });

  socket.on('shop_status_changed', (isOpen) => {
    shopStatusToggle.checked = isOpen;
  });
}
