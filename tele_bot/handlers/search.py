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

MOVIE_PAGE_SIZE = 3
ADULT_PAGE_SIZE = 5

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

    search_id = f"mv_{int(time.time() * 1000) % 1000000}"
    search_cache[search_id] = {
        "type": "movies",
        "query": query,
        "results": results,
        "page": 0
    }

    await render_movies_page(event, status_msg, search_id, page=0)

async def render_movies_page(event, message, search_id: str, page: int):
    data = search_cache.get(search_id)
    if not data:
        await message.edit("⚠️ Movie search session expired. Please search again.")
        return

    results = data["results"]
    total = len(results)
    start_idx = page * MOVIE_PAGE_SIZE
    end_idx = min(start_idx + MOVIE_PAGE_SIZE, total)
    current_items = results[start_idx:end_idx]

    total_pages = (total + MOVIE_PAGE_SIZE - 1) // MOVIE_PAGE_SIZE
    lines = [f"🎬 **Movies & Series Search:** `{data['query']}` (Page {page + 1}/{total_pages})\n"]
    buttons = []

    for i, item in enumerate(current_items, start=1):
        global_idx = start_idx + i - 1
        title = item.get("pureTitle") or item.get("title") or "Movie"
        year = f" ({item.get('year')})" if item.get("year") else ""
        rating = f" ⭐ `{item.get('rating')}`" if item.get("rating") else ""
        releases = item.get("releases") or []

        lines.append(f"**{i}.** **{title}{year}**{rating}")
        
        # Add buttons for available release qualities
        if releases:
            rel_buttons = []
            for r_idx, rel in enumerate(releases[:3]):
                q = rel.get("quality") or "1080p"
                sz = rel.get("size") or ""
                label = f"🎬 {i}. {q}" + (f" [{sz}]" if sz else "")
                rel_buttons.append(Button.inline(label, f"mv_dl:{search_id}:{global_idx}:{r_idx}".encode()))
            
            # Format in rows of 2 or 1
            if len(rel_buttons) <= 2:
                buttons.append(rel_buttons)
            else:
                buttons.append(rel_buttons[:2])
                buttons.append(rel_buttons[2:])
        else:
            buttons.append([Button.inline(f"🎬 {i}. Download (Best)", f"mv_dl:{search_id}:{global_idx}:best".encode())])

    # Navigation buttons
    nav_row = []
    if page > 0:
        nav_row.append(Button.inline("⬅️ Prev", f"mv_page:{search_id}:{page - 1}".encode()))
    if end_idx < total:
        nav_row.append(Button.inline("Next ➡️", f"mv_page:{search_id}:{page + 1}".encode()))
    if nav_row:
        buttons.append(nav_row)

    buttons.append([Button.inline("❌ Close", f"mv_close:{search_id}".encode())])
    await message.edit("\n".join(lines), buttons=buttons)

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

    search_id = f"ad_{int(time.time() * 1000) % 1000000}"
    search_cache[search_id] = {
        "type": "adult",
        "query": query,
        "results": results,
        "page": 0
    }

    await render_adult_page(event, status_msg, search_id, page=0)

