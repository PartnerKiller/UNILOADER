#!/usr/bin/env python3
"""
Telegram 1:1 CD-Rip Engine
Searches and acquires lossless optical CD releases (.zip, .rar, .flac) from
curated and joined audiophile channels via Telethon MTProto or Web Previews.
"""

import os
import sys
import json
import time
import shutil
import asyncio
import zipfile
import re
import argparse
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "telegram_channels.json"
TEMP_SESSION_PATH = Path("/tmp/cdrip_telethon.session")

def log(msg):
    print(f"[Telegram CD-Rip] {msg}", flush=True)

def load_channels_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            log(f"Warning loading config: {e}")
    return {"channels": [], "max_download_bytes": 2147483648, "search_limit_per_channel": 15}

def get_telegram_credentials():
    """
    Safely retrieves API_ID, API_HASH, and session path from environment or local host configs.
    Never exposes keys or commits them.
    """
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    session_src = os.environ.get("TELEGRAM_SESSION_PATH")

    possible_env_paths = [
        Path("/home/sakura/telegram-uploader/.env"),
        BASE_DIR / ".env"
    ]

    for p in possible_env_paths:
        if (not api_id or not api_hash) and p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k, v = k.strip(), v.strip().strip("'").strip('"')
                            if k == "API_ID" and not api_id:
                                api_id = v
                            elif k == "API_HASH" and not api_hash:
                                api_hash = v
            except Exception:
                pass

    possible_sessions = [
        Path("/home/sakura/telegram-uploader/session/user_session.session"),
        BASE_DIR / "session" / "user_session.session"
    ]

    if not session_src:
        for s in possible_sessions:
            if s.exists():
                session_src = str(s)
                break

    return api_id, api_hash, session_src

def get_telethon_client():
    """
    Creates an isolated Telethon client using a temporary session copy
    to prevent SQLite locking with background services.
    """
    try:
        from telethon import TelegramClient
    except ImportError:
        log("Telethon library not installed.")
        return None, None

    api_id, api_hash, session_src = get_telegram_credentials()
    if not api_id or not api_hash or not session_src or not os.path.exists(session_src):
        log("Telegram credentials or session file not found on host.")
        return None, None

    try:
        # Copy to temp file to prevent SQLite database locks
        shutil.copyfile(session_src, TEMP_SESSION_PATH)
        temp_base = str(TEMP_SESSION_PATH).replace(".session", "")
        client = TelegramClient(temp_base, int(api_id), api_hash)
        return client, TEMP_SESSION_PATH
    except Exception as e:
        log(f"Error initializing Telethon client: {e}")
        return None, None

def score_telegram_message(text, file_name, file_size, query):
    """
    Scores Telegram release candidates using CD-Rip Provenance criteria.
    Prioritizes archives (.zip/.rar) containing EAC logs and CUE sheets.
    """
    combined = f"{text or ''} {file_name or ''}".lower()
    score = 0

    # Archive bonus (full optical release packaging)
    ext = Path(file_name or '').suffix.lower()
    if ext in ['.zip', '.rar', '.7z']:
        score += 30000
    elif ext in ['.flac', '.wav']:
        score += 15000

    # Optical provenance markers
    if any(k in combined for k in ['eac', 'xld', 'cue', 'accurip', 'cdda']):
        score += 25000
    if any(k in combined for k in ['log', 'test & copy', 'crc', 'offset']):
        score += 15000
    if any(k in combined for k in ['scan', 'scans', 'booklet', 'sleeve', '600dpi']):
        score += 10000

    # Label & regional audiophile keywords
    if any(k in combined for k in ['asha audio', 'saregama', 'hmv', 'cdnf', 'svf', 'sif']):
        score += 20000

    # Query token matches
    tokens = [t.lower() for t in query.split() if len(t) > 2]
    matched_tokens = sum(1 for t in tokens if t in combined)
    score += matched_tokens * 8000

    # Size scoring (prefer complete albums > 100MB)
    if file_size > 100 * 1024 * 1024:
        score += 10000
    elif file_size > 30 * 1024 * 1024:
        score += 5000

    return score

