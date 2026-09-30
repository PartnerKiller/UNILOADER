from telethon import events, Button
from telethon.tl.custom import Message
from config import is_user_authorized, is_user_owner
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

def owner_required(func):
    async def wrapper(event, *args, **kwargs):
        sender_id = event.sender_id
        if not is_user_authorized(sender_id):
            await event.reply(
                f"⛔ **Access Denied**\n\n"
                f"You are not authorized to use this bot.\n"
                f"Your Telegram User ID is: `{sender_id}`"
            )
            return
        if not is_user_owner(sender_id):
            await event.reply(
                f"🔒 **Owner Access Required**\n\n"
                f"AI Copilot & Neural tools are strictly reserved for the server owner.\n"
                f"Your Telegram User ID `{sender_id}` does not have owner privileges."
            )
            return
        return await func(event, *args, **kwargs)
    return wrapper

@auth_required
async def start_handler(event: events.NewMessage.Event):
    sender = await event.get_sender()
    name = getattr(sender, 'first_name', 'User') or 'User'
    user_id = event.sender_id
    is_owner = is_user_owner(user_id)

    role_str = "👑 Server Owner (Full AI Privileges Enabled)" if is_owner else "Authorized User"
    ai_status_line = "\n🤖 **AI Copilot & Neural Engine:** Active & Ready" if is_owner else ""

    text = (
        f"🌟 **Welcome to Universal Downloader, {name}!**\n\n"
        f"⚡ **Access:** Authorized ({role_str})\n"
        f"🆔 **Your User ID:** `{user_id}`{ai_status_line}\n\n"
        f"📥 **Direct Downloads:**\n"
        f"Simply paste any URL (YouTube, Instagram, TikTok, Deezer, Spotify, Adult/JAV, HLS streams) into this chat!\n\n"
        f"🔍 **Search with Previews:**\n"
        f"• `/music` or `/music <song>` — Search & preview Hi-Res FLAC tracks\n"
        f"• `/movies` or `/movies <title>` — Search, preview posters & download Movies/Series\n"
        f"• `/adult` or `/adult <query>` — Search, preview covers & download Adult Hub\n"
        f"• Or simply **type any content name directly** into chat to search!\n\n"
        f"🔬 **Tools & Analysis:**\n"
        f"• `/checkflac` — Multi-band FLAC Authenticity & Spectral Analyzer"
    )

    if is_owner:
        text += (
            f"\n\n🤖 **AI Copilot (Owner Exclusive):**\n"
            f"• `/ai <prompt>` or `/copilot <prompt>` — Natural language copilot\n"
            f"• `/clean <filename>` — Clean & parse messy release filenames\n"
            f"• `/translate <title>` — Clean & translate Japanese titles\n"
            f"• Send photo — Multimodal visual JAV & actress recognition"
        )

    text += (
        f"\n\n📊 **System:**\n"
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
            Button.inline("🔬 FLAC Checker", b"menu_checker")
        ]
    ]

    if is_owner:
        buttons.append([
            Button.inline("🤖 AI Copilot Hub", b"menu_ai"),
            Button.inline("📊 Queue Status", b"menu_queue")
        ])
    else:
        buttons.append([
            Button.inline("📊 Queue Status", b"menu_queue")
        ])

    await event.reply(text, buttons=buttons)

@auth_required
async def help_handler(event: events.NewMessage.Event):
    user_id = event.sender_id
    is_owner = is_user_owner(user_id)

    ai_help_section = ""
    if is_owner:
        ai_help_section = (
            f"\n\n**5. 🤖 AI Copilot & Neural Engine (Owner Exclusive):**\n"
            f"• `/ai <prompt>` or `/copilot <prompt>`: Talk to Gemini AI or send natural language download requests (e.g. `/copilot download Hans Zimmer Interstellar in 24bit flac`).\n"
            f"• `/clean <filename>`: Parse and standardize messy scene/torrent release filenames.\n"
            f"• `/translate <title>`: Clean clickbait Japanese prefixes and translate JAV titles & synopses.\n"
            f"• **AI Spectrogram Audit**: Every `/checkflac` report automatically includes deep Gemini Audiophile Spectrogram evaluation.\n"
            f"• **Visual Recognition**: Upload any image or screenshot to automatically identify actress, studio, and JAV code series."
        )

    text = (
        f"📖 **Universal Downloader Bot Help**\n\n"
        f"**1. Downloading Links:**\n"
        f"Send any media link directly in chat. The bot will prompt you to choose video quality or lossless audio, download it on the server, and deliver the media directly to your Telegram!\n\n"
        f"**2. Search with Rich Previews:**\n"
        f"• Type `/music`, `/movies`, or `/adult` and the bot will ask you for what to find.\n"
        f"• Or type `/music <query>`, `/movies <query>`, or `/adult <query>` directly.\n"
        f"• Or just send any content name (e.g. `Coldplay Yellow`) directly in chat!\n"
        f"• Tap **👁 Preview** on any search result to view official posters, album artwork, full synopsis, and duration before downloading.\n\n"
        f"**3. FLAC Authenticity Checker:**\n"
        f"Reply to any audio or FLAC file with `/checkflac` to compute FFT Nyquist ceiling, detect fake upscaled transcodes, and generate visual spectrograms.\n\n"
        f"**4. Queue & Status:**\n"
        f"Type `/queue` or `/status` to see all running downloads."
        f"{ai_help_section}"
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
