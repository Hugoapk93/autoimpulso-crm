#!/data/data/com.termux/files/usr/bin/bash
# start-crm.sh — arranca Autoimpulso CRM en Termux (tras la instalación).
# Se ejecuta desde la carpeta del bot ($HOME/crm-bot):
#   bash start-crm.sh
set -e
cd "$(dirname "$0")"

echo "==> Arrancando Autoimpulso CRM..."
exec node app.js
