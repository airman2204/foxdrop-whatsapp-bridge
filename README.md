# FoxDrop WhatsApp Bridge 🦊

Microservicio ligero y autónomo para conectar WhatsApp con el panel de administración de FoxDrop sin pasar por Meta.

## Despliegue Gratis en Render.com (3 Pasos)

1. Sube esta carpeta `whatsapp-bridge` a tu GitHub (como un nuevo repositorio llamado `foxdrop-whatsapp-bridge` o dentro de tu repo).
2. Entra a [Render.com](https://render.com) y crea un **New Web Service**:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
3. Agrega las **Variables de Entorno** en Render:
   - `WEBHOOK_URL`: `https://tu-dominio-foxdrop.com/api/whatsapp/webhook`
   - `API_KEY`: `foxdrop_secret_2026`

## Vinculación del Celular
1. Abre la URL pública que te dio Render (ej. `https://foxdrop-bridge.onrender.com`).
2. Verás la pantalla verde de FoxDrop con el **Código QR**.
3. Abre WhatsApp en tu celular -> **Dispositivos vinculados** -> **Vincular dispositivo** -> Escanea la pantalla.
4. ¡Listo! Tu WhatsApp quedará vinculado 24/7 en la nube gratis.

## Conectar con tu Tienda
En el archivo `.env.local` de tu tienda FoxDrop agrega:
```env
WHATSAPP_BRIDGE_URL="https://foxdrop-bridge.onrender.com"
WHATSAPP_BRIDGE_API_KEY="foxdrop_secret_2026"
```
