const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ylflbastmupjknruqvpc.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsZmxiYXN0bXVwamtucnVxdnBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NTk3NzYsImV4cCI6MjEwNjEzNTc3Nn0.ep6kmm7Q_O1gzSbyPjhThegVKqaOkeYZF8e1oqv9yNw';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // URL de tu tienda: https://tudominio.com/api/whatsapp/webhook
const API_KEY = process.env.API_KEY || 'foxdrop_secret_2026';

let qrCodeData = null;
let connectionStatus = 'connecting'; // 'connecting', 'qr_ready', 'connected', 'disconnected'
let sock = null;

// Carpeta local donde Baileys lee y escribe los archivos de sesión
const authDir = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

// 1. Restaurar sesión desde Supabase hacia el disco local al arrancar el contenedor
async function restoreSessionFromCloud() {
  try {
    const { data, error } = await supabase
      .from('whatsapp_chats')
      .select('notes')
      .eq('phone', '_system_baileys_auth')
      .maybeSingle();

    if (!error && data && data.notes) {
      const files = JSON.parse(data.notes);
      let count = 0;
      for (const [filename, contentBase64] of Object.entries(files)) {
        const filePath = path.join(authDir, filename);
        fs.writeFileSync(filePath, Buffer.from(contentBase64, 'base64'));
        count++;
      }
      console.log(`📦 ¡Sesión de WhatsApp restaurada desde Supabase con éxito (${count} llaves)!`);
    } else {
      console.log('ℹ️ No hay sesión previa guardada en Supabase o es la primera vinculación.');
    }
  } catch (err) {
    console.warn('Advertencia restaurando sesión desde Supabase:', err.message);
  }
}

// 2. Guardar sesión desde el disco local hacia Supabase para sobrevivir reinicios de Render
let syncTimeout = null;
function scheduleCloudBackup() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(authDir)) return;
      const fileNames = fs.readdirSync(authDir);
      if (fileNames.length === 0) return;

      const filesObj = {};
      for (const f of fileNames) {
        const fullPath = path.join(authDir, f);
        if (fs.statSync(fullPath).isFile()) {
          filesObj[f] = fs.readFileSync(fullPath).toString('base64');
        }
      }

      await supabase
        .from('whatsapp_chats')
        .upsert({
          phone: '_system_baileys_auth',
          client_name: 'WhatsApp Session Backup',
          notes: JSON.stringify(filesObj),
          status: 'archived',
          updated_at: new Date().toISOString(),
        });
      console.log(`☁️ Respaldo de sesión de WhatsApp guardado en Supabase (${fileNames.length} archivos).`);
    } catch (err) {
      console.warn('Error respaldando sesión en Supabase:', err.message);
    }
  }, 2000);
}

async function startWhatsApp() {
  // Primero restaurar sesión guardada si el disco de Render está recién formateado
  await restoreSessionFromCloud();

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }), // Silenciar logs excesivos
    browser: ['FoxDrop CRM', 'Chrome', '1.0.0'],
    keepAliveIntervalMs: 25000, // Enviar keep-alive a WhatsApp cada 25s
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    syncFullHistory: false, // No sobrecargar memoria de Render con chats antiguos
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleCloudBackup();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'qr_ready';
      qrCodeData = await QRCode.toDataURL(qr);
      console.log('⚡ Nuevo código QR generado. Escanéalo desde la interfaz web.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexión cerrada (status: ${statusCode}). ¿Reconectar?: ${shouldReconnect}`);
      connectionStatus = 'disconnected';
      qrCodeData = null;

      // Si el código es 401 (Unauthorized / Logged out), 403 o error terminal, purgar llaves dañadas para emitir nuevo QR
      const isTerminalAuthError = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403 || statusCode === 500;
      
      if (isTerminalAuthError) {
        console.log(`🚪 Sesión inválida o cerrada (status: ${statusCode}). Purgando llaves y forzando nuevo QR...`);
        try {
          await supabase.from('whatsapp_chats').delete().eq('phone', '_system_baileys_auth');
          if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        } catch (e) {
          console.warn('Error purgando authDir:', e.message);
        }
        setTimeout(startWhatsApp, 2000);
      } else if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ ¡WhatsApp Conectado exitosamente con FoxDrop!');
      connectionStatus = 'connected';
      qrCodeData = null;
      scheduleCloudBackup();
    }
  });

  // Escuchar mensajes entrantes y reenviarlos al webhook de FoxDrop / Supabase
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      // Extraer JID real: si remoteJid es un @lid, buscar el JID real en participant o remoteJidAlt
      let senderJid = msg.key.remoteJid || '';
      // Filtrar mensajes de grupos
      if (senderJid.includes('@g.us')) continue;

      let rawLid = '';
      if (senderJid.endsWith('@lid')) {
        rawLid = senderJid.replace(/@.+/, '');
        // Baileys expone a veces el JID alternativo en remoteJidAlt o participant
        if (msg.key.remoteJidAlt && !msg.key.remoteJidAlt.endsWith('@lid')) {
          senderJid = msg.key.remoteJidAlt;
        } else if (msg.key.participant && !msg.key.participant.endsWith('@lid')) {
          senderJid = msg.key.participant;
        }
      }

      const cleanPhone = senderJid.replace(/@.+/, '');
      const text = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        msg.message.imageMessage?.caption || 
        '';

      const pushName = msg.pushName || 'Cliente WhatsApp';

      // Consultar foto de perfil real del contacto en WhatsApp
      let avatarUrl = '';
      try {
        const jidToFetch = rawLid ? `${rawLid}@lid` : `${cleanPhone}@s.whatsapp.net`;
        avatarUrl = await sock.profilePictureUrl(jidToFetch, 'image').catch(() => '');
      } catch {}

      console.log(`📩 Mensaje recibido de ${cleanPhone} (LID: ${rawLid}) (${pushName}): ${text}`);

      if (WEBHOOK_URL && text) {
        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone: cleanPhone,
              lid: rawLid || undefined,
              text: text,
              clientName: pushName,
              avatarUrl: avatarUrl || undefined,
            }),
          });
        } catch (err) {
          console.error('Error enviando mensaje al webhook de FoxDrop:', err.message);
        }
      }
    }
  });
}

