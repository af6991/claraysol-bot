const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");
const { generateDemoData } = require("./demo");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Auth middleware for dashboard ───────────────────────────────────────────
const DASHBOARD_USER = process.env.DASHBOARD_USER || "claraySol";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "huevos2024";

function requireAuth(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Clara y Sol Dashboard"');
    return res.status(401).send("Acceso requerido");
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (sep > -1 && user === DASHBOARD_USER && pass === DASHBOARD_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Clara y Sol Dashboard"');
  return res.status(401).send("Usuario o contraseña incorrectos");
}

// Protect dashboard and API routes
app.use("/api", requireAuth);
app.use("/dashboard", requireAuth);

// Serve login-protected dashboard (real data at /, practice data at /demo)
const sendDashboard = (req, res) => res.sendFile(path.join(__dirname, "public", "index.html"));
app.get("/", requireAuth, sendDashboard);
app.get("/index.html", requireAuth, sendDashboard);
app.get(["/demo", "/demo/"], requireAuth, sendDashboard);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ─── Persistent state ─────────────────────────────────────────────────────────
// On Railway, the app's own disk is wiped on every deploy. If a Volume is attached,
// Railway sets RAILWAY_VOLUME_MOUNT_PATH and we store orders + stock there instead.
// Locally (no volume) it just uses data.json next to server.js, like before.
const DATA_DIR  = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const SEED_FILE = path.join(__dirname, "data.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
// First run on a fresh volume: start from the prices/stock in data.json
if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, DATA_FILE);
}

const ORDER_STATUSES  = ["accepted", "preparing", "delivered", "cancelled"];
const PAYMENT_METHODS = ["efectivo", "transferencia", "tarjeta", "otro"];

function maxId(list) {
  return list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
}

function cleanPhone(phone) {
  return String(phone || "").replace(/^whatsapp:/i, "").trim();
}

// Brings older data.json files up to the current shape (customers, payments,
// stock movements, pieces per carton). Safe to run on every load.
function normalize(data) {
  data.inventory  = data.inventory  || {};
  data.orders     = data.orders     || [];
  data.payments   = data.payments   || [];
  data.customers  = data.customers  || [];
  data.stockMoves = data.stockMoves || [];

  for (const [key, item] of Object.entries(data.inventory)) {
    if (!item.pieces) {
      const m = String(item.label || "").match(/\((\d+)/);
      item.pieces = m ? parseInt(m[1], 10) : (key === "extra" ? 30 : 18);
    }
  }

  data.nextOrderId    = Math.max(data.nextOrderId    || 1, maxId(data.orders) + 1);
  data.nextPaymentId  = Math.max(data.nextPaymentId  || 1, maxId(data.payments) + 1);
  data.nextCustomerId = Math.max(data.nextCustomerId || 1, maxId(data.customers) + 1);
  data.nextMoveId     = Math.max(data.nextMoveId     || 1, maxId(data.stockMoves) + 1);

  for (const o of data.orders) {
    if (!o.source) o.source = "whatsapp";
    if (o.unitPrice === undefined) o.unitPrice = o.quantity ? o.total / o.quantity : 0;
    if (o.pieces === undefined) {
      const inv = data.inventory[o.product];
      o.pieces = (inv ? inv.pieces : 0) * (o.quantity || 0);
    }
    if (!o.customerId && o.phone) {
      o.customerId = findOrCreateCustomer(data, { phone: o.phone, createdAt: o.createdAt }).id;
    }
  }
  return data;
}

function loadData(file = DATA_FILE) {
  let data;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    data = normalize(JSON.parse(raw));
    // Save once if an older file was upgraded, so new IDs (customers etc.) stay fixed
    if (JSON.stringify(data, null, 2) !== raw) saveData(data, file);
    return data;
  } else {
    data = {
      inventory: {
        grande: { label: "Grande (18 huevos)", price: 100, stock: 50, pieces: 18 },
        extra:  { label: "Extra (30 huevos)",  price: 165, stock: 30, pieces: 30 },
      },
      orders: [],
      nextOrderId: 1,
    };
  }
  return normalize(data);
}

