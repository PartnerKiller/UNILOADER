import os
import time
import asyncio
from pathlib import Path
from typing import Dict, Any, List, Optional

from telethon import events, Button
from telethon.tl.custom import Message

from config import is_user_authorized
from api_client import backend_client
from handlers.common import auth_required
from handlers.links import track_job_and_deliver

# In-memory store for active searches: {search_id: {"type": str, "query": str, "results": list, "page": int}}
search_cache: Dict[str, Dict[str, Any]] = {}

# Pending user search modes: {sender_id: {"mode": "music"|"movies"|"adult", "time": float}}
user_search_mode: Dict[int, Dict[str, Any]] = {}

# Quick search prompts: {qid: query_text}
quick_search_cache: Dict[str, str] = {}

TEMP_PREVIEW_DIR = Path("/tmp/tele_bot_previews")
TEMP_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

PAGE_SIZE = 5
MOVIE_PAGE_SIZE = 3
ADULT_PAGE_SIZE = 5

# --- Search Execution Core Helpers ---

async def execute_music_search(event, query: str):
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

async def execute_movies_search(event, query: str):
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

async def execute_adult_search(event, query: str):
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

# --- Commands ---

@auth_required
async def music_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        user_search_mode[event.sender_id] = {"mode": "music", "time": time.time()}
        await event.reply(
            "🎵 **Hi-Res Music Search**\n\n"
            "Please send the song or artist you want to find:\n"
            "• You can simply type the name directly (e.g. `Coldplay Yellow`)\n"
            "• Or use `/music Coldplay Yellow`\n\n"
            "💬 *Waiting for your search...*"
        )
        return

    query = parts[1].strip()
    await execute_music_search(event, query)

@auth_required
async def movies_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        user_search_mode[event.sender_id] = {"mode": "movies", "time": time.time()}
        await event.reply(
            "🎬 **Movies & Series Search**\n\n"
            "Please send the movie or series title you want to find:\n"
            "• You can simply type the title directly (e.g. `Inception`)\n"
            "• Or use `/movies Inception`\n\n"
            "💬 *Waiting for your search...*"
        )
        return

    query = parts[1].strip()
    await execute_movies_search(event, query)

@auth_required
async def adult_search_command(event: events.NewMessage.Event):
    text = event.raw_text.strip()
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        user_search_mode[event.sender_id] = {"mode": "adult", "time": time.time()}
        await event.reply(
            "🔞 **Adult & JAV Hub Search**\n\n"
            "Please send the title or JAV code you want to find:\n"
            "• You can simply type the query directly (e.g. `SONE-261`)\n"
            "• Or use `/adult SONE-261`\n\n"
            "💬 *Waiting for your search...*"
        )
        return

    query = parts[1].strip()
    await execute_adult_search(event, query)

# --- Direct Plain-Text Search & Quick Hub Handler ---

@auth_required
async def plain_text_query_handler(event: events.NewMessage.Event):
    text = (event.raw_text or "").strip()
    if not text or text.startswith("/"):
        return
    if "http://" in text or "https://" in text:
        return
    if event.audio or event.document:
        return
    if len(text) < 2:
        return

    sender_id = event.sender_id
    pending = user_search_mode.get(sender_id)

    # 1. User previously triggered /music, /movies, or /adult
    if pending and (time.time() - pending.get("time", 0) < 300):
        mode = pending.get("mode")
        user_search_mode.pop(sender_id, None)
        if mode == "music":
            await execute_music_search(event, text)
            return
        elif mode == "movies":
            await execute_movies_search(event, text)
            return
        elif mode == "adult":
            await execute_adult_search(event, text)
            return

    # 2. General plain text query without preceding command -> Quick Search Hub
    qid = f"q_{int(time.time() * 1000) % 1000000}"
    quick_search_cache[qid] = text

    buttons = [
        [
            Button.inline("🎵 Search Music", f"q_m:{qid}".encode()),
            Button.inline("🎬 Search Movies", f"q_mv:{qid}".encode()),
        ],
        [
            Button.inline("🔞 Search Adult", f"q_ad:{qid}".encode()),
            Button.inline("❌ Cancel", f"q_cancel:{qid}".encode())
        ]
    ]

    await event.reply(
        f"🔍 **What would you like to search for:** `{text}`?\n\n"
        f"Tap an option below, or use `/music {text}`, `/movies {text}`, or `/adult {text}`:",
        buttons=buttons
    )

