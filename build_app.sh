#!/bin/zsh
# Crea "X5 Regia.app": icona nel Dock, finestra nativa, si avvia con un doppio clic.
# L'app usa questa cartella (codice e ambiente Python): non spostare la cartella dopo averla creata.
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
command -v ffmpeg >/dev/null || { echo "Serve ffmpeg: brew install ffmpeg"; exit 1; }
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip -q install -r requirements.txt

APP="$ROOT/X5 Regia.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# icona
.venv/bin/python - <<'EOF'
import numpy as np, cv2, os, subprocess
S = 1024
img = np.zeros((S, S, 4), np.uint8)
mask = np.zeros((S, S), np.uint8)
cv2.rectangle(mask, (100, 100), (S - 100, S - 100), 255, -1)
mask = cv2.GaussianBlur(cv2.dilate(mask, None), (0, 0), 1)
r = 180  # angoli arrotondati
corner = np.zeros((S, S), np.uint8)
cv2.rectangle(corner, (100 + r, 100), (S - 100 - r, S - 100), 255, -1)
cv2.rectangle(corner, (100, 100 + r), (S - 100, S - 100 - r), 255, -1)
for cx, cy in [(100 + r, 100 + r), (S - 100 - r, 100 + r), (100 + r, S - 100 - r), (S - 100 - r, S - 100 - r)]:
    cv2.circle(corner, (cx, cy), r, 255, -1, cv2.LINE_AA)
img[..., :3] = (20, 18, 17); img[..., 3] = corner
cv2.circle(img, (S // 2, S // 2), 270, (61, 122, 255, 255), 46, cv2.LINE_AA)        # sfera
cv2.ellipse(img, (S // 2, S // 2), (270, 95), 0, 0, 360, (61, 122, 255, 255), 30, cv2.LINE_AA)
pts = np.array([[S // 2 - 120, S // 2 - 150], [S // 2 + 120, S // 2 - 150], [S // 2 + 120, S // 2 + 150], [S // 2 - 120, S // 2 + 150]])
cv2.polylines(img, [pts], True, (240, 240, 240, 255), 22, cv2.LINE_AA)            # inquadratura
d = "icon.iconset"; os.makedirs(d, exist_ok=True)
for s in (16, 32, 64, 128, 256, 512):
    cv2.imwrite(f"{d}/icon_{s}x{s}.png", cv2.resize(img, (s, s), interpolation=cv2.INTER_AREA))
    cv2.imwrite(f"{d}/icon_{s}x{s}@2x.png", cv2.resize(img, (s * 2, s * 2), interpolation=cv2.INTER_AREA))
subprocess.run(["iconutil", "-c", "icns", d, "-o", "icon.icns"], check=True)
EOF
mv icon.icns "$APP/Contents/Resources/X5Regia.icns"; rm -rf icon.iconset

cat > "$APP/Contents/MacOS/X5 Regia" <<EOF
#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd "$ROOT"
exec "$ROOT/.venv/bin/python" "$ROOT/app.py"
EOF
chmod +x "$APP/Contents/MacOS/X5 Regia"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>X5 Regia</string>
  <key>CFBundleDisplayName</key><string>X5 Regia</string>
  <key>CFBundleIdentifier</key><string>io.github.abiagiodev.x5regia</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>X5 Regia</string>
  <key>CFBundleIconFile</key><string>X5Regia</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
echo "Creata: $APP  (trascinala nel Dock o in Applicazioni come alias)"
