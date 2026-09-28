import os
import sys
import base64
import time
import tempfile
import asyncio
from pathlib import Path
from typing import Optional, Dict, Any

from telethon import events, Button
from telethon.tl.custom import Message

from config import is_user_authorized
from handlers.common import auth_required
from uploader import format_size
import FastTelethonhelper

# Ensure root jav folder is in path for flac_checker
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from flac_checker import analyze_flac
    HAS_FLAC_CHECKER = True
except ImportError:
    HAS_FLAC_CHECKER = False

TEMP_CHECK_DIR = Path("/tmp/tele_bot_flac_check")
TEMP_CHECK_DIR.mkdir(parents=True, exist_ok=True)

@auth_required
async def checkflac_command(event: events.NewMessage.Event):
    """
    Handles /checkflac command:
    - If replying to an audio or document message, analyzes that media.
    - Otherwise, provides instructions on how to analyze files.
    """
    if not HAS_FLAC_CHECKER:
        await event.reply("⚠️ FLAC Authenticity Checker is not available on this server.")
        return

    reply_to = await event.get_reply_message() if hasattr(event, "get_reply_message") else None
    if reply_to and (getattr(reply_to, "audio", None) or getattr(reply_to, "document", None)):
        # Media found in replied message
        status_msg = await event.reply("⏳ **Downloading audio for spectral authenticity analysis...**")
        await process_media_for_flac_check(event.client, event.chat_id, reply_to, status_msg)
        return

    # Check if current message has media
    if getattr(event, "audio", None) or getattr(event, "document", None):
        status_msg = await event.reply("⏳ **Downloading audio for spectral authenticity analysis...**")
        await process_media_for_flac_check(event.client, event.chat_id, getattr(event, "message", event), status_msg)
        return

    # No media attached or replied
    text = (
        "🔬 **FLAC Authenticity & Spectral Analyzer**\n\n"
        "To verify if a song is genuine Studio Lossless or a fake/upscaled transcode:\n\n"
        "1. **Reply** to any audio or music file in this chat with `/checkflac`.\n"
        "2. Or **upload/forward** a `.flac`, `.wav`, or `.m4a` file directly into this chat.\n\n"
        "The analyzer performs full multi-band FFT energy analysis, Nyquist cutoff frequency detection, and spectrogram generation."
    )
    await event.reply(text)

@auth_required
async def media_file_handler(event: events.NewMessage.Event):
    """
    Detects uploaded audio or FLAC documents and prompts with an analyze button.
    """
    message = event.message
    if not (message.audio or message.document):
        return

    # Check filename extension
    filename = ""
    if message.file and message.file.name:
        filename = message.file.name.lower()
    
    is_flac_or_lossless = any(filename.endswith(ext) for ext in [".flac", ".wav", ".alac", ".aiff"])
    is_other_audio = any(filename.endswith(ext) for ext in [".mp3", ".m4a", ".aac", ".opus", ".ogg"]) or message.audio

    if not (is_flac_or_lossless or is_other_audio):
        return

    # If caption contains /checkflac, analyze immediately
    caption = (message.text or "").strip()
    if "/checkflac" in caption.lower():
        status_msg = await event.reply("⏳ **Downloading audio for spectral authenticity analysis...**")
        await process_media_for_flac_check(event.client, event.chat_id, message, status_msg)
        return

    # Otherwise show button to analyze
    buttons = [
        [Button.inline("🔬 Analyze FLAC Authenticity", f"check_flac:{message.id}".encode())]
    ]
    await event.reply(
        f"🎵 **Audio Received:** `{filename or 'Audio File'}`\n"
        f"Tap below to verify lossless authenticity and view audio spectrogram:",
        buttons=buttons
    )

async def checker_callback_handler(event: events.CallbackQuery.Event):
    sender_id = event.sender_id
    if not is_user_authorized(sender_id):
        await event.answer("Access Denied", alert=True)
        return

    data = event.data.decode('utf-8')
    if not data.startswith("check_flac:"):
        return

    msg_id = int(data.split(":", 1)[1])
    await event.answer("Starting analysis...")

    message = await event.client.get_messages(event.chat_id, ids=msg_id)
    if not message or not (message.audio or message.document):
        await event.edit("⚠️ Media file no longer accessible.")
        return

    status_msg = await event.edit("⏳ **Downloading audio for spectral authenticity analysis...**")
    await process_media_for_flac_check(event.client, event.chat_id, message, status_msg)