# --- Render Pages ---

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

    total_pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    lines = [f"🎵 **Hi-Res Music Search:** `{data['query']}` (Page {page + 1}/{total_pages})\n"]
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
            Button.inline(f"🎧 {i}. MP3", f"m_dl:{search_id}:{global_idx}:mp3".encode()),
            Button.inline(f"👁 {i}. Preview", f"m_pv:{search_id}:{global_idx}".encode())
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

        # Quality release buttons
        if releases:
            rel_buttons = []
            for r_idx, rel in enumerate(releases[:3]):
                q = rel.get("quality") or "1080p"
                sz = rel.get("size") or ""
                label = f"🎬 {i}. {q}" + (f" [{sz}]" if sz else "")
                rel_buttons.append(Button.inline(label, f"mv_dl:{search_id}:{global_idx}:{r_idx}".encode()))

            if len(rel_buttons) <= 2:
                buttons.append(rel_buttons)
            else:
                buttons.append(rel_buttons[:2])
                buttons.append(rel_buttons[2:])
        else:
            buttons.append([Button.inline(f"🎬 {i}. Download (Best)", f"mv_dl:{search_id}:{global_idx}:best".encode())])

        # Preview Poster & Details button
        buttons.append([Button.inline(f"👁 {i}. Preview Poster & Details", f"mv_pv:{search_id}:{global_idx}".encode())])

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
            disp_title = raw_title[:45] + ("..." if len(raw_title) > 45 else "")
            lines.append(f"**{i}.** {code_prefix}{disp_title}\n   💾 `{size}` | 🟢 `{seeds}` seeds")
            btn_label = f"🔞 {i}. JAV" + (f" [{size}]" if size else "")
            buttons.append([
                Button.inline(btn_label, f"ad_dl:{search_id}:{global_idx}".encode()),
                Button.inline(f"👁 {i}. Preview", f"ad_pv:{search_id}:{global_idx}".encode())
            ])
        else:
            duration = item.get("duration", "")
            quality = item.get("quality", "HD")
            provider = (item.get("provider") or "").upper()
            disp_title = raw_title[:50] + ("..." if len(raw_title) > 50 else "")
            dur_str = f"⏱ `{duration}` | " if duration else ""
            lines.append(f"**{i}.** {disp_title}\n   {dur_str}📺 `{quality}` ({provider})")
            buttons.append([
                Button.inline(f"🔞 {i}. Video [{quality}]", f"ad_dl:{search_id}:{global_idx}".encode()),
                Button.inline(f"👁 {i}. Preview", f"ad_pv:{search_id}:{global_idx}".encode())
            ])

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

# --- Rich Preview Card Renderers ---

async def render_music_preview(event, search_id: str, idx: int):
    cached = search_cache.get(search_id)
    if not cached or idx >= len(cached["results"]):
        await event.answer("Music preview session expired", alert=True)
        return

    item = cached["results"][idx]
    title = item.get("title", "Track")
    artist = item.get("artist", "Artist")
    album = item.get("album", "")
    duration = item.get("durationStr", "")
    year = item.get("year", "")
    genre = item.get("genre", "")
    cover_url = item.get("cover") or item.get("image") or ""
    preview_audio = item.get("previewUrl") or ""

    lines = [
        f"🎵 **Track Preview & Artwork**\n",
        f"📌 **Title:** {title}",
        f"👤 **Artist:** {artist}",
    ]
    if album:
        yr_str = f" ({year})" if year else ""
        lines.append(f"💿 **Album:** {album}{yr_str}")
    if duration:
        lines.append(f"⏱ **Duration:** `{duration}`")
    if genre:
        lines.append(f"🎸 **Genre:** {genre}")
    lines.append(f"🎚 **Fidelity:** Genuine 24-bit Hi-Res Studio FLAC / 320k MP3")

    buttons = [
        [
            Button.inline("🎵 Download FLAC (Lossless)", f"m_dl:{search_id}:{idx}:flac".encode()),
            Button.inline("🎧 Download MP3 (320k)", f"m_dl:{search_id}:{idx}:mp3".encode())
        ]
    ]
    if preview_audio:
        buttons.append([Button.url("▶️ Listen 30s Audio Sample", preview_audio)])

    current_page = idx // PAGE_SIZE
    buttons.append([Button.inline("⬅️ Back to Search Results", f"m_page:{search_id}:{current_page}".encode())])

    caption = "\n".join(lines)
    await event.answer("Loading track artwork...")

    img_data = await backend_client.fetch_preview_image(cover_url) if cover_url else None
    if img_data:
        tmp_img = TEMP_PREVIEW_DIR / f"cov_{int(time.time()*1000)}.jpg"
        with open(tmp_img, "wb") as f_out:
            f_out.write(img_data)
        try:
            await event.client.send_file(
                entity=event.chat_id,
                file=str(tmp_img),
                caption=caption,
                buttons=buttons
            )
        except Exception as e:
            print(f"[Preview] Music send_file error: {e}")
            await event.reply(caption, buttons=buttons)
        finally:
            if tmp_img.exists():
                try: os.remove(tmp_img)
                except Exception: pass
    else:
        await event.reply(caption, buttons=buttons)

