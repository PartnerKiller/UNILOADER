import os
import time
import base64
import asyncio
from pathlib import Path
from typing import Dict, Any, Optional

from telethon import events, Button
from telethon.tl.custom import Message

from config import is_user_authorized, is_user_owner
from api_client import backend_client
from handlers.common import owner_required

# In-memory storage for pending AI interaction modes: {sender_id: {"mode": str, "time": float}}
ai_pending_modes: Dict[int, Dict[str, Any]] = {}

TEMP_AI_DIR = Path("/tmp/tele_bot_ai")
TEMP_AI_DIR.mkdir(parents=True, exist_ok=True)

# --- AI Commands ---

@owner_required
async def ai_hub_command(event: events.NewMessage.Event):
    """
    Handles /ai and /copilot commands.
    If followed by a prompt, executes natural language copilot resolution.
    If alone, displays the interactive AI Control Hub.
    """
    text = (event.raw_text or "").strip()
    parts = text.split(maxsplit=1)

    if len(parts) >= 2:
        prompt = parts[1].strip()
        await execute_copilot(event, prompt)
        return

    # No arguments provided -> Render AI Hub Menu
    await render_ai_hub_menu(event)

@owner_required
async def clean_filename_command(event: events.NewMessage.Event):
    """
    Handles /clean and /cleanfilename commands.
    """
    text = (event.raw_text or "").strip()
    parts = text.split(maxsplit=1)

    if len(parts) >= 2:
        filename = parts[1].strip()
        await execute_clean_filename(event, filename)
        return

    # Check reply message
    reply_to = await event.get_reply_message() if hasattr(event, "get_reply_message") else None
    if reply_to and reply_to.file and reply_to.file.name:
        await execute_clean_filename(event, reply_to.file.name)
        return
    elif reply_to and reply_to.text:
        await execute_clean_filename(event, reply_to.text.strip())
        return

    ai_pending_modes[event.sender_id] = {"mode": "clean", "time": time.time()}
    await event.reply(
        "🏷 **AI Release Metadata Cleaner**\n\n"
        "Please send the messy release or torrent filename to parse:\n"
        "• Example: `Oshi.no.Ko.S02E01.1080p.HEVC.AAC-Group.mkv`\n"
        "• Or reply to any media document with `/clean`\n\n"
        "💬 *Waiting for your filename...*"
    )

@owner_required
async def jav_translate_command(event: events.NewMessage.Event):
    """
    Handles /translate and /javtrans commands.
    """
    text = (event.raw_text or "").strip()
    parts = text.split(maxsplit=1)

    if len(parts) >= 2:
        title = parts[1].strip()
        await execute_jav_translate(event, title)
        return

    reply_to = await event.get_reply_message() if hasattr(event, "get_reply_message") else None
    if reply_to and reply_to.text:
        await execute_jav_translate(event, reply_to.text.strip())
        return

    ai_pending_modes[event.sender_id] = {"mode": "translate", "time": time.time()}
    await event.reply(
        "🌐 **AI Japanese Title & Synopsis Translator**\n\n"
        "Please send the raw Japanese or Asian media title to translate and cleanse:\n"
        "• Example: `【ハイレゾ】SSIS-888 新人NO.1STYLE 三上悠亜 完全限定版`\n\n"
        "💬 *Waiting for your title...*"
    )

# --- Core AI Executors ---