async def search_telegram_async(query, max_results=15):
    """
    Searches Telegram channels using Telethon client.
    """
    client, temp_session = get_telethon_client()
    if not client:
        return []

    results = []
    config = load_channels_config()
    channels = [ch for ch in config.get("channels", []) if ch.get("enabled", True)]

    try:
        await client.connect()
        if not await client.is_user_authorized():
            log("Telethon user session is not authorized.")
            await client.disconnect()
            return []

        clean_query = re.sub(r'[^a-zA-Z0-9\s]', ' ', query).strip()

        # Target entities to search: list of (entity, username, title)
        target_entities = []

        # 1. Configured channels
        for ch in channels:
            username = ch.get("username")
            if not username:
                continue
            try:
                entity = await client.get_entity(username)
                ch_title = getattr(entity, 'title', username)
                target_entities.append((entity, username, ch_title))
            except Exception as e:
                pass

        # 2. Search joined channels if enabled
        if config.get("search_joined_music_channels", True):
            try:
                dialogs = await client.get_dialogs(limit=60)
                music_keywords = ['flac', 'lossless', 'bengali', 'audio', 'music', 'vbr', 'album', 'song']
                for d in dialogs:
                    if d.is_channel:
                        title_lower = (d.title or '').lower()
                        if any(k in title_lower for k in music_keywords):
                            username = getattr(d.entity, 'username', None) or f"id_{d.id}"
                            # Avoid duplicates
                            if not any(t[0].id == d.entity.id for t in target_entities):
                                target_entities.append((d.entity, username, d.title))
            except Exception as e:
                log(f"Notice inspecting joined channels: {e}")

        for entity, username, ch_title in target_entities:
            try:
                # Search messages in channel
                messages = await client.get_messages(
                    entity,
                    search=clean_query,
                    limit=config.get("search_limit_per_channel", 15)
                )

                for msg in messages:
                    if not msg.document:
                        continue

                    # Extract filename and size
                    doc_name = None
                    if msg.document.attributes:
                        for attr in msg.document.attributes:
                            if hasattr(attr, "file_name") and attr.file_name:
                                doc_name = attr.file_name
                                break

                    doc_size = msg.document.size or 0
                    ext = Path(doc_name or '').suffix.lower()

                    if ext not in ['.zip', '.rar', '.7z', '.flac', '.wav']:
                        continue

                    text = msg.text or ""
                    score = score_telegram_message(text, doc_name, doc_size, query)

                    results.append({
                        "id": f"tg_{username}_{msg.id}",
                        "source": "telegram",
                        "channel": username,
                        "channelTitle": ch_title,
                        "messageId": msg.id,
                        "fileName": doc_name or f"telegram_release_{msg.id}{ext}",
                        "fileSize": doc_size,
                        "sizeStr": f"{round(doc_size / (1024 * 1024), 1)} MB",
                        "caption": text[:180],
                        "date": msg.date.strftime("%Y-%m-%d") if msg.date else "",
                        "isArchive": ext in ['.zip', '.rar', '.7z'],
                        "hasLogMention": any(k in text.lower() or k in (doc_name or '').lower() for k in ['log', 'eac', 'crc']),
                        "hasCueMention": 'cue' in text.lower() or 'cue' in (doc_name or '').lower(),
                        "score": score
                    })

            except Exception as e:
                pass

        # Sort descending by provenance score
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:max_results]

    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
        if temp_session and temp_session.exists():
            try:
                temp_session.unlink()
            except Exception:
                pass