async def render_movie_preview(event, search_id: str, idx: int):
    cached = search_cache.get(search_id)
    if not cached or idx >= len(cached["results"]):
        await event.answer("Movie preview session expired", alert=True)
        return

    movie = cached["results"][idx]
    title = movie.get("pureTitle") or movie.get("title") or "Movie"
    year = movie.get("year", "")
    rating = movie.get("rating", "")
    genres = movie.get("genres", [])
    genres_str = ", ".join(genres) if isinstance(genres, list) else str(genres)
    summary = movie.get("summary", "")
    poster_url = movie.get("poster", "")
    releases = movie.get("releases", [])

    lines = [
        f"🎬 **Movie Preview & Details**\n",
        f"🍿 **{title}**" + (f" ({year})" if year else ""),
    ]
    if rating:
        lines.append(f"⭐ **IMDb / TMDB Rating:** `{rating}` / 10")
    if genres_str:
        lines.append(f"🎭 **Genres:** {genres_str}")
    if summary:
        short_summary = summary[:420] + ("..." if len(summary) > 420 else "")
        lines.append(f"\n📝 **Plot Synopsis:**\n_{short_summary}_")

    buttons = []
    if releases:
        rel_buttons = []
        for r_idx, rel in enumerate(releases[:4]):
            q = rel.get("quality") or "1080p"
            sz = rel.get("size") or ""
            label = f"🎬 Download {q}" + (f" [{sz}]" if sz else "")
            rel_buttons.append(Button.inline(label, f"mv_dl:{search_id}:{idx}:{r_idx}".encode()))
        for b in rel_buttons:
            buttons.append([b])
    else:
        buttons.append([Button.inline("🎬 Download Best Quality", f"mv_dl:{search_id}:{idx}:best".encode())])

    current_page = idx // MOVIE_PAGE_SIZE
    buttons.append([Button.inline("⬅️ Back to Movie Results", f"mv_page:{search_id}:{current_page}".encode())])

    caption = "\n".join(lines)
    await event.answer("Loading movie poster...")

    img_data = await backend_client.fetch_preview_image(poster_url) if poster_url else None
    if img_data:
        tmp_img = TEMP_PREVIEW_DIR / f"pos_{int(time.time()*1000)}.jpg"
        with open(tmp_img, "wb") as f_out:
            f_out.write(img_data)
        try:
            await event.client.send_file(
                entity=event.chat_id,
                file=str(tmp_img),
                caption=caption,
                buttons=buttons
            )
        except Exception as e:
            print(f"[Preview] Movie send_file error: {e}")
            await event.reply(caption, buttons=buttons)
        finally:
            if tmp_img.exists():
                try: os.remove(tmp_img)
                except Exception: pass
    else:
        await event.reply(caption, buttons=buttons)

