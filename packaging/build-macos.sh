#!/usr/bin/env bash
# Build the distributable disk image for the Mac.
#
# The same three stages as build-release.ps1, in the same order and for the
# same reason -- interface, then the frozen server around it, then the thing a
# person downloads -- with a .dmg holding "Insight Engine.app" and a shortcut
# to Applications where Windows has Setup.exe. Each stage fails loudly rather
# than letting the next one package something stale.
#
# Runs on a Mac, with Python 3.11+ and Node on the PATH. The release workflow
# (.github/workflows/release-macos.yml) runs it once on Apple silicon and once
# on Intel; it works the same by hand:
#
#     packaging/build-macos.sh 2.14.2
#
# The card mirror is not included, for the reasons build-release.ps1 gives.

set -euo pipefail

VERSION="${1:-1.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/server/.venv"
PYTHON="$VENV/bin/python"

say()  { printf '\n  %s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
die()  { printf '  [fail] %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This builds the Mac app and has to run on a Mac."

case "$(uname -m)" in
    arm64)  ARCH_LABEL="AppleSilicon" ;;
    x86_64) ARCH_LABEL="Intel" ;;
    *)      die "Unrecognised architecture $(uname -m)." ;;
esac

printf '\n  INSIGHT ENGINE - Mac build %s (%s)\n' "$VERSION" "$ARCH_LABEL"

# --- 0. python environment -------------------------------------------------

if [ ! -x "$PYTHON" ]; then
    say "Creating the virtualenv"
    python3 -m venv "$VENV"
fi
"$PYTHON" -m pip install --quiet --upgrade pip
"$PYTHON" -m pip install --quiet -r "$ROOT/server/requirements.txt" pyinstaller
ok "Python dependencies"

# --- 1. interface ----------------------------------------------------------

say "Building the interface"
if [ ! -d "$ROOT/web/node_modules" ]; then
    npm --prefix "$ROOT/web" ci
fi
npm --prefix "$ROOT/web" run build
[ -f "$ROOT/web/dist/index.html" ] || die "Web build produced no dist/index.html."
ok "web/dist"

# --- 2. freeze -------------------------------------------------------------

say "Drawing the icon"
ICNS="$ROOT/packaging/insight-engine.icns"
(cd "$ROOT/server" && "$PYTHON" -m app.icon "$ICNS")
[ -f "$ICNS" ] || die "Icon generation produced no .icns."
ok "packaging/insight-engine.icns"

say "Freezing the server"
# Cleared rather than reused: PyInstaller leaves stale data files in place,
# which is how an old interface ends up inside a new build.
rm -rf "$ROOT/build" "$ROOT/dist"
(cd "$ROOT" && INSIGHT_VERSION="$VERSION" "$VENV/bin/pyinstaller" \
    packaging/insight-engine-macos.spec --noconfirm --clean)

APP="$ROOT/dist/Insight Engine.app"
[ -x "$APP/Contents/MacOS/InsightEngine" ] || die "PyInstaller produced no app bundle."

# Ad-hoc signed as a whole. Apple silicon refuses to run unsigned code at all,
# and a bundle whose parts are signed but whose seal is not reads as damaged
# once it has been downloaded. This is not a Developer ID signature, so
# Gatekeeper still asks on first open -- the README says how to get past it.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" || die "The app bundle's signature does not verify."
ok "dist/Insight Engine.app ($(du -sh "$APP" | cut -f1))"

# --- 3. disk image ---------------------------------------------------------

say "Building the disk image"
mkdir -p "$ROOT/release"
DMG="$ROOT/release/InsightEngine-$VERSION-macOS-$ARCH_LABEL.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# The familiar layout: the app and a shortcut to Applications side by side, so
# installing is a drag from one to the other.
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create -volname "Insight Engine" -srcfolder "$STAGE" \
    -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG" >/dev/null
[ -f "$DMG" ] || die "hdiutil produced no disk image."

printf '\n  Done.\n  %s (%s)\n\n' "$DMG" "$(du -h "$DMG" | cut -f1)"
