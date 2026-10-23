#!/usr/bin/env bash
# Reaplica la marca Creativo Melborp sobre Node Banana. Correr desde la raíz del fork después de cada merge.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v rsvg-convert >/dev/null || { echo "Falta rsvg-convert (brew install librsvg)"; exit 1; }

rsvg-convert -w 512 -h 512 branding/creativo-melborp-icon.svg -o public/banana_icon.png
cp public/banana_icon.png src/app/icon.png

perl -0pi -e 's/(\n\s*)Node(\s*<br \/>\s*)Banana(\s*\n)/$1Creativo$2Melborp$3/' src/components/ui/Dialog.tsx
perl -pi -e 's/title: "Node Banana[^"]*"/title: "Creativo Melborp"/; s/description: "Node-based image annotation[^"]*"/description: "Flujos de generación creativa de Melborp"/' src/app/layout.tsx

# Solo la interfaz: src/lib y src/app/api hablan con el agente y con el disco, y los tests fijan los textos originales.
{ rg -l "Node Banana" src/components src/app \
  --glob '!src/app/api/**' --glob '!**/__tests__/**' --glob '!**/*.test.*' || true; } \
  | xargs -r perl -pi -e 's/Node Banana/Creativo Melborp/g'

echo "Marca aplicada. Textos de interfaz que aún dicen «Node Banana»:"
rg -n "Node Banana" src/components src/app \
  --glob '!src/app/api/**' --glob '!**/__tests__/**' --glob '!**/*.test.*' || echo "(ninguno)"
