import os
import sys
from pathlib import Path

# Ensure backend package is importable so tests can import server.py
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Load backend/.env explicitly so MONGO_URL, DB_NAME, PKUCITY_ADMIN_EMAIL are visible.
from dotenv import load_dotenv  # noqa: E402
load_dotenv(BACKEND_DIR / ".env")
