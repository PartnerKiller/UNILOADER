# JAV-Downloader &bull; Vortex Media Hub

A modern, high-performance web application and universal media downloader/streamer powered by **`yt-dlp`** and **FFmpeg**, featuring multi-threaded stream assembly, audio extraction, subtitles, SponsorBlock, and a built-in media player.

---

## ✨ Features

- **Universal Platform Support**: Download from Jable.tv, Pornhub, YouTube, Twitter/X, TikTok, Reddit, Instagram, Twitch, Bilibili, SoundCloud, and 1000+ other platforms supported by `yt-dlp`.
- **⚙️ Configurable Download Directory**: No hardcoded default path. Select your download directory during installation or configure it anytime in the Web UI.
- **🎬 Video Mode**:
  - Custom resolution selection: **Best (Auto 4K/1080p)**, **4K (2160p)**, **2K (1440p)**, **1080p Full HD**, **720p HD**, **480p**, **360p**.
  - Container formats: **MP4**, **MKV**, **WEBM**.
- **🎧 Audio Extraction Mode**:
  - Extract and convert audio to **MP3 (up to 320 kbps)**, **FLAC (Lossless)**, **M4A (AAC)**, **OPUS**, **WAV**, or **AAC**.
  - Automatically embeds high-resolution cover art and complete ID3 metadata tags.
- **📋 Batch Multi-URL Queue**: Paste multiple links (one per line) from different platforms with one-click queued downloading.
- **⚡ Quick Presets**: One-click quick configurations for Best Video, HQ MP3 Audio, Lossless FLAC, Subtitles, and SponsorBlock.
- **📝 Subtitles & Captions**: Embed subtitles with custom language filtering (e.g. `en,ja,zh,all`) and auto-generated captions support.
- **⏩ SponsorBlock & Chapters**: Automatically remove sponsor segments, intros, outros, and split by chapters.
- **📁 In-Browser Media Library & Player**: Browse downloaded media with formatted sizes, timestamps, and stream videos/audio directly in your browser with HTTP 206 partial content support.
- **🌐 Cross-Platform**: Runs on Windows and Linux (with systemd service support).

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)
- [Python 3](https://www.python.org/) with `curl_cffi` (recommended for Cloudflare TLS bypass):
  ```bash
  pip install curl_cffi
  ```

### Installation & Setup

```bash
# 1. Clone the repository
git clone https://github.com/PartnerKiller/JAV-Downloader.git
cd JAV-Downloader

# 2. Install dependencies
npm install

# 3. Configure your download directory (interactive setup)
npm run setup

# 4. Start the server
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

> **Note**: You can also set or change your download directory directly inside the Web UI at any time by clicking the **⚙️ Settings** icon in the header.

---

## ⚙️ Configuration File (`config.json`)

The chosen download directory is saved locally in `config.json`:
```json
{
  "downloadDir": "/path/to/your/download/folder"
}
```

---

## 🔒 Copyright & License

Proprietary software. All rights reserved. Private and confidential.
Unauthorized copying, modification, redistribution, or public deployment is strictly prohibited.
