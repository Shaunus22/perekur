#!/bin/bash
# Конвертирует большие GIF (>1MB) в анимированный WebP в папке prikol-webp
SRC=/opt/perekur/prikol
DST=/opt/perekur/prikol-webp
mkdir -p "$DST"
for f in "$SRC"/*.gif; do
  [ -e "$f" ] || continue
  size=$(stat -c%s "$f")
  [ "$size" -gt 1000000 ] || continue
  name=$(basename "$f" .gif)
  out="$DST/$name.webp"
  if [ ! -f "$out" ] || [ "$f" -nt "$out" ]; then
    ffmpeg -y -hide_banner -loglevel error -i "$f" -loop 0 -quality 65 -vf "scale=480:-1:flags=lanczos" -an "$out" && echo "OK: $name.webp" || echo "FAIL: $name"
  fi
done
echo '--- sizes ---'
for w in "$DST"/*.webp; do
  [ -e "$w" ] && printf '%s %s\n' "$(stat -c%s "$w")" "$(basename "$w")"
done
