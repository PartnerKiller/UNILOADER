#!/usr/bin/env python3
import asyncio
import logging
import signal
import sys
from pathlib import Path

from telethon import TelegramClient, events
from telethon.errors import InvalidBufferError, FloodWaitError
from telethon.tl.functions.bots import SetBotCommandsRequest
from telethon.tl.types import BotCommand, BotCommandScopeDefault

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
    plain_text_query_handler,
    search_callback_handler
)
from handlers.checker import (
    checkflac_command,
    media_file_handler,
    checker_callback_handler
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
client = TelegramClient(
    str(session_path),
    API_ID,
    API_HASH,
    timeout=20,
    connection_retries=10,
    retry_delay=3,
    auto_reconnect=True,
    flood_sleep_threshold=120
)

async def setup_bot_commands():
    """Registers bot commands with Telegram so typing '/' displays the full autocomplete palette."""
    commands = [
        BotCommand(command="start", description="Start bot & show main menu"),
        BotCommand(command="music", description="Search & download Hi-Res Studio FLAC"),
        BotCommand(command="movies", description="Search Movies & TV Series"),
        BotCommand(command="adult", description="Search Adult & JAV Hub"),
        BotCommand(command="checkflac", description="Analyze FLAC audio authenticity & spectrum"),
        BotCommand(command="queue", description="View active download queue"),
        BotCommand(command="help", description="Show help & documentation")
    ]
    try:
        await client(SetBotCommandsRequest(
            scope=BotCommandScopeDefault(),
            lang_code='',
            commands=commands
        ))
        logger.info("Bot commands palette successfully registered with Telegram.")
    except Exception as e:
        logger.warning(f"Failed to register bot commands with Telegram: {e}")

def register_handlers():
    # Commands
    client.add_event_handler(start_handler, events.NewMessage(pattern=r"^/start"))
    client.add_event_handler(help_handler, events.NewMessage(pattern=r"^/help"))
    client.add_event_handler(queue_handler, events.NewMessage(pattern=r"^/(queue|status)"))

    client.add_event_handler(music_search_command, events.NewMessage(pattern=r"^/music"))
    client.add_event_handler(movies_search_command, events.NewMessage(pattern=r"^/movies"))
    client.add_event_handler(adult_search_command, events.NewMessage(pattern=r"^/adult"))
    client.add_event_handler(checkflac_command, events.NewMessage(pattern=r"^/checkflac"))

    # Link pasting
    client.add_event_handler(
        link_message_handler,
        events.NewMessage(pattern=r"(?i)^(?!\/(start|help|queue|status|music|movies|adult|checkflac)).*https?:\/\/")
    )

    # Audio & FLAC file upload detection
    client.add_event_handler(
        media_file_handler,
        events.NewMessage(func=lambda e: bool(e.audio or (e.document and not (e.text or '').startswith('/'))))
    )

    # Plain-text conversational search & content query handler
    client.add_event_handler(
        plain_text_query_handler,
        events.NewMessage(func=lambda e: bool(
            e.text and not e.text.startswith('/') and not ('http://' in e.text or 'https://' in e.text) and not e.audio and not e.document
        ))
    )

    # Callback queries
    client.add_event_handler(
        link_callback_handler,
        events.CallbackQuery(pattern=r"^dl_")
    )
    client.add_event_handler(
        search_callback_handler,
        events.CallbackQuery(pattern=r"^(m_|menu_|mv_|ad_|q_)")
    )
    client.add_event_handler(
        checker_callback_handler,
        events.CallbackQuery(pattern=r"^check_flac:")
    )

async def run_bot():
    logger.info("Initializing Universal Downloader Telegram Bot...")
    register_handlers()

    consecutive_failures = 0
    while True:
        try:
            logger.info("Connecting to Telegram MTProto servers...")
            # Enforce 30s timeout on start() to prevent indefinite socket hangs
            await asyncio.wait_for(client.start(bot_token=BOT_TOKEN), timeout=30.0)

            me = await asyncio.wait_for(client.get_me(), timeout=15.0)
            logger.info(f"Bot connected successfully as @{me.username} (ID: {me.id})")
            logger.info(f"Authorized User IDs: {list(ALLOWED_USERS) if ALLOWED_USERS else 'ALL (open)'}")
            logger.info(f"Backend Target: {BACKEND_URL}")

            # Register '/' command palette with Telegram (non-critical)
            try:
                await asyncio.wait_for(setup_bot_commands(), timeout=15.0)
            except Exception as e:
                logger.warning(f"Could not setup bot commands: {e}")

            # Authenticate to backend
            try:
                auth_ok = await backend_client.ensure_auth()
                if auth_ok:
                    logger.info("Universal Downloader backend authentication verified.")
                else:
                    logger.warning("Could not authenticate with backend. Please verify BACKEND_URL and credentials.")
            except Exception as e:
                logger.warning(f"Backend auth check error: {e}")

            consecutive_failures = 0
            logger.info("UniBot is now running and listening for events...")
            await client.run_until_disconnected()
            logger.warning("Telegram client disconnected. Attempting reconnection in 5s...")
            await asyncio.sleep(5)

        except (KeyboardInterrupt, SystemExit, asyncio.CancelledError):
            logger.info("Bot execution terminating cleanly...")
            try:
                await client.disconnect()
            except Exception:
                pass
            break
        except (InvalidBufferError, FloodWaitError) as e:
            wait_sec = getattr(e, 'seconds', 60) or 60
            consecutive_failures += 1
            delay = min(wait_sec + (consecutive_failures * 5), 300)
            logger.error(f"Telegram rate limited or buffer error: {e}. Backing off for {delay}s...")
            try:
                await client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(delay)
        except (ConnectionError, OSError, asyncio.TimeoutError) as e:
            consecutive_failures += 1
            delay = min(5 * consecutive_failures, 60)
            logger.warning(f"Connection issue encountered: {e}. Reconnecting in {delay}s...")
            try:
                await client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(delay)
        except Exception as e:
            consecutive_failures += 1
            delay = min(10 * consecutive_failures, 60)
            logger.exception(f"Unexpected error in bot lifecycle: {e}. Retrying in {delay}s...")
            try:
                await client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(delay)

if __name__ == "__main__":
    try:
        asyncio.run(run_bot())
    except (KeyboardInterrupt, SystemExit):
        logger.info("Shutting down bot...")
