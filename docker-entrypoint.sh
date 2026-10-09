#!/bin/sh
set -e

echo "Application des migrations de base de données..."
node node_modules/prisma/build/index.js migrate deploy

echo "Démarrage de deploy-agent..."
exec "$@"