async def execute_copilot(event, prompt: str):
    """
    Resolves natural language queries using Google Gemini via backend AI Copilot.
    """
    status_msg = await event.reply("🧠 **Consulting Gemini AI Copilot...**")
    try:
        res = await backend_client.ai_copilot(prompt)
        if res.get("success") and res.get("intent"):
            intent = res["intent"]
            category = intent.get("intent") or "general_search"
            query = intent.get("query") or prompt
            quality = intent.get("quality") or "best"
            explanation = intent.get("explanation") or ""
            model_used = res.get("modelUsed", "gemini-flash")

            if category == "music":
                is_lossless = intent.get("isLosslessAudio", True)
                badge = "24-bit Hi-Res FLAC" if is_lossless else quality
                await status_msg.edit(
                    f"🤖 **AI Copilot Resolution** `({model_used})`\n\n"
                    f"🎯 **Target:** Music Lossless Audio\n"
                    f"🎵 **Query:** `{query}`\n"
                    f"🎚 **Desired Quality:** `{badge}`\n"
                    f"💡 _{explanation}_\n\n"
                    f"🔍 *Searching Hi-Res music catalog now...*"
                )
                from handlers.search import execute_music_search
                await execute_music_search(event, query)
                return

            elif category == "movies":
                await status_msg.edit(
                    f"🤖 **AI Copilot Resolution** `({model_used})`\n\n"
                    f"🎯 **Target:** Movies & TV Series\n"
                    f"🎬 **Query:** `{query}`\n"
                    f"📺 **Quality Target:** `{quality}`\n"
                    f"💡 _{explanation}_\n\n"
                    f"🔍 *Searching Cinema & TV series index now...*"
                )
                from handlers.search import execute_movies_search
                await execute_movies_search(event, query)
                return

            elif category == "adult_jav":
                search_q = intent.get("javCode") or query
                actress = intent.get("javActress")
                actress_str = f" • Actress: `{actress}`" if actress else ""
                await status_msg.edit(
                    f"🤖 **AI Copilot Resolution** `({model_used})`\n\n"
                    f"🎯 **Target:** Adult & JAV Hub\n"
                    f"🔞 **Query:** `{search_q}`{actress_str}\n"
                    f"💡 _{explanation}_\n\n"
                    f"🔍 *Searching Adult Hub catalog now...*"
                )
                from handlers.search import execute_adult_search
                await execute_adult_search(event, search_q)
                return

            elif category == "direct_url":
                direct_url = intent.get("directUrl") or query
                await status_msg.edit(
                    f"🤖 **AI Copilot Resolution** `({model_used})`\n\n"
                    f"📥 **Direct Media URL Detected:**\n`{direct_url}`\n\n"
                    f"💡 _{explanation}_"
                )
                from handlers.links import link_message_handler
                # Trigger link handler with simulated event
                event.raw_text = direct_url
                await link_message_handler(event)
                return

            else:
                # Conversational or general media inquiry
                chat_res = await backend_client.ai_chat(prompt)
                if chat_res.get("success") and chat_res.get("reply"):
                    reply_text = chat_res["reply"]
                    header = f"🤖 **Gemini AI Copilot** `({chat_res.get('modelUsed', model_used)})`:\n\n"
                    full_reply = header + reply_text
                    if len(full_reply) > 4000:
                        full_reply = full_reply[:3950] + "\n\n*(Truncated)*"
                    await status_msg.edit(full_reply)
                    return
                else:
                    buttons = [
                        [
                            Button.inline("🎵 Search Music", f"q_m_dir:{query}".encode()),
                            Button.inline("🎬 Search Movies", f"q_mv_dir:{query}".encode())
                        ],
                        [
                            Button.inline("🔞 Search Adult", f"q_ad_dir:{query}".encode()),
                            Button.inline("❌ Dismiss", b"ai_btn:close")
                        ]
                    ]
                    await status_msg.edit(
                        f"🤖 **AI Copilot Result** `({model_used})`:\n\n"
                        f"🔍 **Extracted Query:** `{query}`\n"
                        f"💡 _{explanation}_\n\n"
                        f"Please select where to search:",
                        buttons=buttons
                    )
                    return

        # If copilot intent wasn't structured, call conversational AI chat
        chat_res = await backend_client.ai_chat(prompt)
        if chat_res.get("success") and chat_res.get("reply"):
            reply_text = chat_res["reply"]
            header = f"🤖 **Gemini AI Assistant** `({chat_res.get('modelUsed', 'gemini')})`:\n\n"
            full_reply = header + reply_text
            if len(full_reply) > 4000:
                full_reply = full_reply[:3950] + "\n\n*(Truncated)*"
            await status_msg.edit(full_reply)
        else:
            err = res.get("error") or chat_res.get("error") or "Unknown AI error"
            await status_msg.edit(f"❌ **AI Processing Failed:** `{err}`")

    except Exception as e:
        await status_msg.edit(f"❌ **Error running AI Copilot:** `{e}`")

