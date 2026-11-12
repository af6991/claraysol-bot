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

**📦 Pedidos**
- Pedidos de WhatsApp y pedidos manuales (por teléfono, mayoreo, rejas, huevo suelto)
- Cliente (toca para abrir WhatsApp), ubicación (toca para abrir el mapa) y estado de pago
- Cambia el estado: Aceptado → En camino → Entregado / Cancelado.
  Al **cancelar**, los cartones regresan solos al inventario.
- Botón **Cobrar** para registrar un pago (efectivo, transferencia, tarjeta, otro)

**🥚 Inventario**
- "Llegaron cartones" suma stock; "Conteo real" ajusta al número exacto; precio por cartón
- Historial de movimientos: entradas, pedidos, cancelaciones y ajustes

**📊 Reportes** (hoy, semana, mes, año o fechas a elegir)
- Pedidos, huevos vendidos, total vendido, cobrado, pendiente de cobro, ticket promedio
- Por producto, por día, por cliente y cobros por método de pago
- Cuentas por cobrar: quién debe y cuánto (los pagos generales se aplican a los pedidos más antiguos)
- Descarga a CSV (abre en Excel o Google Sheets)

**👥 Clientes**
- Se crean solos con cada pedido de WhatsApp (con el nombre de su perfil)
- Edita nombre, zona, dirección, liga de mapa y notas; ve su historial y saldo

Se actualiza solo cada 15 segundos.

**🧪 Demo** — `https://TU-URL.up.railway.app/demo` (mismo usuario y contraseña)
- El mismo dashboard con ~3 meses de pedidos, clientes y pagos inventados, para practicar y ver los reportes.
- Se guarda aparte (`demo-data.json`): nunca toca tus pedidos, inventario ni el bot.
- Botón "Reiniciar datos demo" para empezar de nuevo.

## Revisar que el bot está vivo

- Abre `https://TU-URL.up.railway.app/webhook` en el navegador: debe decir "el webhook está activo".
- En los logs de Railway cada mensaje aparece como `📩 … | texto: "…"` seguido de `↳ respuesta: …`.
