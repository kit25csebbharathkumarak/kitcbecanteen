const API_URL = `${window.location.origin}/api`;

const token = localStorage.getItem('token');
const user  = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

let cart       = {};
let menuItems  = [];
let searchQuery = '';

// Current order context (used by Razorpay integration)
let currentOrderId  = null;

const socket = io();

// ─── DOM Elements ──────────────────────────────────────────────────────────────
const menuGrid          = document.getElementById('menu-grid');
const cartItemsContainer= document.getElementById('cart-items');
const cartTotalElement  = document.getElementById('cart-total');
const checkoutBtn       = document.getElementById('checkout-btn');
const menuSearchInput   = document.getElementById('menu-search');

const razorpayModal         = document.getElementById('razorpay-modal');
const closeRazorpayModalBtn = document.getElementById('close-razorpay-modal');
const razorpayAmountDisplay = document.getElementById('razorpay-amount-display');
const razorpayOrderIdDisplay = document.getElementById('razorpay-order-id-display');
const razorpayOrderIdInput   = document.getElementById('razorpay-order-id-input');

// ─── Fetch & Render Menu ───────────────────────────────────────────────────────
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

function renderMenu() {
  menuGrid.innerHTML = '';
  const filtered = menuItems.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    menuGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">No items found matching "${searchQuery}"</div>`;
    return;
  }

  filtered.forEach(item => {
    if (!item.available) return;
    const div = document.createElement('div');
    div.className = 'menu-item glass-panel';
    div.innerHTML = `
      <div class="item-img-wrap">
        <img src="${item.image}" alt="${item.name}">
      </div>
      <div class="item-info">
        <h3>${item.name}</h3>
        <div class="item-price">₹${item.price}</div>
        <div style="font-size:0.85rem;color:${item.stock > 0 ? 'var(--text-muted)' : '#ff5252'};font-weight:600;margin-bottom:1rem;">
          ${item.stock > 0 ? `In Stock: ${item.stock}` : 'Out of Stock'}
        </div>
      </div>
      <button class="btn btn-secondary btn-add"
        onclick="addToCart(${item.id})"
        ${item.stock <= 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
        ${item.stock > 0 ? 'Add to Cart' : 'Sold Out'}
      </button>
    `;
    menuGrid.appendChild(div);
  });
}

// ─── Cart Logic ────────────────────────────────────────────────────────────────
function addToCart(id) {
  const item = menuItems.find(i => i.id === id);
  if (!item || item.stock <= 0) return;

  if (cart[id]) {
    if (cart[id].quantity >= item.stock) {
      alert(`Only ${item.stock} units available in stock.`);
      return;
    }
    cart[id].quantity += 1;
  } else {
    cart[id] = { ...item, quantity: 1 };
  }
  renderCart();
}
window.addToCart = addToCart;

function updateQuantity(id, change) {
  if (!cart[id]) return;
  const item = menuItems.find(i => i.id === id);
  if (change > 0 && cart[id].quantity >= item.stock) {
    alert(`Only ${item.stock} units available in stock.`);
    return;
  }
  cart[id].quantity += change;
  if (cart[id].quantity <= 0) delete cart[id];
  renderCart();
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
    return;
  }

  keys.forEach(id => {
    const item = cart[id];
    total += item.price * item.quantity;
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div>
        <div style="font-weight:500;">${item.name}</div>
        <div style="font-size:0.9rem;color:var(--text-muted)">₹${item.price} × ${item.quantity}</div>
      </div>
      <div class="cart-item-controls">
        <button onclick="updateQuantity(${id}, -1)">−</button>
        <span>${item.quantity}</span>
        <button onclick="updateQuantity(${id}, 1)">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(div);
  });

  cartTotalElement.innerText = `₹${total}`;
  checkoutBtn.disabled = false;
  checkoutBtn.onclick  = () => processCheckout(total);
}

// ─── Checkout — Razorpay Payment ───────────────────────────────────────────────
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
      body: JSON.stringify({ items: itemsList, total })
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Failed to initiate order');
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
      return;
    }

    // Clear cart before showing modal
    cart = {};
    renderCart();

    if (data.orderId) {
      // Set the hidden input and displays in modal
      razorpayOrderIdInput.value = data.orderId;
      razorpayOrderIdDisplay.innerText = data.orderId;
      razorpayAmountDisplay.innerText = `₹${total}`;
      
      // Open the Razorpay payment modal
      razorpayModal.classList.add('active');
      
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
    } else {
      alert('Failed to obtain Order ID.');
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
    }

  } catch (err) {
    console.error(err);
    alert('An error occurred. Please try again.');
    checkoutBtn.disabled  = false;
    checkoutBtn.innerText = 'Proceed to Pay';
  }
}

// Socket event for menu updates
socket.on('menu_updated', () => fetchMenu());

// ─── Close Modal ──────────────────────────────────────────────────────────────

if (closeRazorpayModalBtn) {
  closeRazorpayModalBtn.onclick = () => {
    razorpayModal.classList.remove('active');
  };
}

// ─── Nav Links (injected dynamically) ────────────────────────────────────────
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

// ─── Search ───────────────────────────────────────────────────────────────────
if (menuSearchInput) {
  menuSearchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderMenu();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
fetchMenu();
