#!/usr/bin/env bash
# 安装 desktop-lrc 扩展到当前用户
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/desktop-lrc@kgpche"
DEST="$HOME/.local/share/gnome-shell/extensions/desktop-lrc@kgpche"

mkdir -p "$DEST/schemas"
cp "$SRC/extension.js" "$SRC/prefs.js" "$SRC/prefs-app.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"
cp "$SRC"/schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

if gnome-extensions info desktop-lrc@kgpche >/dev/null 2>&1; then
    gnome-extensions enable desktop-lrc@kgpche || true
    echo "已安装并启用。"
else
    echo "文件已就位，但当前会话尚未加载该扩展。"
    echo "注销并重新登录一次即可（若已在自启列表中会自动启用；否则运行 gnome-extensions enable desktop-lrc@kgpche）。"
fi
