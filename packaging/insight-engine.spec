# PyInstaller spec for the distributable build.
#
# onedir, not onefile. A onefile build unpacks ~60MB to a temp directory on
# every launch, which is slow and confuses antivirus; a folder is also what
# Inno Setup wants to lay down. The cost is that the payload is visible beside
# the executable, which for a free tool is not a cost.
#
# Build from the repo root:
#     server\.venv\Scripts\pyinstaller packaging\insight-engine.spec --noconfirm

from pathlib import Path

# SPECPATH is the directory holding this file; the repo root is its parent.
ROOT = Path(SPECPATH).parent          # noqa: F821 - injected by PyInstaller
SERVER = ROOT / "server"

datas = [
    # The built interface. Without this the server has nothing to serve, so a
    # missing `web/dist` should fail the build rather than ship a blank app.
    (str(ROOT / "web" / "dist"), "web/dist"),
    # The sample deck a fresh install is seeded with.
    (str(SERVER / "app" / "seed"), "app/seed"),
]

if not (ROOT / "web" / "dist" / "index.html").exists():
    raise SystemExit(
        "web/dist is missing. Run `npm --prefix web run build` before packaging."
    )

hiddenimports = [
    # uvicorn resolves these by name at runtime, so static analysis misses them.
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # Pulled in through pydantic-settings' dotenv support.
    "dotenv",
]

a = Analysis(                          # noqa: F821
    [str(ROOT / "packaging" / "entry.py")],
    # So `import app.…` resolves the same way it does from a source checkout.
    pathex=[str(SERVER)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Test-only, and pulling them in adds weight for nothing.
    excludes=["pytest", "pytest_asyncio", "_pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)                      # noqa: F821

exe = EXE(                             # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="InsightEngine",
    debug=False,
    strip=False,
    upx=False,
    # A console: the first run prints download progress, and silence for four
    # minutes reads as a hang.
    console=True,
    icon=None,
)

coll = COLLECT(                        # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="InsightEngine",
)
