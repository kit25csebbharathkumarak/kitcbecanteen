const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

const socket = io({
  auth: { token }
});
let orders   = [];

// --- URL Params for Payment Callback ---
const urlParams = new URLSearchParams(window.location.search);
const isPaymentSuccess = urlParams.get('payment') === 'success';
const paymentSuccessOrderId = urlParams.get('orderId');

if (isPaymentSuccess) {
  window.history.replaceState({}, document.title, window.location.pathname);
}
if (urlParams.get('error')) {
  alert('Payment Error: ' + urlParams.get('error').replace(/_/g, ' '));
  window.history.replaceState({}, document.title, window.location.pathname);
}

// --- DOM Elements ---
const userOrdersBoard = document.getElementById('user-orders-board');
const qrModal         = document.getElementById('qr-modal');
const closeModalBtn   = document.getElementById('close-modal');
const qrcodeContainer = document.getElementById('qrcode');
const orderIdDisplay  = document.getElementById('order-id-display');

window.showPickupQR = function(orderId) {
  if (!qrcodeContainer || !orderId) return;

  const safeId = String(orderId).trim();
  if (orderIdDisplay) {
    orderIdDisplay.innerText = safeId;
  }
  if (qrModal) {
    qrModal.classList.add('active');
  }

  // Clear previous content and render guaranteed vector SVG QR code
  qrcodeContainer.innerHTML = `
    <img src="/api/orders/${encodeURIComponent(safeId)}/qr" 
         alt="Order QR Code for ${safeId}" 
         style="width: 220px; height: 220px; display: block; margin: 0 auto; border-radius: 8px; image-rendering: pixelated;" 
         onerror="this.onerror=null; this.src='/api/orders/${encodeURIComponent(safeId)}/qr?retry=${Date.now()}';" />
  `;
};

// --- Fetch & Render My Orders ---
async function fetchMyOrders() {
  try {
    const res = await fetch(`${API_URL}/orders/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch orders');
    orders = await res.json();
    renderMyOrders();

    // If customer just completed payment, pop up their collection QR code immediately!
    if (isPaymentSuccess) {
      const targetId = paymentSuccessOrderId || (orders.length > 0 ? orders[0].id : null);
      if (targetId) {
        setTimeout(() => {
          showPickupQR(targetId);
          playNotificationSound('food_ready');
          showToast({
            title: '🎉 Payment Successful!',
            message: `Order #${targetId} is placed! Show your QR code at the counter for pickup.`,
            type: 'shop-open',
            icon: 'fa-circle-check',
            duration: 8000
          });
        }, 400);
      }
    }
  } catch (err) {
    console.error(err);
    userOrdersBoard.innerHTML = '<p style="color:red">Failed to load orders. Please refresh.</p>';
  }
}

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

function playNotificationSound(type = 'chime') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    if (type === 'food_ready') {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(587.33, now);
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15);

      osc2.frequency.setValueAtTime(880, now + 0.2);
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.45);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.2);
      osc2.start(now + 0.2);
      osc2.stop(now + 0.85);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.25);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch (e) {
    console.debug('Audio not supported:', e);
  }
}

