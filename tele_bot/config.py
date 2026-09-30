import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
PARENT_ENV_PATH = BASE_DIR.parent / ".env"
FALLBACK_ENV_PATH = Path("/home/sakura/telegram-uploader/.env")

# 1. Load local .env
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)
elif PARENT_ENV_PATH.exists():
    load_dotenv(PARENT_ENV_PATH)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

# Allowed users list (set of ints)
raw_users = os.getenv("ALLOWED_USERS", "").strip()
if raw_users:
    try:
        ALLOWED_USERS = set(int(u.strip()) for u in raw_users.split(",") if u.strip().isdigit())
    except Exception:
        ALLOWED_USERS = set()
else:
    ALLOWED_USERS = set()

# Owner user configuration (Owner has exclusive access to AI Copilot & Neural tools)
raw_owner = os.getenv("OWNER_ID", os.getenv("OWNER_IDS", "1331264249")).strip()
OWNER_IDS = set()
for part in raw_owner.split(","):
    part = part.strip()
    if part.isdigit():
        OWNER_IDS.add(int(part))
if not OWNER_IDS:
    OWNER_IDS = {1331264249}

# Ensure owner IDs are always included in ALLOWED_USERS
ALLOWED_USERS.update(OWNER_IDS)


# MTProto credentials (for uploading files up to 2GB via Telethon)
API_ID = os.getenv("API_ID")
API_HASH = os.getenv("API_HASH")

# Fallback to telegram-uploader .env if not found
if (not API_ID or not API_HASH) and FALLBACK_ENV_PATH.exists():
    try:
        for line in FALLBACK_ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line.startswith("API_ID="):
                API_ID = int(line.split("=", 1)[1].strip().strip("'\""))
            elif line.startswith("API_HASH="):
                API_HASH = line.split("=", 1)[1].strip().strip("'\"")
    except Exception:
        pass

if API_ID and not isinstance(API_ID, int):
    try:
        API_ID = int(API_ID)
    except Exception:
        API_ID = None

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:3050").rstrip("/")
BACKEND_ADMIN_USER = os.getenv("BACKEND_ADMIN_USER", "sakura")
BACKEND_ADMIN_PASS = os.getenv("BACKEND_ADMIN_PASS", "Sakura@002")

TEMP_DIR = Path(os.getenv("TEMP_DIR", "/home/sakura/jav/temp_media")).resolve()
SESSION_DIR = BASE_DIR / "session"
SESSION_DIR.mkdir(parents=True, exist_ok=True)

def is_user_owner(user_id: int) -> bool:
    return user_id in OWNER_IDS

def is_user_authorized(user_id: int) -> bool:
    if not ALLOWED_USERS:
        return True
    return user_id in ALLOWED_USERS or user_id in OWNER_IDS

