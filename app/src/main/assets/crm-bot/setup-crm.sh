#!/data/data/com.termux/files/usr/bin/bash
# setup-crm.sh — primera instalación de Autoimpulso CRM en Termux.
# Se ejecuta una sola vez, desde la carpeta del bot ($HOME/crm-bot):
#   bash setup-crm.sh
# Instala Node.js si falta, instala las dependencias con npm y arranca el bot.
set -e
cd "$(dirname "$0")"

echo "==> Autoimpulso CRM: comprobando Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js no encontrado. Instalando con pkg (necesita internet)..."
    pkg install -y nodejs
fi
node --version

echo "==> Instalando dependencias (npm install)..."
npm install --no-audit --no-fund

echo "==> Creando carpetas de datos..."
mkdir -p data public/uploads

if [ ! -f .env ]; then
    echo "==> No existe .env: creando uno con un token nuevo..."
    cp .env.example .env
    TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    sed -i "s/^API_TOKEN=.*/API_TOKEN=$TOKEN/" .env
    echo "Tu token del panel es: $TOKEN"
    echo "Escríbelo cuando el panel te lo pida (también está guardado en ~/crm-bot/.env)."
fi

touch .installed
echo "==> Instalación lista. Arrancando el bot..."
exec node app.js
