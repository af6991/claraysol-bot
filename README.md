# 🌻 Clara y Sol — WhatsApp Bot

Flujo: **"Hola" → tamaño → cantidad → ubicación → confirmación → ✅ pedido aceptado**
(o aviso amable si el inventario se acabó mientras ordenaban).

---

## Correr en tu computadora

```bash
npm install
node server.js
```

Dashboard: http://localhost:3000
Webhook:   http://localhost:3000/webhook

---

## Publicar en Railway

1. Sube esta carpeta a un repositorio **privado** de GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. En **Variables** agrega:
   - `DASHBOARD_USER` = el usuario que quieras
   - `DASHBOARD_PASS` = una contraseña segura
4. Agrega un **Volume** al servicio con mount path `/data`.
   Ahí se guardan pedidos e inventario. **Sin volumen, Railway los borra en cada deploy.**
5. Settings → Networking → **Generate Domain**.
6. En Twilio: Messaging → Senders → WhatsApp Senders → tu número →
   webhook de mensajes entrantes: `https://TU-URL.up.railway.app/webhook` (método POST).

---

## Precios e inventario

Se cambian desde el **dashboard** (campos Stock y Precio → Guardar).
`data.json` solo define los valores iniciales la primera vez que arranca con un volumen vacío.

---

## Dashboard

- Pedidos con teléfono del cliente (toca para abrir WhatsApp) y ubicación (toca para abrir el mapa)
- Cambia el estado: Aceptado → En camino → Entregado / Cancelado
- Se actualiza solo cada 15 segundos
