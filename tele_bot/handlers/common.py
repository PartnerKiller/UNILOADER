from telethon import events, Button
from telethon.tl.custom import Message
from config import is_user_authorized
from api_client import backend_client

def auth_required(func):
    async def wrapper(event, *args, **kwargs):
        sender_id = event.sender_id
        if not is_user_authorized(sender_id):
            await event.reply(
                f"⛔ **Access Denied**\n\n"
                f"You are not authorized to use this bot.\n"
                f"Your Telegram User ID is: `{sender_id}`\n\n"
                f"Please add this ID to `ALLOWED_USERS` in the server `.env`."
            )
            return
        return await func(event, *args, **kwargs)
    return wrapper

@auth_required
async def start_handler(event: events.NewMessage.Event):
    sender = await event.get_sender()
    name = getattr(sender, 'first_name', 'User') or 'User'
    user_id = event.sender_id

    text = (
        f"🌟 **Welcome to Universal Downloader, {name}!**\n\n"
        f"⚡ **Access:** Authorized\n"
        f"🆔 **Your User ID:** `{user_id}`\n\n"
        f"📥 **Quick Download:**\n"
        f"Simply paste any URL (YouTube, Instagram, TikTok, Deezer, Spotify, Adult/JAV, HLS streams) into this chat!\n\n"
        f"🔍 **Search Hub:**\n"
        f"• `/music <query>` — Search & download Studio Master FLAC\n"
        f"• `/movies <query>` — Search Movies & Series\n"
        f"• `/adult <query>` — Search Adult Hub\n"
        f"• `/queue` — View active downloads\n"
        f"• `/help` — Detailed help & documentation"
    )

    buttons = [
        [
            Button.inline("🎵 Search Music", b"menu_music"),
            Button.inline("🎬 Search Movies", b"menu_movies")
        ],
        [
            Button.inline("🔞 Search Adult", b"menu_adult"),
            Button.inline("📊 Queue Status", b"menu_queue")
        ]
    ]

    await event.reply(text, buttons=buttons)

@auth_required
async def help_handler(event: events.NewMessage.Event):
    text = (
        f"📖 **Universal Downloader Bot Help**\n\n"
        f"**1. Downloading Links:**\n"
        f"Send any media link directly in chat. The bot will prompt you to choose video quality or lossless audio, download it on the server, and deliver the media directly to your Telegram!\n\n"
        f"**2. Music Search (Lossless FLAC):**\n"
        f"Type `/music <song or artist>`\n"
        f"Example: `/music Daft Punk Get Lucky`\n"
        f"Presents interactive results prioritizing 24-bit Hi-Res & 16-bit 44.1kHz FLAC releases.\n\n"
        f"**3. Movies & TV Shows:**\n"
        f"Type `/movies <title>`\n"
        f"Example: `/movies Inception`\n\n"
        f"**4. Adult Hub:**\n"
        f"Type `/adult <query>`\n\n"
        f"**5. Queue & Status:**\n"
        f"Type `/queue` or `/status` to see all running jobs."
    )
    await event.reply(text)

@auth_required
async def queue_handler(event: events.NewMessage.Event):
    session = await backend_client.get_session()
    await backend_client.ensure_auth()
    try:
        async with session.get(f"{backend_client.base_url}/api/jobs?all=1", headers=backend_client._headers(), timeout=10) as resp:
            if resp.status == 200:
                jobs = await resp.json()
                active = [j for j in jobs if j.get("status") in ["downloading", "queued", "resolving"]]
                if not active:
                    await event.reply("✨ **No active downloads in the queue.**")
                    return

                lines = ["📊 **Active Download Queue:**\n"]
                for j in active:
                    title = j.get("title") or "Media Item"
                    status = j.get("status", "unknown")
                    prog = j.get("progress") or {}
                    pct = prog.get("percent", 0)
                    speed = prog.get("speed", "--")
                    eta = prog.get("eta", "--")
                    lines.append(f"• **{title}**\n  Status: `{status}` | `{pct}%` | `{speed}` | ETA: `{eta}`\n")

                await event.reply("\n".join(lines))
                return
    except Exception as e:
        await event.reply(f"⚠️ Error checking queue: {e}")
