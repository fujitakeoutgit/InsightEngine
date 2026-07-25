"""Hallucination containment.

The pipeline's safety does not rest on the model behaving. It rests on two
mechanical properties:

1. The model never emits card data, and never emits prose. Its response schemas
   contain only filter objects and integer arrays, so there is no channel
   through which text it authored can reach the user. Card fields are always
   rehydrated from SQLite (`cards_by_oracle_ids`); a fabricated oracle_id finds
   no row and disappears.
2. Indices are range-checked against the batch actually shown to the model.
   An out-of-range index cannot resolve to a card; it is dropped and counted.

An earlier version also scanned model-written prose for card names. That
scanner is gone because its input is: the summarisation stage was removed, so
the model no longer writes anything a user sees. Removing the channel is a
stronger guarantee than policing it.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GuardReport:
    invalid_indices: list[int] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.invalid_indices

    def as_dict(self) -> dict:
        return {
            "clean": self.clean,
            "invalid_indices": self.invalid_indices,
        }


def validate_indices(raw: object, batch_size: int) -> tuple[list[int], list[int]]:
    """Split model-supplied indices into (valid, invalid).

    Indices are 1-based in the prompt, so they are converted here.
    """
    valid: list[int] = []
    invalid: list[int] = []
    if not isinstance(raw, list):
        return valid, invalid
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int):
            invalid.append(item if isinstance(item, int) else -1)
            continue
        if 1 <= item <= batch_size:
            valid.append(item - 1)
        else:
            invalid.append(item)
    return sorted(set(valid)), invalid