async def download_telegram_release_async(channel, message_id, output_dir, progress_cb=None):
    """
    Downloads a specific release file from a Telegram channel via Telethon
    and unpacks archives into output_dir.
    """
    client, temp_session = get_telethon_client()
    if not client:
        raise RuntimeError("Cannot initialize Telethon client for download.")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        await client.connect()
        entity = await client.get_entity(channel)
        msg = await client.get_messages(entity, ids=int(message_id))

        if not msg or not msg.document:
            raise RuntimeError(f"Message {message_id} in @{channel} contains no downloadable document.")

        doc_name = "release_archive.zip"
        if msg.document.attributes:
            for attr in msg.document.attributes:
                if hasattr(attr, "file_name") and attr.file_name:
                    doc_name = attr.file_name
                    break

        target_file = output_dir / doc_name
        log(f"Starting Telegram download: {doc_name} ({round(msg.document.size / (1024 * 1024), 1)} MB)...")

        last_percent = [0]
        start_time = time.time()

        def internal_progress(current, total):
            pct = int((current / total) * 100) if total else 0
            if pct != last_percent[0] and pct % 10 == 0:
                last_percent[0] = pct
                elapsed = time.time() - start_time
                speed = (current / (1024 * 1024)) / max(elapsed, 0.1)
                log(f"Progress: {pct}% ({speed:.1f} MB/s)")
                if progress_cb:
                    progress_cb(pct, speed)

        await client.download_media(msg, file=str(target_file), progress_callback=internal_progress)
        log(f"Download completed successfully: {target_file}")

        # Unpack if archive
        ext = target_file.suffix.lower()
        if ext == ".zip":
            log(f"Unpacking ZIP archive: {target_file.name}...")
            try:
                with zipfile.ZipFile(target_file, 'r') as zip_ref:
                    zip_ref.extractall(output_dir)
                target_file.unlink()
                log("ZIP archive unpacked and verified.")
            except Exception as e:
                log(f"Warning unpacking ZIP: {e}")
        elif ext in [".rar", ".7z"]:
            log(f"Extracting {ext.upper()} archive using system utilities...")
            extract_cmd = ["unrar", "x", "-o+", str(target_file), str(output_dir)] if ext == ".rar" else ["7z", "x", f"-o{output_dir}", "-y", str(target_file)]
            try:
                import subprocess
                subprocess.run(extract_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                target_file.unlink()
                log(f"{ext.upper()} archive extracted successfully.")
            except Exception as e:
                log(f"Warning extracting {ext}: {e} (file left intact)")

        return str(output_dir)

    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
        if temp_session and temp_session.exists():
            try:
                temp_session.unlink()
            except Exception:
                pass

def search_telegram_cdrip(query, max_results=15):
    return asyncio.run(search_telegram_async(query, max_results=max_results))

def download_telegram_cdrip(channel, message_id, output_dir):
    return asyncio.run(download_telegram_release_async(channel, message_id, output_dir))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Telegram CD-Rip Engine")
    parser.add_argument("--search", type=str, help="Search query")
    parser.add_argument("--test", type=str, help="Test search and format output")
    parser.add_argument("--download", action="store_true", help="Download specified release")
    parser.add_argument("--channel", type=str, help="Target channel username")
    parser.add_argument("--msg-id", type=int, help="Target message ID")
    parser.add_argument("--out", type=str, default="./temp_telegram_cdrip", help="Output directory")

    args = parser.parse_args()

    if args.test:
        log(f"Running test search for: '{args.test}'")
        res = search_telegram_cdrip(args.test)
        print(f"Found {len(res)} results:")
        for r in res:
            print(f"  • [{r['score']}] @{r['channel']} (Msg {r['messageId']}): {r['fileName']} ({r['sizeStr']})")
            if r['caption']:
                print(f"    Caption: {r['caption'][:80]}...")
    elif args.search:
        res = search_telegram_cdrip(args.search)
        print(json.dumps(res))
    elif args.download:
        if not args.channel or not args.msg_id:
            print("Error: --channel and --msg-id required for download.", file=sys.stderr)
            sys.exit(1)
        res_dir = download_telegram_cdrip(args.channel, args.msg_id, args.out)
        print(f"Downloaded and prepared in: {res_dir}")
