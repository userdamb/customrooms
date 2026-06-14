#!/usr/bin/env bash
# Обновление бота на сервере: подтянуть код из git, поставить зависимости,
# перерегистрировать слэш-команды и перезапустить под pm2.
# БД (DB_PATH вне папки с кодом) при этом НЕ затрагивается.
set -e
cd "$(dirname "$0")"
echo "=== git pull ==="
git pull --ff-only
echo "=== npm install ==="
npm install --omit=dev
echo "=== deploy slash-commands ==="
node deploy-commands.js || true
echo "=== pm2 restart ==="
pm2 restart customrooms
sleep 4
pm2 logs customrooms --lines 12 --nostream
echo "=== DONE ==="
