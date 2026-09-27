#!/usr/bin/env python3
import asyncio
import logging
import signal
import sys
from pathlib import Path

from telethon import TelegramClient, events

from config import (
    BOT_TOKEN,
    API_ID,
    API_HASH,
    ALLOWED_USERS,
    SESSION_DIR,
    BACKEND_URL
)
from api_client import backend_client
from handlers.common import start_handler, help_handler, queue_handler
from handlers.links import link_message_handler, link_callback_handler
from handlers.search import (
    music_search_command,
    movies_search_command,
    adult_search_command,
    search_callback_handler
)

logging.basicConfig(
    format="[%(asctime)s] [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("UniBot")

if not BOT_TOKEN:
    logger.error("BOT_TOKEN is not set in tele_bot/.env. Exiting.")
    sys.exit(1)

if not API_ID or not API_HASH:
    logger.error("API_ID and API_HASH are required for MTProto high-speed transfers. Exiting.")
    sys.exit(1)

session_path = SESSION_DIR / "bot_session"
client = TelegramClient(str(session_path), API_ID, API_HASH)

def register_handlers():
    # Commands
    client.add_event_handler(start_handler, events.NewMessage(pattern=r"^/start"))
    client.add_event_handler(help_handler, events.NewMessage(pattern=r"^/help"))
    client.add_event_handler(queue_handler, events.NewMessage(pattern=r"^/(queue|status)"))

    client.add_event_handler(music_search_command, events.NewMessage(pattern=r"^/music"))
    client.add_event_handler(movies_search_command, events.NewMessage(pattern=r"^/movies"))
    client.add_event_handler(adult_search_command, events.NewMessage(pattern=r"^/adult"))

    # Link pasting
    client.add_event_handler(
        link_message_handler,
        events.NewMessage(pattern=r"(?i)^(?!\/(start|help|queue|status|music|movies|adult)).*https?:\/\/")
    )

    # Callback queries
    client.add_event_handler(
        link_callback_handler,
        events.CallbackQuery(pattern=r"^dl_")
    )
    client.add_event_handler(
        search_callback_handler,
        events.CallbackQuery(pattern=r"^(m_|menu_|mv_|ad_)")
    )

async def main():
    logger.info("Initializing Universal Downloader Telegram Bot...")
    register_handlers()

    await client.start(bot_token=BOT_TOKEN)
    me = await client.get_me()
    logger.info(f"Bot connected successfully as @{me.username} (ID: {me.id})")
    logger.info(f"Authorized User IDs: {list(ALLOWED_USERS) if ALLOWED_USERS else 'ALL (open)'}")
    logger.info(f"Backend Target: {BACKEND_URL}")

    # Authenticate to backend
    auth_ok = await backend_client.ensure_auth()
    if auth_ok:
        logger.info("Universal Downloader backend authentication verified.")
    else:
        logger.warning("Could not authenticate with backend. Please verify BACKEND_URL and credentials.")

    logger.info("UniBot is now running and listening for events...")
    await client.run_until_disconnected()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logger.info("Shutting down bot...")
