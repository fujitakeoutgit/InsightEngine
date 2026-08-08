"""Frozen entry point.

A thin wrapper rather than pointing PyInstaller straight at
`server/app/launcher.py`: analysed as a loose script, that file is not part of
the `app` package and every `from .config import ...` in the server fails at
import. Going through a real package import keeps the whole server importing
exactly as it does from source.
"""

import sys

from app.launcher import main

if __name__ == "__main__":
    sys.exit(main())
