const API_URL = `${window.location.origin}/api`;
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.href = 'login.html';
const socket = io({
  auth: { token }
});
const statsDiv = document.getElementById('item-stats');
const totalRevenueDiv = document.getElementById('total-revenue-stat');

async function fetchItemStats() {
  try {
    const res = await fetch(`${API_URL}/items/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const stats = await res.json();
    renderItemStats(stats);
  } catch (err) {
    console.error(err);
  }
}

function renderItemStats(stats) {
  statsDiv.innerHTML = '';
  const statsArray = Object.entries(stats);

  if (statsArray.length === 0) {
    statsDiv.innerHTML = '<p style="color: var(--text-muted); font-style: italic; text-align: center; padding: 2rem;">No sales data available yet.</p>';
    totalRevenueDiv.innerText = 'Total Revenue: ₹0.00';
    return;
  }

  // Sort by most ordered
  statsArray.sort((a, b) => b[1].orderedQuantity - a[1].orderedQuantity);

  let grandTotalRevenue = 0;

  statsArray.forEach(([itemId, stat]) => {
    const div = document.createElement('div');
    div.className = 'glass-panel';
    div.style.padding = '1.2rem';
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.8rem;">
        <h4 style="font-size: 1.2rem;">${stat.name}</h4>
        <div style="font-weight: 800; color: var(--primary-color); font-size: 1.1rem;">₹${stat.totalRevenue.toFixed(2)}</div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div style="background: var(--bg-color); padding: 0.5rem; border: 1px solid var(--text-main); border-radius: var(--border-radius);">
            <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">Total Ordered</div>
            <div style="font-size: 1.2rem; font-weight: 700;">${stat.orderedQuantity}</div>
        </div>
        <div style="background: var(--bg-color); padding: 0.5rem; border: 1px solid var(--text-main); border-radius: var(--border-radius);">
            <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">Delivered</div>
            <div style="font-size: 1.2rem; font-weight: 700;">${stat.deliveredQuantity}</div>
        </div>
      </div>
    `;
    statsDiv.appendChild(div);
    grandTotalRevenue += stat.totalRevenue;
  });

  totalRevenueDiv.innerText = `Total Revenue: ₹${grandTotalRevenue.toFixed(2)}`;
}

// Socket events to refresh stats live
socket.on('new_order', () => fetchItemStats());
socket.on('order_status_update', () => fetchItemStats());

// Logout logic
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn = document.createElement('a');
  logoutBtn.href = '#';
  logoutBtn.innerText = `Logout`;
  logoutBtn.style.color = 'var(--primary-color)';
  logoutBtn.style.fontWeight = '700';
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// Init
fetchItemStats();