async def execute_clean_filename(event, filename: str):
    status_msg = await event.reply(f"🏷 **Parsing metadata for:** `{filename[:60]}...`")
    try:
        res = await backend_client.ai_clean_filename(filename)
        if not res.get("success") or not res.get("parsed"):
            err = res.get("error", "Failed to parse filename")
            await status_msg.edit(f"❌ **Filename Parsing Failed:** `{err}`")
            return

        p = res["parsed"]
        model = res.get("modelUsed", "gemini")
        lines = [
            f"🏷 **AI Release Metadata Cleaner** `({model})`\n",
            f"📁 **Original:** `{filename}`\n",
            f"🎬 **Standard Title:** **{p.get('cleanTitle', 'Unknown')}**",
            f"📂 **Media Type:** `{(p.get('mediaType') or 'general').upper()}`"
        ]

        if p.get("year"):
            lines.append(f"📅 **Year:** `{p.get('year')}`")
        if p.get("season") is not None:
            s_str = f"S{int(p.get('season')):02d}"
            ep_str = f"E{int(p.get('episode')):02d}" if p.get('episode') is not None else ""
            lines.append(f"📺 **Episode:** `{s_str}{ep_str}`")
        if p.get("resolution"):
            lines.append(f"🖥 **Resolution:** `{p.get('resolution')}`")
        if p.get("videoCodec") or p.get("audioCodec"):
            lines.append(f"🎞 **Codecs:** `{p.get('videoCodec') or '--'} / {p.get('audioCodec') or '--'}`")
        if p.get("releaseGroup"):
            lines.append(f"👥 **Release Group:** `{p.get('releaseGroup')}`")
        if p.get("suggestedLibraryPath"):
            lines.append(f"\n📁 **Recommended Standard Path:**\n`{p.get('suggestedLibraryPath')}`")

        await status_msg.edit("\n".join(lines))
    except Exception as e:
        await status_msg.edit(f"❌ **Error parsing filename:** `{e}`")

async def execute_jav_translate(event, title: str):
    status_msg = await event.reply("🌐 **Translating and cleaning Japanese title with Gemini...**")
    try:
        res = await backend_client.ai_jav_translate(title)
        if not res.get("success") or not res.get("translated"):
            err = res.get("error", "Failed to translate title")
            await status_msg.edit(f"❌ **Translation Failed:** `{err}`")
            return

        t = res["translated"]
        model = res.get("modelUsed", "gemini")
        code = t.get("code")
        clean_title = t.get("cleanTitle") or title
        actresses = t.get("actresses") or []
        actress_str = ", ".join(actresses) if actresses else "Unknown"
        synopsis = t.get("englishSynopsis") or ""
        genres = t.get("genres") or []
        genre_str = ", ".join(genres) if genres else ""

        lines = [
            f"🌐 **AI JAV Title & Metadata Cleanser** `({model})`\n",
            f"🇯🇵 **Raw Title:** _{title}_\n",
            f"✨ **Clean English Title:** **{clean_title}**\n",
            f"🏷 **Detected Code:** `{code or 'None'}`",
            f"💃 **Actresses:** `{actress_str}`"
        ]

        if genre_str:
            lines.append(f"🎭 **Genres:** `{genre_str}`")
        if synopsis:
            lines.append(f"\n📖 **English Synopsis:**\n_{synopsis}_")

        buttons = []
        if code:
            buttons.append([Button.inline(f"🔞 Search '{code}' in Adult Hub", f"q_ad_dir:{code}".encode())])
        elif actresses:
            buttons.append([Button.inline(f"🔞 Search '{actresses[0]}'", f"q_ad_dir:{actresses[0]}".encode())])
        buttons.append([Button.inline("❌ Dismiss", b"ai_btn:close")])

        await status_msg.edit("\n".join(lines), buttons=buttons)
    except Exception as e:
        await status_msg.edit(f"❌ **Error translating title:** `{e}`")

# --- UI & Menus ---

async def render_ai_hub_menu(event, edit_msg=None):
    sender = await event.get_sender()
    name = getattr(sender, 'first_name', 'Owner') or 'Owner'
    status_data = await backend_client.ai_status()
    model_name = status_data.get("activeModel", "gemini-flash-lite-latest") if status_data.get("success") else "Offline / Checking"

    text = (
        f"🤖 **Universal Downloader AI Copilot Hub**\n\n"
        f"👑 **Owner Mode Active** (Hello, {name}!)\n"
        f"⚡ **Provider:** Google Gemini Generative AI\n"
        f"🧠 **Active Neural Model:** `{model_name}`\n\n"
        f"**Available AI Capabilities:**\n"
        f"• **Natural Language Copilot** — Send any plain-English search/download prompt.\n"
        f"• **Spectrogram Audit** — Deep lossy transcode analysis attached to `/checkflac`.\n"
        f"• **Visual Recognition** — Send photo or cover art to identify actresses & codes.\n"
        f"• **Release Filename Cleaner** — Parse scene/torrent release naming tags.\n"
        f"• **Title & JAV Translator** — Clean clickbait Japanese prefixes & translate.\n\n"
        f"Select a quick AI mode below, or type `/ai <prompt>` directly:"
    )

    buttons = [
        [
            Button.inline("🧠 Ask Copilot", b"ai_mode:copilot"),
            Button.inline("🏷 Clean Filename", b"ai_mode:clean")
        ],
        [
            Button.inline("🌐 Translate JAV", b"ai_mode:translate"),
            Button.inline("⚡ Engine Status", b"ai_btn:status")
        ],
        [
            Button.inline("❌ Close", b"ai_btn:close")
        ]
    ]

    if edit_msg:
        await edit_msg.edit(text, buttons=buttons)
    else:
        await event.reply(text, buttons=buttons)

