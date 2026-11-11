#!/data/data/com.termux/files/usr/bin/bash
# setup-crm.sh — primera instalación de Autoimpulso CRM en Termux.
# Todo automático, sin preguntas: actualiza los paquetes del sistema,
# instala Node.js y git, instala las dependencias con npm y arranca el bot.
# Se ejecuta una sola vez, desde la carpeta del bot ($HOME/crm-bot):
#   bash setup-crm.sh
# El progreso se escribe en $HOME/.crm-setup.progress ("porcentaje|texto")
# para que la app lo muestre como barra de progreso.
set -e
cd "$(dirname "$0")"

PROGRESS_FILE="$HOME/.crm-setup.progress"

# Escribe el progreso para la app: "0-100|texto del paso".
progress() {
    echo "$1|$2" > "$PROGRESS_FILE"
}

progress 5 "Preparando la instalación..."

# Actualización del sistema sin preguntar nada: -y responde "sí" a todo y
# las opciones de dpkg evitan la pregunta de los archivos de configuración
# (la que pide Y/I/N/O/D/Z). Sin esto, pkg upgrade se queda esperando.
export DEBIAN_FRONTEND=noninteractive
progress 10 "Actualizando la lista de paquetes..."
pkg update
progress 15 "Actualizando paquetes del sistema..."
pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold

progress 35 "Instalando Node.js y Git..."
if ! command -v node >/dev/null 2>&1; then
    pkg install -y nodejs
fi
if ! command -v git >/dev/null 2>&1; then
    pkg install -y git
fi
node --version

progress 50 "Instalando dependencias del bot..."
npm install --allow-git=all --no-audit --no-fund

progress 75 "Creando configuración y carpetas..."
mkdir -p data public/uploads

if [ ! -f .env ]; then
    # El .env se genera aquí mismo (sin depender de .env.example, que
    # Android no empaqueta en el APK porque empieza con punto).
    TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    cat > .env <<EOF
PORT=3000
API_TOKEN=$TOKEN
ADMIN_TOKEN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=
EOF
    echo "Tu token del panel es: $TOKEN"
    echo "Escríbelo cuando el panel te lo pida (también está guardado en ~/crm-bot/.env)."
fi

progress 90 "Arrancando el bot..."
touch .installed
progress 100 "Listo"
echo "==> Instalación lista. Arrancando el bot..."
exec node app.js
