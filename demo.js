// Generates practice data for the /demo dashboard: ~90 days of made-up orders,
// customers, payments and stock movements. Names and phone numbers are fake.
// Nothing here touches the real data.json or the WhatsApp bot.

function rng(seed) {
  // Small deterministic random generator so the demo looks the same each reset (same day)
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ana", "Luis", "María", "Carlos", "Sofía", "Jorge", "Lucía", "Miguel", "Valeria", "Diego",
  "Fernanda", "Andrés", "Paola", "Ricardo", "Camila", "Héctor", "Daniela", "Iván", "Mariana", "Pablo",
  "Regina", "Tomás", "Ximena", "Óscar", "Renata", "Emilio", "Natalia", "Raúl", "Carmen", "Sergio",
  "Elena", "Bruno", "Alejandra", "Gabriel", "Laura"];
const LAST = ["Demo", "Prueba", "Ejemplo", "Muestra", "Ficticio"];
const ZONES = ["Selvanova", "Playacar", "Centro", "Zazil-Ha", "Real Ibiza", "Villas del Sol",
  "Misión del Carmen", "Colosio", "Puerto Aventuras", "Gonzalo Guerrero"];

// Quintana Roo is UTC-5 all year
function localDate(y, m, d, hour, min) {
  return new Date(Date.UTC(y, m, d, hour + 5, min)).toISOString();
}
function dayStr(iso) {
  return new Date(new Date(iso).getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function generateDemoData(now = new Date()) {
  const today = new Date(now.getTime() - 5 * 3600 * 1000); // local "today"
  const seedDay = Number(today.toISOString().slice(0, 10).replace(/-/g, ""));
  const r = rng(seedDay);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));

  const data = {
    demo: true,
    inventory: {
      grande: { label: "Grande (18 huevos)", price: 100, stock: 60, pieces: 18 },
      extra:  { label: "Extra (30 huevos)",  price: 165, stock: 40, pieces: 30 },
    },
    orders: [], payments: [], customers: [], stockMoves: [],
    nextOrderId: 1, nextPaymentId: 1, nextCustomerId: 1, nextMoveId: 1,
  };

  // Customers: retail (WhatsApp) + two wholesale accounts
  for (let i = 0; i < 35; i++) {
    data.customers.push({
      id: data.nextCustomerId++,
      name: `${FIRST[i]} ${pick(LAST)}`,
      phone: `+52984000${String(1000 + i)}`,
      zone: pick(ZONES), address: "", mapsUrl: "", notes: "",
      createdAt: localDate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 90, 9, 0),
    });
  }
  const wholesale = [
    { name: "Restaurante Demo La Ceiba", notes: "Mayoreo · paga semanal" },
    { name: "Hotel Demo Coral", notes: "Mayoreo · paga cada 15 días" },
  ].map((w, i) => {
    const c = { id: data.nextCustomerId++, name: w.name, phone: `+52984000${2000 + i}`, zone: "Playacar",
      address: "", mapsUrl: "", notes: w.notes, createdAt: data.customers[0].createdAt };
    data.customers.push(c);
    return c;
  });
  const retail = data.customers.filter(c => !wholesale.includes(c));

  const move = (product, change, reason, createdAt, orderId, note) => {
    data.inventory[product].stock += change;
    data.stockMoves.push({ id: data.nextMoveId++, product, change, stockAfter: data.inventory[product].stock,
      reason, orderId: orderId || null, note: note || "", createdAt });
  };
  const pay = (order, customerId, amount, method, iso, note) => {
    data.payments.push({ id: data.nextPaymentId++, orderId: order ? order.id : null, customerId,
      amount, method, date: dayStr(iso), note: note || "", createdAt: iso });
  };
  const methodPick = () => { const x = r(); return x < 0.6 ? "efectivo" : x < 0.95 ? "transferencia" : "tarjeta"; };

  for (let back = 90; back >= 0; back--) {
    const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate() - back;
    const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();

    // Farm delivery: restock on Mondays, plus an extra delivery whenever stock runs low
    for (const [p, amt] of [["grande", 25], ["extra", 15]]) {
      if (weekday === 1 || data.inventory[p].stock < 8) {
        move(p, amt, "restock", localDate(y, m, d, 7, 30), null, "Llegada de granja");
      }
    }

    // Retail WhatsApp orders
    const n = between(weekday === 0 ? 1 : 3, weekday === 6 ? 9 : 7);
    for (let k = 0; k < n; k++) {
      const product = r() < 0.6 ? "grande" : "extra";
      const qty = r() < 0.7 ? 1 : between(2, 3);
      if (data.inventory[product].stock < qty) continue;
      const inv = data.inventory[product];
      const createdAt = localDate(y, m, d, between(8, 19), between(0, 59));
      const cust = pick(retail);
      const recent = back <= 1;
      const status = recent ? (r() < 0.5 ? "accepted" : "preparing") : (r() < 0.05 ? "cancelled" : "delivered");
      const order = {
        id: data.nextOrderId++, source: "whatsapp", customerId: cust.id, phone: `whatsapp:${cust.phone}`,
        product, productLabel: inv.label, quantity: qty, unitPrice: inv.price, pieces: qty * inv.pieces,
        total: qty * inv.price,
        location: { latitude: (20.63 + (r() - 0.5) * 0.06).toFixed(5), longitude: (-87.08 + (r() - 0.5) * 0.06).toFixed(5) },
        status, note: "", createdAt,
      };
      data.orders.push(order);
      move(product, -qty, "order", createdAt, order.id);
      if (status === "cancelled") { move(product, qty, "cancel", createdAt, order.id); continue; }
      if (status === "delivered") {
        const x = r();
        if (x < 0.88) pay(order, cust.id, order.total, methodPick(), createdAt);
        else if (x < 0.94) pay(order, cust.id, Math.round(order.total / 2), "efectivo", createdAt, "Pagó la mitad");
        // else: still owes everything
      }
    }

    // Wholesale: crates every Tuesday, paid in lump sums later (like the restaurant in the sheet)
    if (weekday === 2) {
      for (const w of wholesale) {
        const createdAt = localDate(y, m, d, 9, 0);
        const lines = [["Reja huevo grande", 1440, between(2, 4)], ["Reja huevo mediano", 1080, between(1, 2)]];
        for (const [label, price, qty] of lines) {
          data.orders.push({
            id: data.nextOrderId++, source: "manual", customerId: w.id, phone: `whatsapp:${w.phone}`,
            product: "otro", productLabel: label, quantity: qty, unitPrice: price, pieces: qty * 360,
            total: qty * price, location: null, status: back <= 1 ? "accepted" : "delivered", note: "", createdAt,
          });
        }
      }
    }
    // Wholesale payments on Fridays: roughly last week's bill, sometimes a bit short
    if (weekday === 5 && back > 0) {
      for (const w of wholesale) {
        const billed = data.orders.filter(o => o.customerId === w.id && o.status !== "cancelled").reduce((s, o) => s + o.total, 0);
        const paid = data.payments.filter(p => p.customerId === w.id).reduce((s, p) => s + p.amount, 0);
        const owed = billed - paid;
        if (owed <= 0) continue;
        const amount = Math.round(owed * (r() < 0.7 ? 1 : 0.6) / 10) * 10;
        if (amount > 0) pay(null, w.id, amount, r() < 0.7 ? "transferencia" : "efectivo", localDate(y, m, d, 17, 0), "Pago semanal");
      }
    }
  }

  return data;
}

module.exports = { generateDemoData };