async def process_media_for_flac_check(client, chat_id: int, message: Message, status_msg):
    """
    Downloads media, runs analyze_flac, and outputs a rich diagnostic report + spectrogram image.
    """
    orig_filename = (message.file and message.file.name) or f"track_{message.id}.flac"
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in orig_filename)
    tmp_path = TEMP_CHECK_DIR / f"{int(time.time())}_{safe_name}"

    try:
        # Download media with progress updates
        last_up = [0]
        async def dl_progress(current, total):
            now = time.time()
            if now - last_up[0] >= 0.5:
                last_up[0] = now
                pct = int((current / total) * 100) if total > 0 else 0
                bar_len = 10
                filled = int(bar_len * current / total) if total > 0 else 0
                bar = "█" * filled + "░" * (bar_len - filled)
                try:
                    await status_msg.edit(
                        f"⏳ **Downloading for analysis...**\n"
                        f"[{bar}] `{pct}%` ({format_size(current)} / {format_size(total)})"
                    )
                except Exception:
                    pass

        await message.download_media(file=str(tmp_path), progress_callback=dl_progress)

        if not tmp_path.exists() or tmp_path.stat().st_size == 0:
            await status_msg.edit("❌ Failed to download audio media for analysis.")
            return

        await status_msg.edit("🔬 **Computing FFT Nyquist Cutoff & Multi-band Spectral Energy...**")

        # Run analysis (in thread to avoid blocking async loop)
        report = await asyncio.to_thread(analyze_flac, str(tmp_path), generate_spectrogram=True)

        if not report or not report.get("valid"):
            err = report.get("error") if report else "Unknown analysis error"
            await status_msg.edit(f"❌ **Analysis Failed:** `{err}`")
            return

        score = report.get("authenticityScore", 0)
        verdict = report.get("verdict", "UNKNOWN")
        v_title = report.get("verdictTitle", "")
        bps = report.get("bitsPerSample", 16)
        sr = report.get("sampleRate", 44100)
        bitrate = report.get("bitrateKbps", 0)
        channels = report.get("channelLayout", "Stereo")
        nyquist = report.get("nyquistLimitHz", 22050)
        cutoff = report.get("cutoffFrequencyHz")
        f_size = tmp_path.stat().st_size

        if verdict == "GENUINE_HIRES":
            badge = "🌟 **GENUINE 24-BIT HI-RES STUDIO MASTER**"
        elif verdict == "GENUINE_CDDA":
            badge = "✅ **100% GENUINE CD LOSSLESS MASTER**"
        elif verdict == "UPSCALED_HIRES":
            badge = "⚠️ **UPSCALED HI-RES (CDDA RESAMPLED TO HI-RES)**"
        elif verdict == "SUSPICIOUS":
            badge = "⚠️ **SUSPICIOUS LOSSLESS (HIGH-BITRATE COMPRESSED)**"
        else:
            badge = "❌ **FAKE FLAC / UPSCALED LOSS TRANSCODE**"

        lines = [
            f"🔬 **FLAC Authenticity Analysis Report**\n",
            f"📁 **File:** `{orig_filename}`",
            f"💾 **Size:** `{format_size(f_size)}`\n",
            f"🎯 **Verdict:** {badge}",
            f"📊 **Score:** **{score}/100** ({v_title})\n",
            f"🎚 **Resolution:** `{bps}-bit / {sr/1000:.1f} kHz` ({channels})",
            f"⚡ **Bitrate:** `{bitrate} kbps` (Uncompressed Audio Stream)",
            f"📈 **Nyquist Ceiling:** `{nyquist / 1000:.1f} kHz`",
            f"🔍 **Detected Cutoff:** `{f'{cutoff/1000:.1f} kHz' if cutoff else 'None (Full Dynamic Spectrum)'}`\n",
        ]

        # Multi-band Energy
        energy = report.get("energyAnalysis", {})
        if energy:
            lines.append("📊 **Spectral Energy at Critical Frequencies:**")
            for freq_key, label in [("16000", "16.0 kHz"), ("18500", "18.5 kHz"), ("20000", "20.0 kHz"), ("22000", "22.0 kHz"), ("24000", "24.0 kHz")]:
                band = energy.get(freq_key) or energy.get(f"above_{freq_key}hz")
                if band:
                    mean_v = band.get("meanDb") if "meanDb" in band else band.get("mean_db")
                    max_v = band.get("maxDb") if "maxDb" in band else band.get("max_db")
                    status_icon = "🟢" if mean_v is not None and mean_v > -85 else "⚪"
                    lines.append(f"  {status_icon} **{label}:** Mean `{mean_v if mean_v is not None else '--'} dB` | Peak `{max_v if max_v is not None else '--'} dB`")

        # Warnings / Details
        warnings = report.get("warnings", [])
        if warnings:
            lines.append("\n⚠️ **Analysis Notes:**")
            for w in warnings:
                lines.append(f"  • {w}")

        caption = "\n".join(lines)

        # Check for generated spectrogram image
        spec_base64 = report.get("spectrogram")
        spec_file = None
        if spec_base64 and "base64," in spec_base64:
            try:
                raw_b64 = spec_base64.split("base64,", 1)[1]
                img_data = base64.b64decode(raw_b64)
                spec_file = TEMP_CHECK_DIR / f"spec_{int(time.time())}.png"
                with open(spec_file, "wb") as f_img:
                    f_img.write(img_data)
            except Exception as e:
                print(f"[FLAC Checker] Spectrogram decode error: {e}")

        if spec_file and spec_file.exists():
            if len(caption) > 1024:
                short_caption = caption[:1000] + "..."
                await client.send_file(
                    entity=chat_id,
                    file=str(spec_file),
                    caption=short_caption
                )
                await client.send_message(
                    entity=chat_id,
                    message=caption
                )
            else:
                await client.send_file(
                    entity=chat_id,
                    file=str(spec_file),
                    caption=caption
                )
            await status_msg.delete()
        else:
            await status_msg.edit(caption)

    except Exception as e:
        print(f"[FLAC Checker] Processing error: {e}")
        await status_msg.edit(f"❌ **Error during FLAC analysis:** `{e}`")
    finally:
        # Cleanup temp files
        if tmp_path.exists():
            try: os.remove(tmp_path)
            except Exception: pass
        if 'spec_file' in locals() and spec_file and spec_file.exists():
            try: os.remove(spec_file)
            except Exception: pass
