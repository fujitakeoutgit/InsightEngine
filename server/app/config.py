"""Runtime configuration.

Every value is overridable by environment variable (or a .env file next to the
server package) so the same build can be pointed at a different model or a
different data directory without a code change.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = SERVER_ROOT.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVER_ROOT / ".env",
        env_prefix="INSIGHT_",
        extra="ignore",
    )

    # --- storage -----------------------------------------------------------
    data_dir: Path = PROJECT_ROOT / "data"
    db_path: Path = PROJECT_ROOT / "data" / "manafold.sqlite3"

    # --- Scryfall ----------------------------------------------------------
    # Scryfall asks for a descriptive User-Agent and ~10 requests/second.
    # https://scryfall.com/docs/api
    scryfall_base: str = "https://api.scryfall.com"
    scryfall_user_agent: str = "InsightEnigma/1.0 (+https://github.com/fujitakeoutgit/manafold)"
    scryfall_min_interval: float = 0.1  # seconds between requests => 10 req/s
    scryfall_max_concurrency: int = 4
    scryfall_timeout: float = 30.0
    cache_ttl_seconds: int = 60 * 60 * 12
    cache_max_entries: int = 5_000

    # --- Ollama / local LLM ------------------------------------------------
    ollama_base: str = "http://localhost:11434"
    ollama_model: str = "llama3.3:70b"
    # Thoroughness over speed: a long ceiling is deliberate. A cold 70B that
    # partially offloads to system RAM can take minutes for a single pass.
    ollama_timeout: float = 900.0
    ollama_num_ctx: int = 16384
    # Deterministic decoding. Non-zero temperature is the primary driver of
    # fabricated card names, so planning runs at 0.
    ollama_temperature: float = 0.0

    # --- semantic pipeline -------------------------------------------------
    semantic_max_plans: int = 8          # complementary query plans per search
    semantic_candidate_cap: int = 400    # rows handed to the grounding pass
    semantic_return_cap: int = 60        # cards shown to the user
    # One GPU, one run. A second concurrent run does not go twice as fast --
    # it thrashes a model that is already spilling into system RAM, and makes
    # both take longer. This is also the only thing standing between a shared
    # LAN instance and one person monopolising the card.
    semantic_max_concurrent: int = 1

    # --- serving -----------------------------------------------------------
    # 127.0.0.1 keeps the API off the network. Set 0.0.0.0 to share it on a
    # trusted LAN, and read the security note in the README before doing so:
    # there is no authentication, and the semantic endpoint is expensive.
    host: str = "127.0.0.1"
    port: int = 8787
    # Extra browser origins allowed to call the API. The Vite dev server proxies
    # /api from its own origin, so this only matters for direct cross-origin use.
    extra_cors_origins: str = ""

    @property
    def bulk_dir(self) -> Path:
        return self.data_dir / "bulk"


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.bulk_dir.mkdir(parents=True, exist_ok=True)
