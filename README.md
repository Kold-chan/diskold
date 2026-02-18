# 🧊 Diskold
**Chat y llamadas de voz en tiempo real — Creado por Kold**

> App open-source estilo Discord: chat instantáneo + llamadas de voz WebRTC.  
> Funciona en navegador web, Android (PWA) y PC (Electron .exe).

---

## 🚀 Correr localmente (VS Code)

### Requisitos
- [Node.js](https://nodejs.org) versión 16 o superior

### Pasos
```bash
# 1. Instala dependencias
npm install

# 2. Inicia el servidor
node server.js

# 3. Abre en el navegador
# http://localhost:3000
```

Para probar con varios usuarios, abre múltiples pestañas en `http://localhost:3000`.

---

## 📱 Instalar en Android (PWA)

No necesitas una app store. Diskold se instala como app nativa en Android:

### Opción A — Red local (sin internet)
1. Corre `node server.js` en tu PC
2. Encuentra la IP de tu PC:
   - Windows: abre CMD y escribe `ipconfig` → busca "IPv4 Address"
   - Ejemplo: `192.168.1.5`
3. En tu Android, abre Chrome y ve a `http://192.168.1.5:3000`
4. Toca el menú ⋮ → **"Añadir a pantalla de inicio"**
5. ¡Listo! Diskold aparece como app en tu Android

### Opción B — Con servidor en la nube (acceso desde cualquier lugar)
1. Sube el proyecto a [Railway](https://railway.app) o [Render](https://render.com) (gratis)
2. Usa la URL que te dan (ej: `https://diskold.railway.app`)
3. En Android Chrome → menú ⋮ → **"Añadir a pantalla de inicio"**

> ⚠️ Para las llamadas de voz, el servidor necesita HTTPS en producción.
> Railway y Render te dan HTTPS automáticamente.

---

## 🖥️ Crear el .exe para Windows (Electron)

```bash
# 1. Instala Electron y el empaquetador
npm install --save-dev electron electron-builder

# 2. Agrega esto a tu package.json (ya incluido abajo)
#    "main": "electron-main.js"
#    scripts → "build:exe": "electron-builder --win"

# 3. Construye el .exe
npm run build:exe
```

El archivo `.exe` aparecerá en la carpeta `dist/`.

### package.json completo para Electron:
```json
{
  "name": "diskold",
  "version": "1.0.0",
  "main": "electron-main.js",
  "scripts": {
    "start": "node server.js",
    "dev": "npx nodemon server.js",
    "electron": "electron .",
    "build:exe": "electron-builder --win"
  },
  "build": {
    "appId": "com.kold.diskold",
    "productName": "Diskold",
    "win": {
      "target": "nsis",
      "icon": "public/icon-512.png"
    }
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.6.1"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.0.0"
  },
  "author": "Kold",
  "license": "MIT"
}
```

---

## 📦 Subir a GitHub

```bash
# 1. Inicia el repositorio
git init
git add .
git commit -m "🧊 Diskold v1.0.0 — by Kold"

# 2. Crea un repo en github.com (botón "New repository")
#    Nombre sugerido: diskold
#    Visibilidad: Public

# 3. Conecta y sube
git remote add origin https://github.com/TU_USUARIO/diskold.git
git branch -M main
git push -u origin main
```

---

## 📁 Estructura del proyecto

```
diskold/
├── server.js           ← Backend (Node.js + Socket.io)
├── electron-main.js    ← Wrapper para .exe (Electron)
├── package.json        ← Config y dependencias
├── .gitignore          ← Archivos ignorados por Git
├── README.md           ← Este archivo
└── public/
    ├── index.html      ← Frontend completo
    ├── manifest.json   ← Config PWA (Android)
    ├── icon-192.png    ← Ícono app Android
    └── icon-512.png    ← Ícono app Android (grande)
```

---

## ✨ Funcionalidades

| Feature | Estado |
|---|---|
| Chat en tiempo real | ✅ |
| Llamadas de voz (WebRTC) | ✅ |
| Lista de usuarios en línea | ✅ |
| Ver quién está en llamada | ✅ |
| Silenciar micrófono | ✅ |
| Notificaciones entrada/salida | ✅ |
| Mobile-friendly (Android) | ✅ |
| Instalable como PWA | ✅ |
| Créditos (Kold) | ✅ |

---

## 🛠️ Tecnologías

- **Node.js + Express** — servidor web
- **Socket.io** — mensajes en tiempo real
- **WebRTC** — llamadas de voz P2P (sin pasar por el servidor)
- **Electron** — empaquetado desktop (.exe)
- **PWA** — instalable en Android

---

## 📄 Licencia

MIT — Creado por **Kold** 🧊
