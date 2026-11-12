const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");

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
  const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Clara y Sol Dashboard"');
  return res.status(401).send("Usuario o contraseña incorrectos");
}

// Protect dashboard and API routes
app.use("/api", requireAuth);
app.use("/dashboard", requireAuth);

// Serve login-protected dashboard
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

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

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
  return {
    inventory: {
      grande: { label: "Grande (18 huevos)", price: 100, stock: 50 },
      extra:  { label: "Extra (30 huevos)",  price: 165, stock: 30 },
    },
    orders: [],
    nextOrderId: 1,
  };
}

function saveData(data) {
  // Write to a temp file first, then swap it in, so a crash mid-save can't corrupt orders/stock
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type("text/xml").send(twiml.toString());
}

// ─── Webhook (no auth — Twilio must reach this freely) ───────────────────────
app.post("/webhook", (req, res) => {
  const from       = req.body.From;
  const body       = (req.body.Body || "").trim().toLowerCase();
  const rawBody    = (req.body.Body || "").trim();
  const hasLocation = req.body.Latitude && req.body.Longitude;
  const latitude   = req.body.Latitude;
  const longitude  = req.body.Longitude;

  const data = loadData();

  // Allow restart at any time ("Hola", "hola!", "Menú"...). Ignore punctuation/accents-free matching.
  const greeting = body.replace(/[^\p{L}\s]/gu, "").trim();
  if (["hola", "inicio", "hi", "menu", "menú", "hello", "buenas"].includes(greeting)) {
    clearSession(from);
  }
  // Fetch the session AFTER any reset so we always work with the fresh one
  const session = getSession(from);

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
    if (body === "1" && inv.grande.stock > 0) chosen = "grande";
    if (body === "2" && inv.extra.stock > 0)  chosen = "extra";

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

    inv[product].stock -= qty;
    const orderId = data.nextOrderId++;
    const order = {
      id:           orderId,
      phone:        from,
      product,
      productLabel: inv[product].label,
      quantity:     qty,
      total:        qty * inv[product].price,
      location:     session.location,
      status:       "accepted",
      createdAt:    new Date().toISOString(),
    };
    data.orders.push(order);
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
app.get("/api/data", (req, res) => res.json(loadData()));

app.post("/api/inventory", (req, res) => {
  const { product, stock, price } = req.body;
  const data = loadData();
  if (!data.inventory[product]) return res.status(400).json({ error: "Producto no encontrado" });
  if (stock !== undefined) {
    data.inventory[product].stock = Math.max(0, parseInt(stock, 10) || 0);
  }
  if (price !== undefined) {
    const p = parseFloat(price);
    if (!isNaN(p) && p > 0) data.inventory[product].price = p;
  }
  saveData(data);
  res.json({ ok: true, inventory: data.inventory });
});

app.post("/api/orders/:id/status", (req, res) => {
  const data  = loadData();
  const order = data.orders.find(o => o.id === parseInt(req.params.id, 10));
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
  order.status = req.body.status;
  saveData(data);
  res.json({ ok: true, order });
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
