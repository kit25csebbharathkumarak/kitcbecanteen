const API_URL = `${window.location.origin}/api`;

const token = localStorage.getItem('token');
const user  = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

let cart       = {};
let menuItems  = [];
let searchQuery = '';
let currentFilter = 'all';
let currentSort = 'default';
let shopOpen = true;

// Current order context (used by Razorpay integration)
let currentOrderId  = null;

const socket = io({
  auth: { token }
});

// --- DOM Elements ---
const menuGrid          = document.getElementById('menu-grid');
const cartItemsContainer= document.getElementById('cart-items');
const cartTotalElement  = document.getElementById('cart-total');
const checkoutBtn       = document.getElementById('checkout-btn');
const menuSearchInput   = document.getElementById('menu-search');



// --- Fetch & Render Menu ---

// --- SOUND & TOAST NOTIFICATION HELPERS ---
function playNotificationSound(type = 'chime') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    if (type === 'food_ready') {
      // Pleasant double-bell alert chime
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      osc2.frequency.setValueAtTime(880, now + 0.2); // A5
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.45); // D6

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.2);
      osc2.start(now + 0.2);
      osc2.stop(now + 0.8);
    } else {
      // Gentle shop-open welcome chime
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12); // E5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.25); // G5

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch (e) {
    console.debug('Audio notification not supported or blocked by browser policy:', e);
  }
}

function showToast({ title, message, type = 'shop-open', icon = 'fa-store', duration = 6000 }) {
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

  // Native notification if permitted
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body: message, icon: 'logo.png' });
  }

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

function showFoodReadyPopup(orderId, message) {
  const existing = document.getElementById('food-ready-popup');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'food-ready-popup';
  overlay.className = 'food-ready-popup-overlay';
  overlay.innerHTML = `
    <div class="food-ready-popup-card">
      <div style="font-size: 3.5rem; color: #f39c12; margin-bottom: 0.8rem;">
        <i class="fa-solid fa-bell-concierge fa-shake"></i>
      </div>
      <h2 style="font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--text-main);">Your Food is Ready!</h2>
      <p style="font-size: 1.05rem; color: var(--text-muted); margin-bottom: 1.2rem;">
        ${message || `Order #${orderId} is packed and ready for collection at the counter.`}
      </p>
      <div style="font-family: monospace; font-size: 1.15rem; font-weight: 700; background: #fdf5e6; padding: 0.6rem 1rem; border-radius: 8px; display: inline-block; margin-bottom: 1.5rem; border: 1px dashed #f39c12; color: #d35400;">
        Order ID: ${orderId}
      </div>
      <div style="display: flex; gap: 0.8rem; justify-content: center; flex-wrap: wrap;">
        <a href="orders.html" class="btn btn-primary" style="padding: 0.8rem 1.6rem; font-size: 1rem; text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem; background: #e67e22; border-color: #e67e22;">
          <i class="fa-solid fa-qrcode"></i> View Pickup QR
        </a>
        <button id="close-food-popup" class="btn btn-secondary" style="padding: 0.8rem 1.4rem; font-size: 1rem;">
          Dismiss
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('close-food-popup').onclick = () => overlay.remove();
}

// Request notification permission opportunistically on customer interaction
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => {
    Notification.requestPermission().catch(() => {});
  }, { once: true });
}

// Fetch Shop Status
let isInitialShopCheck = true;
fetch(`${API_URL}/shop-status`)
  .then(res => res.json())
  .then(data => {
    shopOpen = data.isOpen;
    updateShopUI();
    isInitialShopCheck = false;
  })
  .catch(err => console.error('Error fetching shop status:', err));

socket.on('shop_status_changed', (isOpen) => {
  const previousState = shopOpen;
  shopOpen = isOpen;
  updateShopUI();

  if (!isInitialShopCheck && !previousState && isOpen) {
    // Transitioned from closed to open: notify customer
    playNotificationSound('shop_open');
    showToast({
      title: '🎉 Canteen is Now Open!',
      message: 'The kitchen is active and taking orders. Browse today\'s menu and order now!',
      type: 'shop-open',
      icon: 'fa-store',
      duration: 8000
    });
  } else if (!isInitialShopCheck && previousState && !isOpen) {
    showToast({
      title: 'Shop Closed',
      message: 'The canteen has closed for new orders.',
      type: 'shop-open',
      icon: 'fa-store-slash',
      duration: 5000
    });
  }
});

