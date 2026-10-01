import re
import asyncio
import time
from pathlib import Path
from typing import Dict, Any

from telethon import events, Button
from telethon.tl.custom import Message

from config import is_user_authorized
from api_client import backend_client
from uploader import upload_and_send_media, format_size
from handlers.common import auth_required

URL_REGEX = re.compile(r'(https?://[^\s]+)')

# In-memory store for pending link download choices: {choice_id: {"url": url}}
pending_links: Dict[str, Dict[str, Any]] = {}

def is_music_url(url: str) -> bool:
    lower = url.lower()
    return any(domain in lower for domain in [
        "spotify.com", "deezer.com", "tidal.com", "jiosaavn.com", "music.apple.com"
    ])

@auth_required
async def link_message_handler(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    match = URL_REGEX.search(text)
    if not match:
        return

    url = match.group(1).rstrip('.,;!?')
    choice_id = f"lk_{int(time.time() * 1000) % 1000000}"
    pending_links[choice_id] = {"url": url}

    if is_music_url(url):
        buttons = [
            [
                Button.inline("🎵 Hi-Res FLAC (Lossless)", f"dl_flac:{choice_id}".encode()),
                Button.inline("🎧 MP3 320k", f"dl_mp3:{choice_id}".encode())
            ],
            [Button.inline("❌ Cancel", f"dl_cancel:{choice_id}".encode())]
        ]
        await event.reply(
            f"🎵 **Music Link Detected:**\n`{url}`\n\nSelect desired download quality:",
            buttons=buttons
        )
    else:
        buttons = [
            [
                Button.inline("📹 Best Video (4K/1080p)", f"dl_vid:{choice_id}".encode()),
                Button.inline("🎵 Extract FLAC", f"dl_aflac:{choice_id}".encode())
            ],
            [
                Button.inline("🎧 Extract MP3 (320k)", f"dl_amp3:{choice_id}".encode()),
                Button.inline("❌ Cancel", f"dl_cancel:{choice_id}".encode())
            ]
        ]
        await event.reply(
            f"📥 **Media Link Detected:**\n`{url}`\n\nSelect format to download:",
            buttons=buttons
        )

async def link_callback_handler(event: events.CallbackQuery.Event):
    sender_id = event.sender_id
    if not is_user_authorized(sender_id):
        await event.answer("Access Denied", alert=True)
        return

    data = event.data.decode('utf-8')
    action, choice_id = data.split(":", 1)

    if action == "dl_cancel":
        pending_links.pop(choice_id, None)
        await event.edit("❌ Download cancelled.")
        return

    item = pending_links.pop(choice_id, None)
    if not item:
        await event.edit("⚠️ Link session expired. Please send the URL again.")
        return

    url = item["url"]
    await event.answer()

    status_msg = await event.edit(f"⏳ **Initializing download for:**\n`{url}`")

    # Dispatch to backend
    if action == "dl_flac":
        res = await backend_client.download_url(url, audio_format="flac")
    elif action == "dl_mp3":
        res = await backend_client.download_url(url, audio_format="mp3")
    elif action == "dl_aflac":
        res = await backend_client.download_url(url, audio_format="flac")
    elif action == "dl_amp3":
        res = await backend_client.download_url(url, audio_format="mp3")
    else:
        # Best video
        res = await backend_client.download_url(url, video_quality="best")

    if not res or not res.get("success"):
        err = res.get("error") if res else "Unknown backend error"
        await status_msg.edit(f"❌ **Failed to start download:**\n{err}")
        return

    job_id = res.get("jobId")
    title = res.get("title") or "Media Item"

    # Start tracking and auto-uploader
    asyncio.create_task(
        track_job_and_deliver(
            client=event.client,
            chat_id=event.chat_id,
            job_id=job_id,
            title=title,
            status_msg=status_msg
        )
    )

async def track_job_and_deliver(
    client,
    chat_id: int,
    job_id: str,
    title: str,
    status_msg
):
    last_text = ""
    last_update_ts = 0

    while True:
        await asyncio.sleep(0.5)
        job = await backend_client.get_job(job_id)
        if not job:
            continue

        status = job.get("status")
        prog = job.get("progress") or {}
        pct = prog.get("percent", 0)
        speed = prog.get("speed", "--")
        eta = prog.get("eta", "--")

        now = time.time()
        if now - last_update_ts >= 2.0:
            bar_len = 10
            filled = int(bar_len * (pct / 100)) if pct else 0
            bar = "█" * filled + "░" * (bar_len - filled)
            
            new_text = (
                f"📥 **Downloading:** {job.get('title') or title}\n"
                f"[{bar}] `{pct}%`\n"
                f"⚡ **Speed:** `{speed}` | ⏱ **ETA:** `{eta}`"
            )
            if new_text != last_text:
                try:
                    await status_msg.edit(new_text)
                    last_text = new_text
                    last_update_ts = now
                except Exception:
                    pass

        if status == "completed":
            try:
                await status_msg.edit("⚡ **Processing downloaded media...**")
            except Exception:
                pass

            file_path = backend_client.resolve_local_media_file(job)
            if file_path and file_path.exists():
                meta = {
                    "title": job.get("title") or title,
                    "artist": job.get("artist") or "",
                    "album": job.get("album") or "",
                    "job_id": job_id
                }
                await upload_and_send_media(
                    client=client,
                    chat_id=chat_id,
                    file_path=file_path,
                    metadata=meta,
                    status_message=status_msg
                )
                from config import get_public_url
                pub_url = get_public_url()
                download_url = f"{pub_url}/api/download-file/{job_id}"
                await status_msg.edit(
                    f"✅ **Download Complete!**\n"
                    f"⚠️ File could not be resolved locally for auto-upload.\n"
                    f"🔗 [Direct Server Download]({download_url})"
                )
            break

        elif status in ["failed", "error"]:
            err_msg = job.get("error") or "Unknown error occurred"
            await status_msg.edit(f"❌ **Download Failed:**\n`{err_msg}`")
            break

        elif status == "cancelled":
            await status_msg.edit("⚠️ **Download was cancelled.**")
            break
