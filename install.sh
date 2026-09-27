#!/usr/bin/env bash
# Mediumistic installer — deps, icons, app-menu entry.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
command -v electron43 >/dev/null || { echo "electron43 not found (pacman -S electron43)"; exit 1; }
[ -d node_modules/@sakun/system.css ] || npm install --no-audit --no-fund
# Classic Mac bitmap fonts (Chicago / Geneva / Monaco) ship with system.css.
mkdir -p assets/fonts
cp node_modules/@sakun/system.css/dist/{ChiKareGo2,FindersKeepers,monaco}.woff2 assets/fonts/
for s in 16 32 48 64 128 256; do
  mkdir -p "$HOME/.local/share/icons/hicolor/${s}x${s}/apps"
  cp "assets/icon-$s.png" "$HOME/.local/share/icons/hicolor/${s}x${s}/apps/mediumistic.png"
done
mkdir -p "$HOME/.local/share/icons/hicolor/scalable/apps"
cp assets/icon.svg "$HOME/.local/share/icons/hicolor/scalable/apps/mediumistic.svg"
sed "s|/home/scorn/mediumistic|$DIR|" mediumistic.desktop > "$HOME/.local/share/applications/mediumistic.desktop"
desktop-file-validate "$HOME/.local/share/applications/mediumistic.desktop" || true
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
echo "Installed. Look for 'Mediumistic' in your app menu."