function showToast({ title, message, type = 'food-ready', icon = 'fa-bell-concierge', duration = 8000 }) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `canteen-toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon"><i class="fa-solid ${icon}"></i></div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-body">${message}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.onclick = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(60px)';
    setTimeout(() => toast.remove(), 300);
  };

  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

function renderMyOrders() {
  userOrdersBoard.innerHTML = '';

  if (orders.length === 0) {
    userOrdersBoard.innerHTML = `
      <div style="text-align:center;padding:3rem;color:var(--text-muted);">
        <img src="logo.png" alt="Logo" style="height:80px; margin-bottom:1.5rem; filter: grayscale(0.2); opacity: 0.8; display:block; margin-left:auto; margin-right:auto;">
        You have no orders yet.
      </div>`;
    return;
  }

  orders.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');
    const safeOrderId = escapeHtml(order.id);
    const isFoodReady = order.status === 'Ready for Pickup';

    const div = document.createElement('div');
    div.className = `order-card glass-panel ${statusLc}`;
    div.style.cssText = 'flex-direction:column;align-items:flex-start;gap:1rem;';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;justify-content:space-between;width:100%;flex-wrap:wrap;gap:0.5rem;';

    // UPI Transaction ID (if available)
    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.5rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> UPI Txn ID: ${escapeHtml(order.txn_id)}
         </div>`
      : '';

    headerRow.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;font-family:monospace;">${safeOrderId}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.8rem;">${escapeHtml(order.user_name)}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.3rem;">
          ${items.map(i => `<div><strong>${escapeHtml(i.quantity)}×</strong> ${escapeHtml(i.name)}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:1rem;font-size:1.1rem;">₹${escapeHtml(order.total)}</div>
        ${txnLine}
      </div>
      <div>
        <span class="badge ${statusLc}">${escapeHtml(order.status)}</span>
      </div>
    `;

    div.appendChild(headerRow);

    // Call-to-action & Hints
    if (order.status === 'Pending Payment') {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted);font-size:0.9rem;margin-top:0.5rem;';
      note.innerHTML = `<i class="fa-solid fa-clock"></i> Waiting for payment confirmation.`;
      div.appendChild(note);
    } else if (isFoodReady) {
      // High-visibility prompt when food is ready to collect
      const readyBanner = document.createElement('div');
      readyBanner.style.cssText = 'background: #fff8e1; border: 2px solid #f39c12; padding: 0.8rem 1.2rem; border-radius: 8px; width: 100%; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.8rem;';
      readyBanner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.6rem; color: #d35400; font-weight: 700;">
          <i class="fa-solid fa-bell-concierge fa-bounce" style="font-size: 1.3rem;"></i>
          <span>Food Ready for Pickup! Please collect at counter.</span>
        </div>
        <button class="btn btn-primary" style="background: #e67e22; border-color: #e67e22; padding: 0.5rem 1.2rem; font-weight: bold;" onclick="showPickupQR('${order.id}')">
          <i class="fa-solid fa-qrcode"></i> Show Pickup QR
        </button>
      `;
      div.appendChild(readyBanner);
    } else if (order.status === 'PAID' || order.status === 'Pending') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'margin-top:0.5rem; background: var(--primary-color); border: none; padding: 0.5rem 1rem; border-radius: 4px; color: #fff; cursor: pointer; font-weight: bold;';
      btn.innerHTML = '<i class="fa-solid fa-qrcode"></i> View QR Code to Collect Food';
      btn.onclick = () => showPickupQR(order.id);
      div.appendChild(btn);
    }

    userOrdersBoard.appendChild(div);
  });
}

// --- Close Modal ---
if (closeModalBtn) {
  closeModalBtn.onclick = () => qrModal.classList.remove('active');
}
window.addEventListener('click', (e) => {
  if (e.target === qrModal) {
    qrModal.classList.remove('active');
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qrModal && qrModal.classList.contains('active')) {
    qrModal.classList.remove('active');
  }
});

// --- Nav Logout ---
const nav = document.querySelector('nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = `Logout (${user ? user.name : ''})`;
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// --- Socket Updates ---
socket.on('order_status_update', (data) => {
  fetchMyOrders();
});

socket.on('food_ready', (data) => {
  if (user && data.userId === user.id) {
    playNotificationSound('food_ready');
    showToast({
      title: '🍽️ Food Ready for Pickup!',
      message: data.message || `Order #${data.orderId} is ready for collection at the counter.`,
      type: 'food-ready',
      icon: 'fa-bell-concierge',
      duration: 10000
    });
    fetchMyOrders();
  }
});

socket.on('shop_status_changed', (isOpen) => {
  if (isOpen) {
    playNotificationSound('shop_open');
    showToast({
      title: '🎉 Canteen is Now Open!',
      message: 'The kitchen is taking orders. Head over to Menu to order fresh food!',
      type: 'shop-open',
      icon: 'fa-store',
      duration: 7000
    });
  }
});

socket.on('payment_confirmed', () => fetchMyOrders());

// --- Init ---
fetchMyOrders();
