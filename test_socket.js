const { io } = require('socket.io-client');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./canteen.db');

async function test() {
  console.log('Fetching initial stock...');
  db.get('SELECT stock FROM items WHERE id = 1', (err, row) => {
    console.log('Initial stock:', row.stock);
    
    const socket = io('http://localhost:3000');
    socket.on('connect', () => {
      console.log('Socket connected, adding to cart...');
      socket.emit('update_cart', { itemId: 1, change: 1 });
      
      setTimeout(() => {
        db.get('SELECT stock FROM items WHERE id = 1', (err, row2) => {
          console.log('Stock after add:', row2.stock);
          console.log('Disconnecting socket...');
          socket.disconnect();
          
          setTimeout(() => {
            db.get('SELECT stock FROM items WHERE id = 1', (err, row3) => {
              console.log('Stock after disconnect:', row3.stock);
              process.exit(0);
            });
          }, 1000);
        });
      }, 1000);
    });
  });
}
test();