function saveData(data, file = DATA_FILE) {
  // Write to a temp file first, then swap it in, so a crash mid-save can't corrupt orders/stock
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Demo data lives in its own file, never mixed with real orders or stock
const DEMO_FILE = path.join(DATA_DIR, "demo-data.json");
function ensureDemoData(reset) {
  if (reset || !fs.existsSync(DEMO_FILE)) saveData(generateDemoData(), DEMO_FILE);
}

// ─── Helpers for customers, stock and payments ───────────────────────────────
function findOrCreateCustomer(data, { phone, name, createdAt }) {
  const p = cleanPhone(phone);
  let c = p ? data.customers.find(x => cleanPhone(x.phone) === p) : null;
  if (!c) {
    c = {
      id: data.nextCustomerId++,
      name: (name || "").trim(),
      phone: p,
      zone: "",
      address: "",
      mapsUrl: "",
      notes: "",
      createdAt: createdAt || new Date().toISOString(),
    };
    data.customers.push(c);
  } else if (name && !c.name) {
    c.name = name.trim();
  }
  return c;
}

function moveStock(data, product, change, reason, extra = {}) {
  const item = data.inventory[product];
  item.stock += change;
  data.stockMoves.push({
    id: data.nextMoveId++,
    product,
    change,
    stockAfter: item.stock,
    reason,                       // restock | order | cancel | reactivate | adjust
    orderId: extra.orderId || null,
    note: extra.note || "",
    createdAt: new Date().toISOString(),
  });
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

function toMoney(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// Accepts "YYYY-MM-DD" or a full ISO date; returns a valid ISO string or null
function toIsoDate(v) {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T12:00:00" : v);
  return isNaN(d) ? null : d.toISOString();
}

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = {};

function getSession(from) {
  if (!sessions[from]) sessions[from] = { step: "welcome", cart: {} };
  return sessions[from];
}

function clearSession(from) {
  sessions[from] = { step: "welcome", cart: {} };
}

// ─── Twilio reply helper ──────────────────────────────────────────────────────
function twimlReply(res, message) {
  console.log(`   ↳ respuesta: ${String(message).split("\n")[0]}`);
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type("text/xml").send(twiml.toString());
}

// ─── Webhook (no auth — Twilio must reach this freely) ───────────────────────
// Browser check: opening /webhook shows this message
app.get("/webhook", (req, res) => {
  res.type("text/plain").send(
    "✅ Clara y Sol: el webhook está activo. Twilio debe llamar a esta dirección con POST."
  );
});

app.post("/webhook", (req, res) => {
  const from        = req.body.From;
  const body        = (req.body.Body || "").trim().toLowerCase();
  const rawBody     = (req.body.Body || "").trim();
  const hasLocation = req.body.Latitude && req.body.Longitude;
  const latitude    = req.body.Latitude;
  const longitude   = req.body.Longitude;
  const profileName = (req.body.ProfileName || "").trim();

  const data = loadData();

  // Allow restart at any time ("Hola", "hola!", "Menú"...). Ignore punctuation/accents-free matching.
  const greeting = body.replace(/[^\p{L}\s]/gu, "").trim();
  if (["hola", "inicio", "hi", "menu", "menú", "hello", "buenas"].includes(greeting)) {
    clearSession(from);
  }
  // Fetch the session AFTER any reset so we always work with the fresh one
  const session = getSession(from);
  if (profileName) session.profileName = profileName;

  console.log(
    `📩 ${new Date().toISOString()} | ${from} | texto: "${rawBody}" | ` +
    `ubicación: ${hasLocation ? "sí" : "no"} | paso: ${session.step}`
  );

  // ── STEP: welcome ────────────────────────────────────────────────────────
  if (session.step === "welcome") {
    session.step = "select_product";
    const inv = data.inventory;
    const available = Object.entries(inv)
      .filter(([, v]) => v.stock > 0)
      .map(([k, v]) => `  ${k === "grande" ? "1" : "2"}️⃣ ${v.label} — $${v.price} MXN`)
      .join("\n");

    if (!available) {
      clearSession(from);
      return twimlReply(res,
        "🥚 ¡Hola! Gracias por contactar a *Clara y Sol*.\n\n" +
        "Por el momento no tenemos inventario disponible. " +
        "¡Pronto tendremos más! Escríbenos después. 🌻"
      );
    }

    return twimlReply(res,
      "🌻 ¡Hola! Bienvenido a *Clara y Sol*.\n" +
      "Huevos frescos directo a tu puerta. 🥚\n\n" +
      "¿Qué tamaño de cartón deseas?\n\n" +
      `${available}\n\n` +
      "_Responde con el número de tu elección._"
    );
  }

  // ── STEP: select_product ─────────────────────────────────────────────────
  if (session.step === "select_product") {
    const inv = data.inventory;
    let chosen = null;
    if (body === "1" && inv.grande && inv.grande.stock > 0) chosen = "grande";
    if (body === "2" && inv.extra  && inv.extra.stock  > 0) chosen = "extra";

    if (!chosen) {
      return twimlReply(res, "Por favor responde *1* para Grande o *2* para Extra. 🥚");
    }

    session.product = chosen;
    session.step    = "select_quantity";
    const maxQty    = Math.min(inv[chosen].stock, 10);

    return twimlReply(res,
      `Has elegido: *${inv[chosen].label}* — $${inv[chosen].price} MXN c/u\n\n` +
      `¿Cuántos cartones deseas? (máximo ${maxQty})\n\n` +
      `_Responde con un número del 1 al ${maxQty}._`
    );
  }

  // ── STEP: select_quantity ────────────────────────────────────────────────
  if (session.step === "select_quantity") {
    const inv    = data.inventory;
    const qty    = parseInt(rawBody, 10);
    const maxQty = Math.min(inv[session.product].stock, 10);

    if (maxQty < 1) {
      clearSession(from);
      return twimlReply(res,
        "😔 Lo sentimos, ese tamaño se acaba de agotar. Escríbenos *Hola* para ver lo disponible."
      );
    }

    if (isNaN(qty) || qty < 1 || qty > maxQty) {
      return twimlReply(res, `Por favor ingresa un número entre 1 y ${maxQty}.`);
    }

    session.quantity = qty;
    session.step     = "request_location";
    const prod       = inv[session.product];

    return twimlReply(res,
      `📦 *Resumen de tu pedido:*\n` +
      `  • ${prod.label} × ${qty}\n` +
      `  • Total: *$${qty * prod.price} MXN*\n\n` +
      `📍 Ahora necesito tu ubicación para la entrega.\n\n` +
      `Por favor comparte tu *ubicación de WhatsApp*\n` +
      `(toca el clip 📎 → Ubicación → Enviar ubicación actual).`
    );
  }

  // ── STEP: request_location ───────────────────────────────────────────────
  if (session.step === "request_location") {
    if (!hasLocation) {
      return twimlReply(res,
        "📍 Aún necesito tu *ubicación de WhatsApp*.\n\n" +
        "Toca el clip 📎 → Ubicación → Enviar ubicación actual."
      );
    }

    session.location = { latitude, longitude };
    session.step     = "confirm";
    const inv        = data.inventory;
    const prod       = inv[session.product];

    return twimlReply(res,
      `✅ ¡Perfecto! Recibimos tu ubicación.\n\n` +
      `*Confirma tu pedido:*\n` +
      `  • ${prod.label} × ${session.quantity}\n` +
      `  • Total: *$${session.quantity * prod.price} MXN*\n` +
      `  • Entrega en tu ubicación compartida\n\n` +
      `¿Todo correcto?\n` +
      `  1️⃣ Sí, confirmar\n` +
      `  2️⃣ No, cancelar\n\n` +
      "_Responde 1 o 2._"
    );
  }

  // ── STEP: confirm ────────────────────────────────────────────────────────
  if (session.step === "confirm") {
    if (body === "2") {
      clearSession(from);
      return twimlReply(res,
        "❌ Pedido cancelado. ¡Cuando quieras volver, escríbenos *Hola*! 🌻"
      );
    }

    if (body !== "1") {
      return twimlReply(res, "Por favor responde *1* para confirmar o *2* para cancelar.");
    }

    const inv     = data.inventory;
    const product = session.product;
    const qty     = session.quantity;

    if (inv[product].stock < qty) {
      clearSession(from);
      return twimlReply(res,
        "😔 Lo sentimos, el inventario cambió y ya no tenemos suficientes cartones. " +
        "Escríbenos *Hola* para ver lo disponible."
      );
    }

    const customer = findOrCreateCustomer(data, { phone: from, name: session.profileName || profileName });
    if (!customer.mapsUrl && session.location) {
      customer.mapsUrl = `https://maps.google.com/?q=${session.location.latitude},${session.location.longitude}`;
    }

    const orderId = data.nextOrderId++;
    const order = {
      id:           orderId,
      source:       "whatsapp",
      customerId:   customer.id,
      phone:        from,
      product,
      productLabel: inv[product].label,
      quantity:     qty,
      unitPrice:    inv[product].price,
      pieces:       qty * inv[product].pieces,
      total:        qty * inv[product].price,
      location:     session.location,
      status:       "accepted",
      note:         "",
      createdAt:    new Date().toISOString(),
    };
    data.orders.push(order);
    moveStock(data, product, -qty, "order", { orderId });
    saveData(data);
    clearSession(from);

    return twimlReply(res,
      `🎉 *¡Pedido #${orderId} aceptado!*\n\n` +
      `  • ${inv[product].label} × ${qty}\n` +
      `  • Total: *$${order.total} MXN*\n\n` +
      `Nos pondremos en contacto para coordinar la entrega.\n` +
      `¡Gracias por elegir *Clara y Sol*! 🌻🥚`
    );
  }

  return twimlReply(res, "¡Hola! Escribe *Hola* para hacer un pedido. 🌻");
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
// The same routes serve the real data (/api/...) and the demo data (/demo/api/...).
const api = express.Router();

api.get("/data", (req, res) => res.json(loadData(req.dataFile)));

// Inventory: change price, add stock (restock) or set the exact count (adjust)
api.post("/inventory", (req, res) => {
  const { product, stock, price, add, note } = req.body;
  const data = loadData(req.dataFile);
  if (!data.inventory[product]) return res.status(400).json({ error: "Producto no encontrado" });

  if (price !== undefined && price !== "") {
    const p = toMoney(price);
    if (isNaN(p) || p <= 0) return res.status(400).json({ error: "Precio no válido" });
    data.inventory[product].price = p;
  }
  if (add !== undefined && add !== "") {
    const n = toInt(add);
    if (isNaN(n) || n === 0) return res.status(400).json({ error: "Cantidad no válida" });
    if (data.inventory[product].stock + n < 0) return res.status(400).json({ error: "El stock no puede quedar negativo" });
    moveStock(data, product, n, "restock", { note: note || "" });
  }
  if (stock !== undefined && stock !== "") {
    const target = toInt(stock);
    if (isNaN(target) || target < 0) return res.status(400).json({ error: "Stock no válido" });
    const diff = target - data.inventory[product].stock;
    if (diff !== 0) moveStock(data, product, diff, "adjust", { note: note || "Conteo manual" });
  }
  saveData(data, req.dataFile);
  res.json({ ok: true, inventory: data.inventory });
});

// Manual order (phone orders, wholesale, deliveries not made through WhatsApp)
api.post("/orders", (req, res) => {
  const b = req.body || {};
  const data = loadData(req.dataFile);

  let customer = null;
  if (b.customerId) {
    customer = data.customers.find(c => c.id === toInt(b.customerId));
    if (!customer) return res.status(400).json({ error: "Cliente no encontrado" });
  } else {
    const name  = String(b.customerName || "").trim();
    const phone = cleanPhone(b.customerPhone);
    if (!name && !phone) return res.status(400).json({ error: "Escribe el nombre o teléfono del cliente" });
    customer = findOrCreateCustomer(data, { phone, name });
    if (!phone && !customer.name) customer.name = name;
  }

  const qty = toInt(b.quantity);
  if (isNaN(qty) || qty < 1) return res.status(400).json({ error: "Cantidad no válida" });

  const inv = data.inventory[b.product];
  let label, unitPrice, piecesPerUnit;
  if (inv) {
    label         = inv.label;
    unitPrice     = b.unitPrice !== undefined && b.unitPrice !== "" ? toMoney(b.unitPrice) : inv.price;
    piecesPerUnit = inv.pieces;
    if (inv.stock < qty) return res.status(400).json({ error: `Solo hay ${inv.stock} en stock de ${inv.label}` });
  } else if (b.product === "otro") {
    label         = String(b.description || "").trim();
    unitPrice     = toMoney(b.unitPrice);
    piecesPerUnit = toInt(b.piecesPerUnit);
    if (!label) return res.status(400).json({ error: "Escribe la descripción del producto" });
    if (isNaN(piecesPerUnit) || piecesPerUnit < 0) piecesPerUnit = 0;
  } else {
    return res.status(400).json({ error: "Producto no válido" });
  }
  if (isNaN(unitPrice) || unitPrice < 0) return res.status(400).json({ error: "Precio no válido" });

  const createdAt = toIsoDate(b.date) || new Date().toISOString();
  const orderId = data.nextOrderId++;
  const order = {
    id:           orderId,
    source:       "manual",
    customerId:   customer.id,
    phone:        customer.phone ? `whatsapp:${customer.phone}` : "",
    product:      inv ? b.product : "otro",
    productLabel: label,
    quantity:     qty,
    unitPrice,
    pieces:       qty * piecesPerUnit,
    total:        Math.round(qty * unitPrice * 100) / 100,
    location:     null,
    status:       ORDER_STATUSES.includes(b.status) ? b.status : "accepted",
    note:         String(b.note || "").trim(),
    createdAt,
  };
  data.orders.push(order);
  if (inv) moveStock(data, b.product, -qty, "order", { orderId });

  const paid = toMoney(b.paidAmount);
  if (!isNaN(paid) && paid > 0) {
    data.payments.push({
      id: data.nextPaymentId++,
      orderId,
      customerId: customer.id,
      amount: paid,
      method: PAYMENT_METHODS.includes(b.payMethod) ? b.payMethod : "efectivo",
      date: (toIsoDate(b.date) || new Date().toISOString()).slice(0, 10),
      note: "",
      createdAt: new Date().toISOString(),
    });
  }

  saveData(data, req.dataFile);
  res.json({ ok: true, order });
});

// Status change. Cancelling puts the cartons back in stock; un-cancelling takes them out again.
api.post("/orders/:id/status", (req, res) => {
  const data   = loadData(req.dataFile);
  const order  = data.orders.find(o => o.id === parseInt(req.params.id, 10));
  const status = req.body.status;
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Estado no válido" });

  const inv = data.inventory[order.product];
  const wasCancelled = order.status === "cancelled";
  const nowCancelled = status === "cancelled";

  if (inv && !wasCancelled && nowCancelled) {
    moveStock(data, order.product, order.quantity, "cancel", { orderId: order.id });
  } else if (inv && wasCancelled && !nowCancelled) {
    if (inv.stock < order.quantity) {
      return res.status(400).json({ error: `No hay stock suficiente para reactivar (quedan ${inv.stock})` });
    }
    moveStock(data, order.product, -order.quantity, "reactivate", { orderId: order.id });
  }

  order.status = status;
  if (status === "delivered" && !order.deliveredAt) order.deliveredAt = new Date().toISOString();
  saveData(data, req.dataFile);
  res.json({ ok: true, order });
});

// Payments: linked to an order, or to a customer as a general payment (e.g. wholesale weekly payment)
api.post("/payments", (req, res) => {
  const b = req.body || {};
  const data = loadData(req.dataFile);
  let customerId = toInt(b.customerId);
  let orderId    = b.orderId ? toInt(b.orderId) : null;

  if (orderId) {
    const order = data.orders.find(o => o.id === orderId);
    if (!order) return res.status(400).json({ error: "Pedido no encontrado" });
    customerId = order.customerId;
  }
  if (!data.customers.find(c => c.id === customerId)) {
    return res.status(400).json({ error: "Cliente no encontrado" });
  }

  const amount = toMoney(b.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "Monto no válido" });

  const payment = {
    id: data.nextPaymentId++,
    orderId,
    customerId,
    amount,
    method: PAYMENT_METHODS.includes(b.method) ? b.method : "efectivo",
    date: (toIsoDate(b.date) || new Date().toISOString()).slice(0, 10),
    note: String(b.note || "").trim(),
    createdAt: new Date().toISOString(),
  };
  data.payments.push(payment);
  saveData(data, req.dataFile);
  res.json({ ok: true, payment });
});

api.delete("/payments/:id", (req, res) => {
  const data = loadData(req.dataFile);
  const idx = data.payments.findIndex(p => p.id === parseInt(req.params.id, 10));
  if (idx === -1) return res.status(404).json({ error: "Pago no encontrado" });
  data.payments.splice(idx, 1);
  saveData(data, req.dataFile);
  res.json({ ok: true });
});

// Customers: create or edit name, phone, zone, address, map link, notes
api.post("/customers", (req, res) => {
  const b = req.body || {};
  const data = loadData(req.dataFile);
  const name = String(b.name || "").trim();
  if (!name && !cleanPhone(b.phone)) return res.status(400).json({ error: "Escribe el nombre o teléfono" });
  const c = findOrCreateCustomer(data, { phone: b.phone, name });
  for (const f of ["name", "zone", "address", "mapsUrl", "notes"]) {
    if (b[f] !== undefined) c[f] = String(b[f]).trim();
  }
  saveData(data, req.dataFile);
  res.json({ ok: true, customer: c });
});

api.post("/customers/:id", (req, res) => {
  const b = req.body || {};
  const data = loadData(req.dataFile);
  const c = data.customers.find(x => x.id === parseInt(req.params.id, 10));
  if (!c) return res.status(404).json({ error: "Cliente no encontrado" });
  if (b.phone !== undefined) {
    const p = cleanPhone(b.phone);
    if (p && data.customers.some(x => x.id !== c.id && cleanPhone(x.phone) === p)) {
      return res.status(400).json({ error: "Otro cliente ya tiene ese teléfono" });
    }
    c.phone = p;
  }
  for (const f of ["name", "zone", "address", "mapsUrl", "notes"]) {
    if (b[f] !== undefined) c[f] = String(b[f]).trim();
  }
  saveData(data, req.dataFile);
  res.json({ ok: true, customer: c });
});

app.use("/api", (req, res, next) => { req.dataFile = DATA_FILE; next(); }, api);

app.post("/demo/api/reset", requireAuth, (req, res) => {
  ensureDemoData(true);
  res.json({ ok: true });
});
app.use("/demo/api", requireAuth, (req, res, next) => {
  ensureDemoData(false);
  req.dataFile = DEMO_FILE;
  next();
}, api);

// ─── Errors ───────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`❌ Error en ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  if (req.path === "/webhook") {
    return twimlReply(res, "😔 Tuvimos un problema. Escribe *Hola* para empezar de nuevo.");
  }
  res.status(500).json({ error: "Error interno" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌻 Clara y Sol bot corriendo en puerto ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Webhook:   http://localhost:${PORT}/webhook`);
  console.log(`   Usuario:   ${DASHBOARD_USER}`);
  console.log(`   Datos en:  ${DATA_FILE}`);
  if (!process.env.DASHBOARD_PASS) {
    console.log("   ⚠️  Usando la contraseña por defecto. Define DASHBOARD_USER y DASHBOARD_PASS antes de publicar.");
  }
});
