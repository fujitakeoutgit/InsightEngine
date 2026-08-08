"""Which local model the semantic engine runs.

Kept out of `config.py` because it is not configuration: it is a choice made
in the interface that has to outlive the process that received it. Kept out of
the router because `llm/ollama.py` needs it too, and a transport layer
importing from an HTTP layer is backwards.

Stored in `meta`, which is absent from DERIVED_TABLES and so survives a schema
rebuild. Nothing is written until the user picks something, so a fresh install
runs exactly what `config.py` says.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import settings
from .db import get_meta, set_meta
from .state import state

MODEL_KEY = "setting:ollama_model"


@dataclass(frozen=True)
class ModelTier:
    id: str
    label: str
    #: Roughly what it takes to run at a usable speed, in GB of VRAM.
    vram_gb: int
    note: str


#: Five rungs of one ladder, ordered by what the GPU has to hold.
#:
#: Sized by weights at about 4-bit plus a working context, which is the number
#: that decides whether a model stays resident on the card or spills into
#: system RAM and crawls. These are ollama tags: whichever is chosen has to be
#: pulled with `ollama pull` before it will answer.
MODEL_TIERS: tuple[ModelTier, ...] = (
    ModelTier(
        "llama3.2:3b", "Tier 1 — 3B", 4,
        "Runs on almost anything, integrated graphics included. Fast, and the weakest "
        "at turning a vague sentence into good filters.",
    ),
    ModelTier(
        "llama3.1:8b", "Tier 2 — 8B", 8,
        "The smallest size that reliably plans a multi-part query. A sensible floor "
        "for everyday use.",
    ),
    ModelTier(
        "qwen2.5:14b", "Tier 3 — 14B", 12,
        "Noticeably better at oracle-text phrasing than 8B, and still comfortably "
        "resident on a mid-range card.",
    ),
    ModelTier(
        "qwen2.5:32b", "Tier 4 — 32B", 24,
        "Close to the 70B's reading of intent for a fraction of the wait. The best "
        "trade on a 24GB card.",
    ),
    ModelTier(
        "llama3.3:70b", "Tier 5 — 70B", 48,
        "The most faithful interpreter of an awkward sentence. Below 48GB it offloads "
        "to system RAM and a single pass can take minutes.",
    ),
)


def is_tier(model: str) -> bool:
    return any(tier.id == model for tier in MODEL_TIERS)


def current_model() -> str:
    """The model to actually run: the user's choice, else what config says.

    Tolerates a missing connection so that importing this never depends on the
    database being open -- the configured default is always a correct answer.
    """
    conn = state.conn
    if conn is None:
        return settings.ollama_model
    return get_meta(conn, MODEL_KEY) or settings.ollama_model


def choose_model(model: str) -> None:
    set_meta(state.require_conn(), MODEL_KEY, model)