// Iniciar sesión
startWhatsApp();

// ==========================================
// RUTAS Y PANTALLA VISUAL
// ==========================================

// Página principal: Muestra el QR o el estado de conexión
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>FoxDrop WhatsApp Bridge</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F3E36; color: #FAF6F0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: white; color: #222E3C; padding: 32px; border-radius: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); text-align: center; max-width: 420px; width: 100%; }
        h1 { margin: 0 0 8px; color: #0F3E36; font-size: 24px; font-weight: 900; }
        p { color: #64748B; font-size: 13px; line-height: 1.5; margin: 0 0 20px; }
        .qr-box { background: #F8FAFC; border: 2px dashed #CBD5E1; border-radius: 16px; padding: 16px; display: inline-block; margin-bottom: 20px; min-width: 250px; min-height: 250px; display: flex; align-items: center; justify-content: center; }
        .qr-box img { width: 240px; height: 240px; display: block; border-radius: 8px; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 800; text-transform: uppercase; margin-bottom: 16px; }
        .badge.connected { background: #DCFCE7; color: #166534; }
        .badge.waiting { background: #FEF3C7; color: #92400E; }
        .badge.disconnected { background: #FEE2E2; color: #991B1B; }
        .instructions { text-align: left; background: #F1F5F9; border-radius: 12px; padding: 14px; font-size: 12px; color: #334155; }
        .instructions ol { margin: 8px 0 0; padding-left: 18px; }
        .instructions li { margin-bottom: 4px; }
      </style>
      <script>
        // Auto-refresco si está esperando QR o reconectando
        setTimeout(() => {
          if (!document.querySelector('.badge.connected')) {
            window.location.reload();
          }
        }, 8000);
      </script>
    </head>
    <body>
      <div class="card">
        <span class="badge ${connectionStatus === 'connected' ? 'connected' : connectionStatus === 'qr_ready' ? 'waiting' : 'disconnected'}">
          ${connectionStatus === 'connected' ? '🟢 Conectado a WhatsApp' : connectionStatus === 'qr_ready' ? '🟡 Esperando Escaneo de QR' : '⚪ Conectando...'}
        </span>
        
        <h1>WhatsApp FoxDrop</h1>
        <p>Micro-conector Multi-Socio para tu tienda en línea</p>

        <div class="qr-box">
          ${connectionStatus === 'connected' 
            ? '<div style="color: #166534; font-weight: bold;">🎉 ¡Tu celular ya está vinculado!<br><span style="font-size: 12px; color: #64748B;">Puedes cerrar esta pestaña o dejarla activa.</span></div>'
            : qrCodeData 
            ? '<img src="' + qrCodeData + '" alt="Código QR WhatsApp" />'
            : '<div>Generando código QR...<br><span style="font-size: 11px; color: #94A3B8;">Espera unos segundos</span></div>'
          }
        </div>

        ${connectionStatus !== 'connected' ? `
          <div class="instructions">
            <strong>Cómo vincular tu celular:</strong>
            <ol>
              <li>Abre WhatsApp en tu teléfono.</li>
              <li>Toca <strong>Menú (3 puntos)</strong> o <strong>Configuración</strong>.</li>
              <li>Selecciona <strong>Dispositivos vinculados</strong>.</li>
              <li>Toca <strong>Vincular un dispositivo</strong> y apunta al código QR.</li>
            </ol>
          </div>
        ` : ''}
      </div>
    </body>
    </html>
  `);
});

// Endpoint GET o POST para forzar reseteo de sesión y generar QR nuevo
app.all('/reset', async (req, res) => {
  try {
    console.log('🔄 Solicitud de reset de sesión recibida. Purgando credenciales...');
    if (sock) {
      try { sock.end(new Error('Reset solicitado')); } catch {}
    }
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    await supabase.from('whatsapp_chats').delete().eq('phone', '_system_baileys_auth').catch(() => {});
    qrCodeData = null;
    connectionStatus = 'connecting';
    setTimeout(startWhatsApp, 1500);
    res.json({ success: true, message: 'Sesión purgada exitosamente. Nuevo QR en camino...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de salud
app.get('/status', (req, res) => {
  res.json({ status: connectionStatus });
});

// Endpoint POST para enviar mensajes desde el panel Admin
app.post('/message/sendText', async (req, res) => {
  const { number, text } = req.body;

  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no está conectado todavía' });
  }

  if (!number || !text) {
    return res.status(400).json({ error: 'Número y texto requeridos' });
  }

  try {
    let targetJid = '';
    
    if (number.includes('@lid')) {
      targetJid = number;
    } else if (number.includes('@s.whatsapp.net')) {
      targetJid = number;
    } else {
      let digits = number.replace(/\D/g, '');
      
      // Si parece ser un LID (14+ dígitos y comienza con 64 u similar)
      if (digits.length >= 14 && digits.startsWith('64')) {
        targetJid = `${digits}@lid`;
      } else {
        // Formato número de teléfono estándar
        if (digits.length === 10) {
          digits = `52${digits}`;
        }
        if (digits.startsWith('521') && digits.length === 13) {
          digits = `52${digits.slice(3)}`;
        }
        targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    const sent = await sock.sendMessage(targetJid, { text });
    console.log(`📤 Mensaje enviado con éxito a ${targetJid}: ${text}`);
    res.json({ success: true, messageId: sent.key.id, jid: targetJid });
  } catch (err) {
    console.error('Error enviando mensaje por WhatsApp:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint GET para obtener la información de perfil propia de la cuenta de FoxDrop
app.get('/profile/myInfo', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no está conectado' });
  }

  try {
    const myJid = sock.user?.id || '';
    let avatarUrl = '';
    try {
      avatarUrl = await sock.profilePictureUrl(myJid, 'image').catch(() => '');
    } catch {}

    let statusText = '';
    try {
      const statusRes = await sock.fetchStatus(myJid).catch(() => null);
      statusText = statusRes?.status || '';
    } catch {}

    res.json({
      success: true,
      id: myJid,
      name: sock.user?.name || 'FoxDrop',
      phone: myJid.replace(/@.+/, '').replace(/:.+/, ''),
      avatarUrl,
      status: statusText,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint POST para actualizar la foto de perfil de la cuenta de FoxDrop
app.post('/profile/updatePicture', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no está conectado' });
  }

  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 requerida' });
  }

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const myJid = sock.user?.id;

    await sock.updateProfilePicture(myJid, buffer);
    console.log('✅ Foto de perfil de WhatsApp FoxDrop actualizada con éxito.');

    let newAvatarUrl = '';
    try {
      newAvatarUrl = await sock.profilePictureUrl(myJid, 'image').catch(() => '');
    } catch {}

    res.json({ success: true, avatarUrl: newAvatarUrl });
  } catch (err) {
    console.error('Error actualizando foto de perfil en WhatsApp:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint POST para actualizar el estado/info de la cuenta de FoxDrop
app.post('/profile/updateStatus', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no está conectado' });
  }

  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'Texto de estado requerido' });
  }

  try {
    await sock.updateProfileStatus(status);
    console.log(`✅ Estado de WhatsApp FoxDrop actualizado: "${status}"`);
    res.json({ success: true, status });
  } catch (err) {
    console.error('Error actualizando estado en WhatsApp:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint GET para consultar bajo demanda el avatar de un contacto específico
app.get('/contact/avatar', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no está conectado' });
  }

  const { phone, lid } = req.query;
  if (!phone && !lid) {
    return res.status(400).json({ error: 'phone o lid requerido' });
  }

  try {
    const targetJid = lid ? `${lid}@lid` : `${phone}@s.whatsapp.net`;
    const avatarUrl = await sock.profilePictureUrl(targetJid, 'image').catch(() => '');
    res.json({ success: true, avatarUrl });
  } catch (err) {
    res.json({ success: false, avatarUrl: '' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FoxDrop WhatsApp Bridge activo en el puerto ${PORT}`);

  // Mantener vivo el servicio en Render Free (auto-ping cada 5 minutos)
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://foxdrop-whatsapp-bridge.onrender.com';
  setInterval(() => {
    fetch(`${SELF_URL}/status`)
      .then(r => r.json())
      .then(d => console.log(`💓 Auto-KeepAlive Bridge: ${d.status}`))
      .catch(() => {});
  }, 1000 * 60 * 5);
});