# --- Media Image Handler for Owner ---

async def ai_image_message_handler(event: events.NewMessage.Event):
    """
    Detects when the owner uploads a photo or image screenshot.
    Offers a 1-tap button to run Gemini multimodal visual recognition.
    """
    sender_id = event.sender_id
    if not is_user_owner(sender_id):
        return

    message = event.message
    is_photo = bool(message.photo)
    is_img_doc = False
    if message.file and message.file.name:
        is_img_doc = message.file.name.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp'))

    if not (is_photo or is_img_doc):
        return

    # If caption contains /ai or /recognize, process immediately
    caption = (message.text or "").strip().lower()
    if any(cmd in caption for cmd in ["/ai", "/recognize", "/jav", "/identify"]):
        status_msg = await event.reply("🖼 **Downloading image for Gemini visual recognition...**")
        await process_image_recognition(event.client, event.chat_id, message, status_msg)
        return

    buttons = [
        [
            Button.inline("🤖 Identify Actress / Code (Gemini AI)", f"ai_img:{message.id}".encode()),
            Button.inline("❌ Ignore", b"ai_btn:close")
        ]
    ]
    await event.reply(
        "🖼 **Image Received:**\n"
        "Would you like Gemini AI to identify the actress, studio, or video code from this screenshot/poster?",
        buttons=buttons
    )

async def process_image_recognition(client, chat_id: int, message: Message, status_msg):
    tmp_path = TEMP_AI_DIR / f"recog_{int(time.time())}_{message.id}.jpg"
    try:
        await message.download_media(file=str(tmp_path))
        if not tmp_path.exists() or tmp_path.stat().st_size == 0:
            await status_msg.edit("❌ Failed to download image for analysis.")
            return

        with open(tmp_path, "rb") as f_img:
            img_b64 = base64.b64decode if False else base64.b64encode(f_img.read()).decode('utf-8')

        context_text = message.text or ""
        await status_msg.edit("🧠 **Gemini Multimodal Vision analyzing frame & actress features...**")

        res = await backend_client.ai_jav_recognize(img_b64, context_text)
        if not res.get("success") or not res.get("recognition"):
            err = res.get("error", "Visual recognition failed")
            await status_msg.edit(f"❌ **Recognition Failed:** `{err}`")
            return

        r = res["recognition"]
        model = res.get("modelUsed", "gemini")
        code = r.get("detectedCode")
        actress = r.get("actressName")
        actress_kanji = r.get("actressKanji")
        maker = r.get("maker")
        confidence = r.get("confidence", "MEDIUM")
        clean_title = r.get("cleanEnglishTitle")
        theme_tags = r.get("themeTags") or []

        actress_full = actress or "Unknown"
        if actress_kanji:
            actress_full += f" ({actress_kanji})"

        lines = [
            f"🤖 **Gemini Multimodal Visual Recognition** `({model})`\n",
            f"💃 **Actress:** **{actress_full}**",
            f"🏷 **Detected Code:** `{code or 'Not clearly visible'}`",
            f"🏢 **Studio / Maker:** `{maker or 'Unknown'}`",
            f"🎯 **Confidence:** `{confidence}`"
        ]

        if clean_title:
            lines.append(f"✨ **Title Suggestion:** _{clean_title}_")
        if theme_tags:
            lines.append(f"🏷 **Themes:** `{' • '.join(theme_tags)}`")

        buttons = []
        search_target = code or actress
        if search_target:
            buttons.append([
                Button.inline(f"🔞 Search '{search_target}' in Adult", f"q_ad_dir:{search_target}".encode()),
                Button.inline(f"🎬 Search in Movies", f"q_mv_dir:{search_target}".encode())
            ])
        buttons.append([Button.inline("❌ Dismiss", b"ai_btn:close")])

        await status_msg.edit("\n".join(lines), buttons=buttons)

    except Exception as e:
        await status_msg.edit(f"❌ **Error during visual recognition:** `{e}`")
    finally:
        if tmp_path.exists():
            try: os.remove(tmp_path)
            except Exception: pass

