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

// Current order context (used by Razorpay integration)
let currentOrderId  = null;

const socket = io({
  auth: { token }
});

// â”€â”€â”€ DOM Elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const menuGrid          = document.getElementById('menu-grid');
const cartItemsContainer= document.getElementById('cart-items');
const cartTotalElement  = document.getElementById('cart-total');
const checkoutBtn       = document.getElementById('checkout-btn');
const menuSearchInput   = document.getElementById('menu-search');



// â”€â”€â”€ Fetch & Render Menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  
  // 1. Filter by search query
  let filtered = menuItems.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );



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

  filtered.forEach(item => {
    if (!item.available) return;
    const div = document.createElement('div');
    div.className = 'menu-item glass-panel';
    

    div.innerHTML = `
      <div class="item-img-wrap" style="position:relative;">
        <img src="${item.image}" alt="${item.name}">

      </div>
      <div class="item-info">
        <h3>${item.name}</h3>
        <div class="item-price">â‚¹${item.price}</div>
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

// â”€â”€â”€ Cart Logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    cartTotalElement.innerText = 'â‚¹0';
    updateCartCount();
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
        <div style="font-size:0.9rem;color:var(--text-muted)">â‚¹${item.price} Ã— ${item.quantity}</div>
      </div>
      <div class="cart-item-controls">
        <button onclick="updateQuantity(${id}, -1)">âˆ’</button>
        <span>${item.quantity}</span>
        <button onclick="updateQuantity(${id}, 1)">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(div);
  });

  cartTotalElement.innerText = `â‚¹${total}`;
  checkoutBtn.disabled = false;
  checkoutBtn.onclick  = () => processCheckout(total);
  updateCartCount();
}

// â”€â”€â”€ Checkout â€” Zoho Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    if (data.paymentSessionId) {
      if (typeof ZPayments !== 'undefined') {
        const configRes = await fetch(`${API_URL}/zoho-config`);
        const configData = await configRes.json();

        let config = {
          "account_id": configData.account_id,
          "domain": "IN",
          "otherOptions": {
            "api_key": configData.api_key
          }
        };

        const zp = new ZPayments(config);
        
        // Wait for webhook to confirm via socket or navigate when the modal is closed
        socket.once('payment_confirmed', (msg) => {
           if (msg.orderId === data.orderId) {
               window.location.href = 'orders.html?payment=success';
           }
        });

        let options = {
          "amount": total.toString(),
          "currency_code": "INR",
          "payments_session_id": data.paymentSessionId,
          "description": "Order " + data.orderId
        };

        let widgetPromise;
        if (typeof zp.open === 'function') {
           widgetPromise = zp.open(options);
        } else if (typeof zp.requestPaymentMethod === 'function') {
           widgetPromise = zp.requestPaymentMethod(options);
        } else if (typeof zp.checkout === 'function') {
           widgetPromise = zp.checkout(options);
        } else {
           alert('Checkout Error: Unable to find payment method on Zoho widget. Methods available: ' + Object.keys(zp).join(', '));
           return;
        }

        try {
           let response = await widgetPromise;
           if (response) {
               // Fallback: forcefully verify with backend in case webhook is delayed or fails
               try {
                   await fetch(`${API_URL}/orders/verify-zoho-payment`, {
                       method: 'POST',
                       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                       body: JSON.stringify({ orderId: data.orderId, paymentSessionId: data.paymentSessionId })
                   });
               } catch(e) { console.error('Fallback verify failed:', e); }

               window.location.href = 'orders.html?payment=success';
           }
        } catch (widgetErr) {
           if (widgetErr && widgetErr.code !== 'widget_closed') {
               console.error("Widget Error:", widgetErr);
               alert("Payment failed: " + (widgetErr.message || JSON.stringify(widgetErr)));
           }
           // Reload to clear Zoho widget injected state if it fails or gets closed
           window.location.reload();
        }
      } else {
        alert('Payment initiated. Please check your Zoho Payments App.');
      }
      
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
    } else {
      alert('Failed to obtain Payment Session ID.');
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
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



// â”€â”€â”€ Nav Links (injected dynamically) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Search, Filter & Sort â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Mobile Cart Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
fetchMenu();
renderCart();

// Reload page if returned via browser bfcache (e.g., from Zoho redirect)
window.addEventListener('pageshow', function (event) {
  if (event.persisted) {
    window.location.reload();
  }
});

// --- Inject Mobile Bottom Navigation ---
const isMenu = window.location.pathname.includes('menu.html') || window.location.pathname === '/' || window.location.pathname.endsWith('canteen/');
const isOrders = window.location.pathname.includes('orders.html');

const mobileNavHTML = 
  <nav class="mobile-bottom-nav">
    <ul class="nav-items">
      <li>
        <a href="menu.html" class=" + (isMenu ? 'active' : '') + ">
          <i class="fa-solid fa-utensils"></i>
          <span>Menu</span>
        </a>
      </li>
      <li>
        <a href="#" class="cart-trigger" id="mobile-cart-trigger">
          <i class="fa-solid fa-basket-shopping"></i>
          <span>Cart</span>
          <span class="cart-badge" id="bottom-nav-cart-badge" style="display:none">0</span>
        </a>
      </li>
      <li>
        <a href="orders.html" class=" + (isOrders ? 'active' : '') + ">
          <i class="fa-solid fa-receipt"></i>
          <span>Orders</span>
        </a>
      </li>
      <li>
        <a href="#" id="mobile-logout-btn">
          <i class="fa-solid fa-arrow-right-from-bracket"></i>
          <span>Logout</span>
        </a>
      </li>
    </ul>
  </nav>
;
document.body.insertAdjacentHTML('beforeend', mobileNavHTML);

const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
if (mobileLogoutBtn) {
  mobileLogoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
}

const mobileCartTrigger = document.getElementById('mobile-cart-trigger');
if (mobileCartTrigger) {
  mobileCartTrigger.onclick = (e) => {
    e.preventDefault();
    const cartPanel = document.getElementById('cart-panel');
    if (cartPanel) cartPanel.classList.add('open');
  };
}