async def render_adult_preview(event, search_id: str, idx: int):
    cached = search_cache.get(search_id)
    if not cached or idx >= len(cached["results"]):
        await event.answer("Adult preview session expired", alert=True)
        return

    item = cached["results"][idx]
    raw_title = item.get("title") or item.get("code") or "Adult Media"
    code = item.get("code", "")
    duration = item.get("duration", "")
    quality = item.get("quality", "HD")
    provider = (item.get("provider") or "").upper()
    size = item.get("size", "")
    seeds = item.get("seeders", 0)
    thumb_url = item.get("rawThumb") or item.get("thumb") or ""
    preview_video = item.get("previewVideo") or ""
    is_jav = item.get("type") == "jav" or item.get("provider") == "sukebei"

    lines = [
        f"🔞 **Adult Media Preview**\n",
        f"🎬 **Title:** {raw_title[:80]}",
    ]
    if code:
        lines.append(f"🏷 **Code:** `{code}`")
    if duration:
        lines.append(f"⏱ **Duration:** `{duration}`")
    lines.append(f"📺 **Format:** `{quality}` ({provider})")
    if size:
        lines.append(f"💾 **File Size:** `{size}`" + (f" | 🟢 `{seeds}` seeds" if seeds else ""))

    buttons = [
        [Button.inline(f"📥 Download {'JAV' if is_jav else 'Video'}" + (f" [{size}]" if size else ""), f"ad_dl:{search_id}:{idx}".encode())]
    ]
    if preview_video:
        buttons.append([Button.url("▶️ Watch Video Clip Preview", preview_video)])

    current_page = idx // ADULT_PAGE_SIZE
    buttons.append([Button.inline("⬅️ Back to Adult Results", f"ad_page:{search_id}:{current_page}".encode())])

    caption = "\n".join(lines)
    await event.answer("Loading preview thumbnail...")

    img_data = await backend_client.fetch_preview_image(thumb_url) if thumb_url else None
    if img_data:
        tmp_img = TEMP_PREVIEW_DIR / f"adt_{int(time.time()*1000)}.jpg"
        with open(tmp_img, "wb") as f_out:
            f_out.write(img_data)
        try:
            await event.client.send_file(
                entity=event.chat_id,
                file=str(tmp_img),
                caption=caption,
                buttons=buttons
            )
        except Exception as e:
            print(f"[Preview] Adult send_file error: {e}")
            await event.reply(caption, buttons=buttons)
        finally:
            if tmp_img.exists():
                try: os.remove(tmp_img)
                except Exception: pass
    else:
        await event.reply(caption, buttons=buttons)

# --- Master Callback Query Handler ---

async def search_callback_handler(event: events.CallbackQuery.Event):
    sender_id = event.sender_id
    if not is_user_authorized(sender_id):
        await event.answer("Access Denied", alert=True)
        return

    data = event.data.decode('utf-8')

    # Menu shortcuts from /start
    if data == "menu_music":
        await event.answer()
        user_search_mode[sender_id] = {"mode": "music", "time": time.time()}
        await event.reply(
            "🎵 **Hi-Res Music Search**\n\n"
            "Please send the song or artist you want to find:\n"
            "• You can simply type the name directly (e.g. `Coldplay Yellow`)\n"
            "• Or use `/music Coldplay Yellow`\n\n"
            "💬 *Waiting for your search...*"
        )
        return
    elif data == "menu_movies":
        await event.answer()
        user_search_mode[sender_id] = {"mode": "movies", "time": time.time()}
        await event.reply(
            "🎬 **Movies & Series Search**\n\n"
            "Please send the movie or series title you want to find:\n"
            "• You can simply type the title directly (e.g. `Inception`)\n"
            "• Or use `/movies Inception`\n\n"
            "💬 *Waiting for your search...*"
        )
        return
    elif data == "menu_adult":
        await event.answer()
        user_search_mode[sender_id] = {"mode": "adult", "time": time.time()}
        await event.reply(
            "🔞 **Adult & JAV Hub Search**\n\n"
            "Please send the title or JAV code you want to find:\n"
            "• You can simply type the query directly (e.g. `SONE-261`)\n"
            "• Or use `/adult SONE-261`\n\n"
            "💬 *Waiting for your search...*"
        )
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

    # Quick search prompt callbacks
    if data.startswith("q_m:"):
        qid = data.split(":", 1)[1]
        query = quick_search_cache.pop(qid, None)
        await event.answer()
        if query:
            await execute_music_search(event, query)
        return
    elif data.startswith("q_mv:"):
        qid = data.split(":", 1)[1]
        query = quick_search_cache.pop(qid, None)
        await event.answer()
        if query:
            await execute_movies_search(event, query)
        return
    elif data.startswith("q_ad:"):
        qid = data.split(":", 1)[1]
        query = quick_search_cache.pop(qid, None)
        await event.answer()
        if query:
            await execute_adult_search(event, query)
        return
    elif data.startswith("q_cancel:"):
        qid = data.split(":", 1)[1]
        quick_search_cache.pop(qid, None)
        await event.answer("Cancelled")
        await event.delete()
        return

    # Music Preview
    if data.startswith("m_pv:"):
        _, search_id, idx_str = data.split(":")
        await render_music_preview(event, search_id, int(idx_str))
        return

    # Movie Preview
    if data.startswith("mv_pv:"):
        _, search_id, idx_str = data.split(":")
        await render_movie_preview(event, search_id, int(idx_str))
        return

    # Adult Preview
    if data.startswith("ad_pv:"):
        _, search_id, idx_str = data.split(":")
        await render_adult_preview(event, search_id, int(idx_str))
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