socket.on('food_ready', (data) => {
  if (user && data.userId === user.id) {
    playNotificationSound('food_ready');
    showToast({
      title: '🍽️ Food Ready for Pickup!',
      message: data.message || `Order #${data.orderId} is ready to collect at the counter.`,
      type: 'food-ready',
      icon: 'fa-bell-concierge',
      duration: 12000
    });
    showFoodReadyPopup(data.orderId, data.message);
  }
});

function updateShopUI() {
  const banner = document.getElementById('shop-closed-banner');
  if (banner) {
    banner.style.display = shopOpen ? 'none' : 'block';
  }
  if (checkoutBtn) {
    checkoutBtn.disabled = !shopOpen;
    if (!shopOpen) {
      checkoutBtn.style.opacity = '0.5';
      checkoutBtn.style.cursor = 'not-allowed';
    } else {
      checkoutBtn.style.opacity = '1';
      checkoutBtn.style.cursor = 'pointer';
    }
  }
  renderMenu();
}

async function fetchMenu() {
  try {
    const res = await fetch(`${API_URL}/items`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    menuItems = await res.json();
    renderMenu();
  } catch (err) {
    console.error('Failed to fetch menu', err);
  }
}

const escapeHtml = (str) => {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
};

function renderMenu(items) {
  if (items) menuItems = items;
  
  const filtered = menuItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = currentFilter === 'all' || 
                          (currentFilter === 'available' && item.available && item.stock > 0);
    return matchesSearch && matchesFilter;
  });

  // 3. Sort by Price
  if (currentSort === 'price-asc') {
    filtered.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  } else if (currentSort === 'price-desc') {
    filtered.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  }

  if (filtered.length === 0) {
    menuGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">No items found matching the criteria</div>`;
    return;
  }

  const currentIds = Array.from(menuGrid.children).map(c => c.getAttribute('data-item-id'));
  const newIds = filtered.filter(i => i.available).map(i => i.id.toString());
  const orderChanged = currentIds.join(',') !== newIds.join(',');

  if (orderChanged) {
    menuGrid.innerHTML = '';
    filtered.forEach(item => {
      if (!item.available) return;
      const div = document.createElement('div');
      div.className = 'menu-item glass-panel';
      div.setAttribute('data-item-id', item.id);
      
      const safeName = escapeHtml(item.name);
      const safePrice = escapeHtml(item.price);
      const safeStock = escapeHtml(item.stock);
      const safeImg = encodeURI(item.image || '');

      div.innerHTML = `
        <div class="item-img-wrap" style="position:relative;">
          <img src="${safeImg}" alt="${safeName}">
        </div>
        <div class="item-info">
          <h3>${safeName}</h3>
          <div class="item-price">₹${safePrice}</div>
          <div class="item-stock" style="font-size:0.85rem;color:${item.stock > 0 ? 'var(--text-muted)' : '#ff5252'};font-weight:600;margin-bottom:1rem;">
            ${item.stock > 0 ? `In Stock: ${safeStock}` : 'Out of Stock'}
          </div>
        </div>
        <button class="btn btn-secondary btn-add"
          onclick="addToCart(${escapeHtml(item.id)})"
          ${item.stock <= 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
          ${item.stock > 0 ? 'Add to Cart' : 'Sold Out'}
        </button>
      `;
      menuGrid.appendChild(div);
    });
  } else {
    // In-place update for existing items to prevent layout shifts/flickering
    filtered.forEach(item => {
      if (!item.available) return;
      const div = menuGrid.querySelector(`.menu-item[data-item-id="${item.id}"]`);
      if (div) {
        const stockDiv = div.querySelector('.item-stock');
        const btn = div.querySelector('.btn-add');
        
        stockDiv.style.color = item.stock > 0 ? 'var(--text-muted)' : '#ff5252';
        stockDiv.innerText = item.stock > 0 ? `In Stock: ${item.stock}` : 'Out of Stock';
        
        if (item.stock <= 0) {
          btn.setAttribute('disabled', 'true');
          btn.style.opacity = '0.5';
          btn.style.cursor = 'not-allowed';
          btn.innerText = 'Sold Out';
        } else {
          btn.removeAttribute('disabled');
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';
          btn.innerText = 'Add to Cart';
        }
      }
    });
  }
}

// --- Cart Logic ---
function addToCart(id) {
  socket.emit('update_cart', { itemId: id, change: 1 });
}
window.addToCart = addToCart;

function updateQuantity(id, change) {
  socket.emit('update_cart', { itemId: id, change: change });
}
window.updateQuantity = updateQuantity;