# --- Callback Queries Handler ---

async def ai_callback_handler(event: events.CallbackQuery.Event):
    sender_id = event.sender_id
    if not is_user_owner(sender_id):
        await event.answer("🔒 AI tools are strictly reserved for the server owner.", alert=True)
        return

    data = event.data.decode('utf-8')

    # Menu AI from /start
    if data == "menu_ai":
        await event.answer()
        await render_ai_hub_menu(event, edit_msg=event)
        return

    # Direct Search buttons from AI results
    if data.startswith("q_m_dir:"):
        query = data.split(":", 1)[1]
        await event.answer()
        from handlers.search import execute_music_search
        await execute_music_search(event, query)
        return

    if data.startswith("q_mv_dir:"):
        query = data.split(":", 1)[1]
        await event.answer()
        from handlers.search import execute_movies_search
        await execute_movies_search(event, query)
        return

    if data.startswith("q_ad_dir:"):
        query = data.split(":", 1)[1]
        await event.answer()
        from handlers.search import execute_adult_search
        await execute_adult_search(event, query)
        return

    if data == "ai_btn:close":
        await event.answer()
        try:
            await event.delete()
        except Exception:
            pass
        return

    if data == "ai_btn:status":
        await event.answer("Checking AI status...")
        res = await backend_client.ai_status()
        if res.get("success"):
            m = res.get("activeModel", "gemini-flash-lite-latest")
            prov = res.get("provider", "Google Gemini")
            feats = res.get("features", {})
            f_lines = [
                f"• Copilot Natural Language: `{'✅ Online' if feats.get('copilotSearch') else '❌ Offline'}`",
                f"• Audiophile Spectrogram Audit: `{'✅ Online' if feats.get('spectrogramAudit') else '❌ Offline'}`",
                f"• Multimodal Vision / JAV: `{'✅ Online' if feats.get('javRecognition') else '❌ Offline'}`",
                f"• Filename & Release Cleaner: `{'✅ Online' if feats.get('filenameCleaner') else '❌ Offline'}`"
            ]
            await event.reply(
                f"⚡ **AI Engine Health & Diagnostic Status**\n\n"
                f"🌐 **Provider:** {prov}\n"
                f"🧠 **Active Model:** `{m}`\n\n"
                f"**Feature Matrix:**\n" + "\n".join(f_lines)
            )
        else:
            await event.reply(f"⚠️ **AI Engine Status:** `{res.get('error', 'Offline or credentials missing')}`")
        return

    if data == "ai_mode:copilot":
        await event.answer()
        ai_pending_modes[sender_id] = {"mode": "copilot", "time": time.time()}
        await event.reply(
            "🧠 **AI Media Copilot**\n\n"
            "Please send what you'd like to find or download in natural English:\n"
            "• *\"Download Queen Bohemian Rhapsody in 24bit flac\"*\n"
            "• *\"Find Dune Part Two in 4k UHD\"*\n"
            "• *\"Search for SSIS-888\"*\n"
            "• Or ask any music mastering / media questions!\n\n"
            "💬 *Waiting for your prompt...*"
        )
        return

    if data == "ai_mode:clean":
        await event.answer()
        ai_pending_modes[sender_id] = {"mode": "clean", "time": time.time()}
        await event.reply(
            "🏷 **AI Release Metadata Cleaner**\n\n"
            "Please send the messy release or torrent filename to clean:\n\n"
            "💬 *Waiting for your filename...*"
        )
        return

    if data == "ai_mode:translate":
        await event.answer()
        ai_pending_modes[sender_id] = {"mode": "translate", "time": time.time()}
        await event.reply(
            "🌐 **AI Japanese Title Translator**\n\n"
            "Please send the Japanese title or text to translate:\n\n"
            "💬 *Waiting for your text...*"
        )
        return

    if data.startswith("ai_img:"):
        msg_id = int(data.split(":", 1)[1])
        await event.answer("Starting visual analysis...")
        message = await event.client.get_messages(event.chat_id, ids=msg_id)
        if not message:
            await event.edit("⚠️ Image is no longer accessible.")
            return

        status_msg = await event.edit("🖼 **Downloading image for visual recognition...**")
        await process_image_recognition(event.client, event.chat_id, message, status_msg)
        return
