"""The mark: a disc washed through the WUBRG spectrum.

Lifted out of the tray script so the same drawing serves three places -- the
tray icon, the executable, and the installer -- rather than the application
looking like one thing in the notification area and something else in Add/
Remove Programs. The tray's "running" state is the canonical form, because
that is the one people see while they are using it.

Drawn rather than shipped as a file so it stays sharp at every size Windows
asks for, from a 16px tray slot to a 256px shell tile, with no asset to keep
in step.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

#: Purple to teal to warm orange: the same sweep as the app's manaline, which
#: is the one place the interface lets Magic's five colors speak at once.
SPECTRUM = ((180, 160, 255), (110, 231, 214), (255, 178, 125))
GREY = ((90, 90, 100),)
AMBER = ((255, 207, 110),)
RED = ((255, 122, 133),)

#: Every size Windows may ask for. 16 and 32 are the tray and the title bar;
#: 256 is the shell's large-icon view and what the installer displays.
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def _lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def _sample(stops: tuple, t: float) -> tuple:
    """Color at position t across an arbitrary number of gradient stops."""
    if len(stops) == 1:
        return stops[0]
    span = 1 / (len(stops) - 1)
    index = min(int(t / span), len(stops) - 2)
    return _lerp(stops[index], stops[index + 1], (t - index * span) / span)


def make_icon(stops: tuple = SPECTRUM, hollow: bool = False, size: int = 64) -> Image.Image:
    """Draw a gradient disc. Supersampled 4x so the edge stays clean at 16px."""
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    gradient = Image.new("RGBA", (big, big))
    pixels = gradient.load()
    for x in range(big):
        color = _sample(stops, x / max(1, big - 1)) + (255,)
        for y in range(big):
            pixels[x, y] = color

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    pad = int(big * 0.06)
    draw.ellipse((pad, pad, big - pad, big - pad), fill=255)
    if hollow:
        # A ring reads as "off" at tray size better than a dimmed disc.
        inset = int(big * 0.22)
        draw.ellipse((pad + inset, pad + inset, big - pad - inset, big - pad - inset), fill=0)

    image.paste(gradient, (0, 0), mask)
    return image.resize((size, size), Image.LANCZOS)


def write_ico(dest: Path, stops: tuple = SPECTRUM) -> Path:
    """Write a multi-resolution .ico for the executable and the installer.

    Each size is drawn at its own resolution rather than downscaled from one
    large render: the disc is 88% of its box, and letting Windows shrink a
    256px version to 16px turns that edge to mush.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    largest = max(ICO_SIZES)
    frames = [make_icon(stops, size=size) for size in ICO_SIZES]
    base = next(frame for frame in frames if frame.width == largest)
    base.save(dest, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=frames)
    return dest


def write_icns(dest: Path, stops: tuple = SPECTRUM) -> Path:
    """Write the Mac application icon.

    One 1024px render: unlike .ico, Pillow builds the smaller ICNS members
    from it itself, and Finder draws an app icon large enough that the shrunk
    edge is never the one on show. The menu-bar icon is drawn separately by
    the tray at the size the status bar asks for.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    make_icon(stops, size=1024).save(dest, format="ICNS")
    return dest


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("insight-engine.ico")
    # The suffix picks the format, so the Windows and Mac builds share one
    # command line.
    writer = write_icns if target.suffix.lower() == ".icns" else write_ico
    print(f"wrote {writer(target)}")
