import os
import time
import json
import asyncio
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any

from telethon import TelegramClient
from telethon.tl.types import (
    DocumentAttributeAudio,
    DocumentAttributeVideo,
    DocumentAttributeFilename
)
import FastTelethonhelper

TEMP_THUMBS_DIR = Path("/tmp/tele_bot_thumbs")
TEMP_THUMBS_DIR.mkdir(parents=True, exist_ok=True)

def probe_media(file_path: Path) -> Dict[str, Any]:
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(file_path)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
        if res.returncode == 0:
            return json.loads(res.stdout)
    except Exception as e:
        print(f"[probe_media] Error probing {file_path}: {e}")
    return {}

def extract_video_thumb(file_path: Path, out_path: Path) -> bool:
    try:
        cmd = [
            "ffmpeg", "-y", "-ss", "00:00:02", "-i", str(file_path),
            "-vframes", "1", "-vf", "scale=320:-1", str(out_path)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception:
        return False

def extract_audio_thumb(file_path: Path, out_path: Path) -> bool:
    try:
        cmd = [
            "ffmpeg", "-y", "-i", str(file_path),
            "-an", "-vcodec", "copy", str(out_path)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception:
        return False

def format_size(bytes_val: int) -> str:
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_val < 1024.0:
            return f"{bytes_val:.2f} {unit}"
        bytes_val /= 1024.0
    return f"{bytes_val:.2f} TB"

async def upload_and_send_media(
    client: TelegramClient,
    chat_id: int,
    file_path: Path,
    metadata: Dict[str, Any],
    status_message=None
):
    """
    Fast uploads media via Telethon MTProto and sends native Audio/Video/Document.
    Supports files up to 2GB with live upload progress.
    """
    if not file_path.exists():
        if status_message:
            await status_message.edit("❌ Error: Downloaded file not found on disk.")
        return

    file_size = file_path.stat().st_size
    filename = file_path.name
    ext = file_path.suffix.lower()

    # Telegram MTProto Bot API limit is 2000 MB
    MAX_TELEGRAM_UPLOAD = 2000 * 1024 * 1024
    if file_size > MAX_TELEGRAM_UPLOAD:
        if status_message:
            job_id = metadata.get("job_id")
            dl_hint = ""
            if job_id:
                from config import BACKEND_URL
                dl_hint = f"\n\n🔗 [Direct Browser Download]({BACKEND_URL}/api/download-file/{job_id})"
            await status_message.edit(
                f"✅ **Download Complete!**\n\n"
                f"📁 **File:** `{filename}`\n"
                f"💾 **Size:** `{format_size(file_size)}`\n\n"
                f"⚠️ File exceeds Telegram's **2.0 GB** bot upload limit.\n"
                f"📂 Stored on server at:\n`{file_path}`{dl_hint}"
            )
        return

    # Determine media kind
    is_audio = ext in [".flac", ".mp3", ".m4a", ".wav", ".aac", ".opus", ".ogg"]
    is_video = ext in [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts"]

    # Probe media info
    info = probe_media(file_path)
    format_info = info.get("format", {})
    streams = info.get("streams", [])

    duration = 0
    try:
        duration = int(float(format_info.get("duration", 0)))
    except Exception:
        pass

    attributes = [DocumentAttributeFilename(file_name=filename)]
    thumb_path = None
    clean_thumb = False

    # Title & Artist metadata
    title = metadata.get("title") or format_info.get("tags", {}).get("title") or file_path.stem
    artist = metadata.get("artist") or format_info.get("tags", {}).get("artist") or ""

    if is_audio:
        attributes.append(DocumentAttributeAudio(
            duration=duration,
            title=title,
            performer=artist
        ))
        thumb_candidate = TEMP_THUMBS_DIR / f"thumb_{file_path.stem}.jpg"
        if extract_audio_thumb(file_path, thumb_candidate):
            thumb_path = str(thumb_candidate)
            clean_thumb = True
    elif is_video:
        width = 1280
        height = 720
        for s in streams:
            if s.get("codec_type") == "video":
                width = int(s.get("width", 1280))
                height = int(s.get("height", 720))
                break
        attributes.append(DocumentAttributeVideo(
            duration=duration,
            w=width,
            h=height,
            supports_streaming=True
        ))
        thumb_candidate = TEMP_THUMBS_DIR / f"thumb_{file_path.stem}.jpg"
        if extract_video_thumb(file_path, thumb_candidate):
            thumb_path = str(thumb_candidate)
            clean_thumb = True

    # Caption
    caption_lines = [
        f"✅ **{title}**",
    ]
    if artist:
        caption_lines.append(f"👤 **Artist:** {artist}")
    caption_lines.append(f"💾 **Size:** {format_size(file_size)}")
    if duration > 0:
        mins, secs = divmod(duration, 60)
        caption_lines.append(f"⏱ **Duration:** {mins:02d}:{secs:02d}")
    
    caption = "\n".join(caption_lines)

    # Upload using FastTelethonhelper
    if status_message:
        await status_message.edit(f"🚀 **Uploading to Telegram...**\n📁 `{filename}` ({format_size(file_size)})")

    last_update_time = [0]
    async def upload_progress(current, total):
        now = time.time()
        if now - last_update_time[0] >= 0.5:
            last_update_time[0] = now
            pct = int((current / total) * 100) if total > 0 else 0
            bar_len = 10
            filled = int(bar_len * current / total) if total > 0 else 0
            bar = "█" * filled + "░" * (bar_len - filled)
            try:
                if status_message:
                    await status_message.edit(
                        f"🚀 **Uploading to Telegram...**\n"
                        f"📁 `{filename}`\n"
                        f"[{bar}] {pct}% • {format_size(current)} / {format_size(total)}"
                    )
            except Exception:
                pass

    try:
        # Fast upload
        with open(file_path, "rb") as f:
            uploaded_file = await FastTelethonhelper.upload_file(
                client=client,
                file=f,
                name=filename,
                progress_callback=upload_progress
            )

        # Send to chat
        await client.send_file(
            entity=chat_id,
            file=uploaded_file,
            caption=caption,
            attributes=attributes,
            thumb=thumb_path,
            supports_streaming=is_video
        )

        if status_message:
            await status_message.delete()

    except Exception as e:
        print(f"[Uploader] Send file error: {e}")
        if status_message:
            await status_message.edit(f"❌ Failed to upload to Telegram: {e}")
    finally:
        if clean_thumb and thumb_path and os.path.exists(thumb_path):
            try:
                os.remove(thumb_path)
            except Exception:
                pass
