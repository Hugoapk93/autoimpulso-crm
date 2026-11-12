#!/data/data/com.termux/files/usr/bin/bash
# start-crm.sh — arranca Autoimpulso CRM en Termux (tras la instalación).
# Se ejecuta en cada arranque del bot, así que antes de arrancar se
# repara solo si hace falta algo (sin preguntar nada): si Node está roto
# o falta, actualiza el sistema; si falta git o las dependencias, las
# instala; si falta el .env, lo crea con un token nuevo.
# Se ejecuta desde la carpeta del bot ($HOME/crm-bot):
#   bash start-crm.sh
set -e
cd "$(dirname "$0")"

PROGRESS_FILE="$HOME/.crm-setup.progress"
rm -f "$PROGRESS_FILE"

# Escribe el progreso para la app: "0-100|texto del paso".
progress() {
    echo "$1|$2" > "$PROGRESS_FILE"
}

# Node roto o ausente (p. ej. bootstrap viejo con libc++ desactualizada):
# actualizar el sistema lo repara, como pasó la primera vez.
if ! node --version >/dev/null 2>&1; then
    echo "==> Node.js roto o ausente. Actualizando el sistema..."
    progress 10 "Actualizando el sistema para reparar Node.js..."
    export DEBIAN_FRONTEND=noninteractive
    # Mirror oficial de Termux (el que pkg elige por latencia puede ser
    # lentísimo, ~10 kB/s en 3san.dev). Solo la línea del repo principal.
    PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
    SOURCES_LIST="$PREFIX_DIR/etc/apt/sources.list"
    if [ -f "$SOURCES_LIST" ]; then
        sed -i -E 's|^deb[[:space:]]+[^[:space:]]+[[:space:]]+stable[[:space:]]+main$|deb https://packages.termux.dev/apt/termux-main stable main|' "$SOURCES_LIST"
    fi
    pkg update
    pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
    if ! command -v node >/dev/null 2>&1; then
        pkg install -y nodejs
    fi
    node --version
fi

# git lo necesita npm para la dependencia libsignal de Baileys.
if ! command -v git >/dev/null 2>&1; then
    echo "==> Instalando git..."
    progress 30 "Instalando git..."
    pkg install -y git
fi

# Dependencias borradas o nunca instaladas.
if [ ! -d node_modules ]; then
    echo "==> Instalando dependencias (npm install)..."
    progress 50 "Instalando dependencias del bot..."
    npm install --allow-git=all --no-audit --no-fund
fi

# .env borrado: se crea uno nuevo con un token nuevo (el panel lo pedirá).
if [ ! -f .env ]; then
    echo "==> No existe .env: creando uno con un token nuevo..."
    progress 75 "Creando configuración..."
    TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    # Claves VAPID para el push (web-push ya instalado). Sin ellas
    # pushService avisa "Push desactivado".
    VAPID_KEYS=$(node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey);" 2>/dev/null)
    VAPID_PUBLIC_KEY=$(printf '%s' "$VAPID_KEYS" | sed -n '1p')
    VAPID_PRIVATE_KEY=$(printf '%s' "$VAPID_KEYS" | sed -n '2p')
    cat > .env <<EOF
PORT=3000
API_TOKEN=$TOKEN
ADMIN_TOKEN=
VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY
VAPID_EMAIL=correo@ejemplo.com
EOF
    echo "Tu token del panel es: $TOKEN"
fi

# .env viejo con las claves VAPID vacías (creado antes de que el setup las
# generara): rellenarlas sin tocar el token ni lo demás. Corre en cada
# arranque, así el .env queda completo aunque no se reinstale.
if [ -f .env ]; then
    if ! grep -q '^VAPID_PUBLIC_KEY=.\+' .env || ! grep -q '^VAPID_PRIVATE_KEY=.\+' .env; then
        VAPID_KEYS=$(node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey);" 2>/dev/null)
        VAPID_PUBLIC_KEY=$(printf '%s' "$VAPID_KEYS" | sed -n '1p')
        VAPID_PRIVATE_KEY=$(printf '%s' "$VAPID_KEYS" | sed -n '2p')
        if [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ]; then
            if grep -q '^VAPID_PUBLIC_KEY=' .env; then
                sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY|" .env
            else
                echo "VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY" >> .env
            fi
            if grep -q '^VAPID_PRIVATE_KEY=' .env; then
                sed -i "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY|" .env
            else
                echo "VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY" >> .env
            fi
            if ! grep -q '^VAPID_EMAIL=.\+' .env; then
                if grep -q '^VAPID_EMAIL=' .env; then
                    sed -i "s|^VAPID_EMAIL=.*|VAPID_EMAIL=correo@ejemplo.com|" .env
                else
                    echo "VAPID_EMAIL=correo@ejemplo.com" >> .env
                fi
            fi
            echo "==> Claves VAPID generadas y guardadas en .env (push activado)."
        fi
    fi
fi

rm -f "$PROGRESS_FILE"
echo "==> Arrancando Autoimpulso CRM..."
exec node app.js