function renderCart() {
  cartItemsContainer.innerHTML = '';
  let total = 0;
  const keys = Object.keys(cart);

  if (keys.length === 0) {
    cartItemsContainer.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:2rem;">Cart is empty</p>';
    checkoutBtn.disabled = true;
    cartTotalElement.innerText = '₹0';
    updateCartCount();
    return;
  }

  keys.forEach(id => {
    const item = cart[id];
    total += item.price * item.quantity;
    const div = document.createElement('div');
    div.className = 'cart-item';
    const safeName = escapeHtml(item.name);
    const safePrice = escapeHtml(item.price);
    const safeQty = escapeHtml(item.quantity);
    const safeId = escapeHtml(id);

    div.innerHTML = `
      <div>
        <div style="font-weight:500;">${safeName}</div>
        <div style="font-size:0.9rem;color:var(--text-muted)">₹${safePrice} × ${safeQty}</div>
      </div>
      <div class="cart-item-controls">
        <button onclick="updateQuantity(${safeId}, -1)">-</button>
        <span>${safeQty}</span>
        <button onclick="updateQuantity(${safeId}, 1)">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(div);
  });

  cartTotalElement.innerText = `₹${total}`;
  checkoutBtn.disabled = false;
  checkoutBtn.onclick  = () => processCheckout(total);
  updateCartCount();
}

// --- Checkout - Zoho Payments ---
async function processCheckout(total) {
  checkoutBtn.disabled  = true;
  checkoutBtn.innerText = 'Creating Order...';

  try {
    const itemsList = Object.values(cart);
    const res = await fetch(`${API_URL}/orders/create`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ items: itemsList, total, socketId: socket.id })
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Failed to initiate order');
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
      return;
    }

    // Cart is preserved here in case they cancel/go back. 
    // It will be cleared upon successful payment.

    if (data.payment_url) {
      window.location.href = data.payment_url;
    } else {
      alert('Failed to obtain Payment URL from Gateway. The order has been saved and is pending payment.');
      window.location.href = 'orders.html';
    }

  } catch (err) {
    console.error(err);
    alert('Checkout Error: ' + (err.message || JSON.stringify(err)));
    checkoutBtn.disabled  = false;
    checkoutBtn.innerText = 'Proceed to Pay';
  }
}

// Socket event for menu updates
socket.on('menu_updated', () => fetchMenu());

// Ensure we fetch the latest menu once the socket connects, 
// guaranteeing the old socket's disconnect has finished releasing stock.
socket.on('connect', () => fetchMenu());

// Socket event for cart updates
socket.on('cart_updated', (serverCart) => {
  cart = {};
  for (const id in serverCart) {
    const item = menuItems.find(i => i.id == id);
    if (item) {
      cart[id] = { ...item, quantity: serverCart[id] };
    }
  }
  renderCart();
});

socket.on('cart_error', (msg) => {
  alert(msg);
});



// --- Nav Links ---injected dynamically) ---
const nav = document.querySelector('nav');
if (nav) {
  const ordersLink  = document.createElement('a');
  ordersLink.href   = 'orders.html';
  ordersLink.innerText = 'My Orders';
  nav.appendChild(ordersLink);

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

// --- Search, Filter --- Sort ---
if (menuSearchInput) {
  menuSearchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderMenu();
  });
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    renderMenu();
  });
});

const menuSortSelect = document.getElementById('menu-sort');
if (menuSortSelect) {
  menuSortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderMenu();
  });
}

// --- Mobile Cart Handling ---
const floatingCartBtn = document.getElementById('floating-cart-btn');
const cartPanel = document.getElementById('cart-panel');
const cartOverlay = document.getElementById('cart-overlay');
const closeCartBtn = document.getElementById('close-cart-btn');

if (floatingCartBtn && cartPanel && cartOverlay && closeCartBtn) {
  floatingCartBtn.onclick = () => {
    cartPanel.classList.add('open');
    cartOverlay.classList.add('open');
  };
  
  closeCartBtn.onclick = () => {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('open');
  };
  
  cartOverlay.onclick = () => {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('open');
  };
}

function updateCartCount() {
  const countBtn = document.getElementById('floating-cart-count');
  if (countBtn) {
    const totalItems = Object.values(cart).reduce((acc, item) => acc + item.quantity, 0);
    countBtn.innerText = totalItems;
  }
}

// --- Init ---
fetchMenu();
renderCart();

// Reload page if returned via browser bfcache (e.g., from Zoho redirect)
window.addEventListener('pageshow', function (event) {
  if (event.persisted) {
    window.location.reload();
  }
});