async def render_adult_page(event, message, search_id: str, page: int):
    data = search_cache.get(search_id)
    if not data:
        await message.edit("⚠️ Adult search session expired. Please search again.")
        return

    results = data["results"]
    total = len(results)
    start_idx = page * ADULT_PAGE_SIZE
    end_idx = min(start_idx + ADULT_PAGE_SIZE, total)
    current_items = results[start_idx:end_idx]

    total_pages = (total + ADULT_PAGE_SIZE - 1) // ADULT_PAGE_SIZE
    lines = [f"🔞 **Adult Hub Search:** `{data['query']}` (Page {page + 1}/{total_pages})\n"]
    buttons = []

    for i, item in enumerate(current_items, start=1):
        global_idx = start_idx + i - 1
        raw_title = (item.get("title") or item.get("code") or "Adult Video").strip()
        is_jav = item.get("type") == "jav" or item.get("provider") == "sukebei"

        if is_jav:
            code = item.get("code", "")
            code_prefix = f"**[{code}]** " if code else ""
            size = item.get("size", "")
            seeds = item.get("seeders", 0)
            disp_title = raw_title[:50] + ("..." if len(raw_title) > 50 else "")
            lines.append(f"**{i}.** {code_prefix}{disp_title}\n   💾 `{size}` | 🟢 `{seeds}` seeds")
            btn_label = f"🔞 {i}. JAV" + (f" [{size}]" if size else "")
            buttons.append([Button.inline(btn_label, f"ad_dl:{search_id}:{global_idx}".encode())])
        else:
            duration = item.get("duration", "")
            quality = item.get("quality", "HD")
            provider = (item.get("provider") or "").upper()
            disp_title = raw_title[:55] + ("..." if len(raw_title) > 55 else "")
            dur_str = f"⏱ `{duration}` | " if duration else ""
            lines.append(f"**{i}.** {disp_title}\n   {dur_str}📺 `{quality}` ({provider})")
            buttons.append([Button.inline(f"🔞 {i}. Video [{quality}]", f"ad_dl:{search_id}:{global_idx}".encode())])

    # Navigation buttons
    nav_row = []
    if page > 0:
        nav_row.append(Button.inline("⬅️ Prev", f"ad_page:{search_id}:{page - 1}".encode()))
    if end_idx < total:
        nav_row.append(Button.inline("Next ➡️", f"ad_page:{search_id}:{page + 1}".encode()))
    if nav_row:
        buttons.append(nav_row)

    buttons.append([Button.inline("❌ Close", f"ad_close:{search_id}".encode())])
    await message.edit("\n".join(lines), buttons=buttons)

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
    elif data == "menu_checker":
        await event.answer()
        await event.reply(
            "🔬 **FLAC Authenticity & Spectral Analyzer**\n\n"
            "To verify if a song is genuine Studio Lossless or a fake/upscaled transcode:\n\n"
            "1. **Reply** to any audio or music file in this chat with `/checkflac`.\n"
            "2. Or **upload/forward** a `.flac`, `.wav`, or `.m4a` file directly into this chat.\n\n"
            "The analyzer performs full multi-band FFT energy analysis, Nyquist cutoff frequency detection, and spectrogram generation."
        )
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
        return

    # Movies pagination
    if data.startswith("mv_page:"):
        _, search_id, page_str = data.split(":")
        await event.answer()
        await render_movies_page(event, await event.get_message(), search_id, int(page_str))
        return

    # Movies close
    if data.startswith("mv_close:"):
        _, search_id = data.split(":")
        search_cache.pop(search_id, None)
        await event.delete()
        return

    # Movies download: mv_dl:{search_id}:{global_idx}:{rel_idx}
    if data.startswith("mv_dl:"):
        parts = data.split(":")
        if len(parts) >= 4:
            search_id, idx_str, rel_str = parts[1], parts[2], parts[3]
            cached = search_cache.get(search_id)
            if not cached:
                await event.answer("Movie search session expired", alert=True)
                return

            idx = int(idx_str)
            movie = cached["results"][idx]
            movie_title = movie.get("pureTitle") or movie.get("title") or "Movie"
            releases = movie.get("releases") or []

            selected_release = None
            q_label = "Best"
            if rel_str != "best" and releases:
                rel_idx = int(rel_str)
                if rel_idx < len(releases):
                    selected_release = releases[rel_idx]
                    q_label = selected_release.get("quality") or "1080p"

            await event.answer(f"Queuing movie: {movie_title}...")
            status_msg = await event.reply(f"⏳ **Initializing movie download:**\n🎬 **{movie_title}** (`{q_label}`)...")

            res = await backend_client.download_movie(movie, selected_release)
            if not res or not res.get("success"):
                err = res.get("error") if res else "Unknown backend error"
                await status_msg.edit(f"❌ **Failed to start movie download:**\n`{err}`")
                return

            job_id = res.get("jobId")
            asyncio.create_task(
                track_job_and_deliver(
                    client=event.client,
                    chat_id=event.chat_id,
                    job_id=job_id,
                    title=res.get("title") or movie_title,
                    status_msg=status_msg
                )
            )
            return

    # Adult pagination
    if data.startswith("ad_page:"):
        _, search_id, page_str = data.split(":")
        await event.answer()
        await render_adult_page(event, await event.get_message(), search_id, int(page_str))
        return

    # Adult close
    if data.startswith("ad_close:"):
        _, search_id = data.split(":")
        search_cache.pop(search_id, None)
        await event.delete()
        return

    # Adult download: ad_dl:{search_id}:{global_idx}
    if data.startswith("ad_dl:"):
        parts = data.split(":")
        if len(parts) >= 3:
            search_id, idx_str = parts[1], parts[2]
            cached = search_cache.get(search_id)
            if not cached:
                await event.answer("Adult search session expired", alert=True)
                return

            idx = int(idx_str)
            item = cached["results"][idx]
            item_title = item.get("title") or item.get("code") or "Adult Media"

            await event.answer(f"Queuing adult media: {item_title[:30]}...")
            status_msg = await event.reply(f"⏳ **Initializing adult download:**\n🔞 **{item_title[:60]}**...")

            res = await backend_client.download_adult(item)
            if not res or not res.get("success"):
                err = res.get("error") if res else "Unknown backend error"
                await status_msg.edit(f"❌ **Failed to start adult download:**\n`{err}`")
                return

            job_id = res.get("jobId")
            asyncio.create_task(
                track_job_and_deliver(
                    client=event.client,
                    chat_id=event.chat_id,
                    job_id=job_id,
                    title=res.get("title") or item_title,
                    status_msg=status_msg
                )
            )
            return
