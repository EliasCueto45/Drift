"""Local files supply defaults; explicitly exported deployment variables always win."""

import os
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[5]
values = {**dotenv_values(ROOT / ".env"), **dotenv_values(ROOT / "apps/web/.env.local")}
for key, value in values.items():
    if value is not None:
        os.environ.setdefault(key, value)
