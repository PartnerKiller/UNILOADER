# JAV-Downloader &bull; Universal Online Media Downloader

A modern, high-performance web service and online media downloader powered by **`yt-dlp`** and **FFmpeg**. Users simply paste a link from any video or audio site, the service processes the media, and directly serves the file to their device (mobile phone, tablet, laptop, or PC) with an instant download popup.

---

## ✨ Features

- **Universal Platform Support**: Download from Jable.tv, Pornhub, YouTube, Twitter/X, TikTok, Reddit, Instagram, Twitch, Bilibili, SoundCloud, and 1000+ other platforms supported by `yt-dlp`.
- **📥 Direct-to-Device Downloads**: Files are downloaded and delivered directly to the user's browser download folder on any device.
- **🎬 Video Mode**:
  - Custom resolution selection: **Best (Auto 4K/1080p)**, **4K (2160p)**, **2K (1440p)**, **1080p Full HD**, **720p HD**, **480p**, **360p**.
  - Container formats: **MP4**, **MKV**, **WEBM**.
- **🎧 Audio Extraction Mode**:
  - Extract and convert audio to **MP3 (up to 320 kbps)**, **FLAC (Lossless)**, **M4A (AAC)**, **OPUS**, **WAV**, or **AAC**.
  - Automatically embeds high-resolution cover art and complete ID3 metadata tags.
- **📋 Batch Multi-URL Queue**: Paste multiple links (one per line) from different platforms with one-click queued processing.
- **⚡ Quick Presets**: One-click quick configurations for Best Video, HQ MP3 Audio, Lossless FLAC, Subtitles, and SponsorBlock.
- **📝 Subtitles & Captions**: Embed subtitles with custom language filtering (e.g. `en,ja,zh,all`) and auto-generated captions support.
- **⏩ SponsorBlock & Chapters**: Automatically remove sponsor segments, intros, outros, and split by chapters.
- **▶️ In-Browser Preview & Streaming**: Built-in HTML5 media player to preview or stream media before/during download.

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

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/PartnerKiller/JAV-Downloader.git
cd JAV-Downloader

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🔒 Copyright & License

Proprietary software. All rights reserved. Private and confidential.
Unauthorized copying, modification, redistribution, or public deployment is strictly prohibited.
