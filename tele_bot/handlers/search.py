import asyncio
import time
from typing import Dict, Any, List

from telethon import events, Button
from telethon.tl.custom import Message

from config import is_user_authorized
from api_client import backend_client
from handlers.common import auth_required
from handlers.links import track_job_and_deliver

# In-memory store for active searches: {search_id: {"type": str, "results": list, "page": int}}
search_cache: Dict[str, Dict[str, Any]] = {}

PAGE_SIZE = 5

@auth_required
async def music_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        await event.reply("ℹ️ **Usage:** `/music <song or artist name>`\n\nExample: `/music Daft Punk Get Lucky`")
        return

    query = parts[1].strip()
    status_msg = await event.reply(f"🔍 **Searching Hi-Res Music for:** `{query}`...")

    results = await backend_client.search_music(query)
    if not results:
        await status_msg.edit(f"❌ No music tracks found for `{query}`.")
        return

    search_id = f"ms_{int(time.time() * 1000) % 1000000}"
    search_cache[search_id] = {
        "type": "music",
        "query": query,
        "results": results,
        "page": 0
    }

    await render_music_page(event, status_msg, search_id, page=0)

async def render_music_page(event, message, search_id: str, page: int):
    data = search_cache.get(search_id)
    if not data:
        await message.edit("⚠️ Search session expired. Please search again.")
        return

    results = data["results"]
    total = len(results)
    start_idx = page * PAGE_SIZE
    end_idx = min(start_idx + PAGE_SIZE, total)
    current_items = results[start_idx:end_idx]

    lines = [f"🎵 **Hi-Res Music Search:** `{data['query']}` (Page {page + 1}/{(total + PAGE_SIZE - 1) // PAGE_SIZE})\n"]
    buttons = []

    for i, item in enumerate(current_items, start=1):
        global_idx = start_idx + i - 1
        title = item.get("title", "Unknown")
        artist = item.get("artist", "Unknown")
        album = item.get("album", "")
        duration = item.get("durationStr") or ""
        source = (item.get("source") or "HIFI").upper()

        album_str = f" • _{album}_" if album else ""
        dur_str = f" `[{duration}]`" if duration else ""
        lines.append(f"**{i}.** **{title}** — {artist}{dur_str}\n   *Source: {source}*{album_str}")

        row = [
            Button.inline(f"🎵 {i}. FLAC", f"m_dl:{search_id}:{global_idx}:flac".encode()),
            Button.inline(f"🎧 {i}. MP3", f"m_dl:{search_id}:{global_idx}:mp3".encode())
        ]
        buttons.append(row)

    # Navigation buttons
    nav_row = []
    if page > 0:
        nav_row.append(Button.inline("⬅️ Prev", f"m_page:{search_id}:{page - 1}".encode()))
    if end_idx < total:
        nav_row.append(Button.inline("Next ➡️", f"m_page:{search_id}:{page + 1}".encode()))
    if nav_row:
        buttons.append(nav_row)

    buttons.append([Button.inline("❌ Close", f"m_close:{search_id}".encode())])

    await message.edit("\n".join(lines), buttons=buttons)

@auth_required
async def movies_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        await event.reply("ℹ️ **Usage:** `/movies <movie or show title>`\n\nExample: `/movies Inception`")
        return

    query = parts[1].strip()
    status_msg = await event.reply(f"🎬 **Searching Movies & Series for:** `{query}`...")

    results = await backend_client.search_movies(query)
    if not results:
        await status_msg.edit(f"❌ No movies or TV series found for `{query}`.")
        return

    lines = [f"🎬 **Search Results for:** `{query}`\n"]
    buttons = []
    for i, item in enumerate(results[:5], start=1):
        title = item.get("title") or item.get("name") or "Movie"
        year = item.get("year") or ""
        url = item.get("url") or item.get("link") or ""
        lines.append(f"**{i}.** {title} ({year})")
        if url:
            buttons.append([Button.inline(f"📥 Download #{i}", f"mv_dl:{url[:50]}".encode())])

    await status_msg.edit("\n".join(lines), buttons=buttons if buttons else None)

@auth_required
async def adult_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        await event.reply("ℹ️ **Usage:** `/adult <query>`\n\nExample: `/adult SONE`")
        return

    query = parts[1].strip()
    status_msg = await event.reply(f"🔞 **Searching Adult Hub for:** `{query}`...")

    results = await backend_client.search_adult(query)
    if not results:
        await status_msg.edit(f"❌ No results found for `{query}`.")
        return

    lines = [f"🔞 **Adult Hub Results for:** `{query}`\n"]
    buttons = []
    for i, item in enumerate(results[:5], start=1):
        title = item.get("title") or "Adult Video"
        url = item.get("url") or item.get("link") or ""
        lines.append(f"**{i}.** {title}")
        if url:
            buttons.append([Button.inline(f"📥 Download #{i}", f"ad_dl:{url[:50]}".encode())])

    await status_msg.edit("\n".join(lines), buttons=buttons if buttons else None)

async def search_callback_handler(event: events.CallbackQuery.Event):
    sender_id = event.sender_id
    if not is_user_authorized(sender_id):
        await event.answer("Access Denied", alert=True)
        return

    data = event.data.decode('utf-8')

    # Menu shortcuts from /start
    if data == "menu_music":
        await event.answer()
        await event.reply("🎵 Send `/music <song name>` to search Hi-Res FLAC tracks.\nExample: `/music The Weeknd Blinding Lights`")
        return
    elif data == "menu_movies":
        await event.answer()
        await event.reply("🎬 Send `/movies <title>` to search Movies & TV Shows.\nExample: `/movies Oppenheimer`")
        return
    elif data == "menu_adult":
        await event.answer()
        await event.reply("🔞 Send `/adult <query>` to search the Adult Hub.")
        return
    elif data == "menu_queue":
        await event.answer()
        from handlers.common import queue_handler
        await queue_handler(event)
        return

    # Music pagination
    if data.startswith("m_page:"):
        _, search_id, page_str = data.split(":")
        await event.answer()
        await render_music_page(event, await event.get_message(), search_id, int(page_str))
        return

    # Music close
    if data.startswith("m_close:"):
        _, search_id = data.split(":")
        search_cache.pop(search_id, None)
        await event.delete()
        return

    # Music download
    if data.startswith("m_dl:"):
        _, search_id, idx_str, fmt = data.split(":")
        cached = search_cache.get(search_id)
        if not cached:
            await event.answer("Search expired", alert=True)
            return

        idx = int(idx_str)
        item = cached["results"][idx]
        title = item.get("title", "Track")
        artist = item.get("artist", "")
        is_flac = (fmt == "flac")

        await event.answer(f"Queuing {'FLAC' if is_flac else 'MP3'}: {title}...")
        status_msg = await event.reply(f"⏳ **Initializing download for:**\n🎵 **{artist} - {title}** (`{fmt.upper()}`)")

        res = await backend_client.download_music(item, flac=is_flac)
        if not res or not res.get("success"):
            err = res.get("error") if res else "Unknown backend error"
            await status_msg.edit(f"❌ **Failed to dispatch music download:**\n`{err}`")
            return

        job_id = res.get("jobId")
        asyncio.create_task(
            track_job_and_deliver(
                client=event.client,
                chat_id=event.chat_id,
                job_id=job_id,
                title=f"{artist} - {title}",
                status_msg=status_msg
            )
        )
