# JAV-Downloader &bull; Vortex & Seal Hub

A modern, full-featured web application and universal media downloader/streamer powered by **`yt-dlp`** and **FFmpeg**, featuring high-speed multi-threaded downloads, audio extraction, subtitles, SponsorBlock, and an in-browser media player.

Inspired by [JunkFood02/Seal](https://github.com/JunkFood02/Seal).

---

## ✨ Features

- **Universal Platform Support**: Download from Jable.tv, Pornhub, YouTube, Twitter/X, TikTok, Reddit, Instagram, Twitch, Bilibili, SoundCloud, and 1000+ other platforms supported by `yt-dlp`.
- **🎬 Video Mode**:
  - Custom resolution selection: **Best (Auto 4K/1080p)**, **4K (2160p)**, **2K (1440p)**, **1080p Full HD**, **720p HD**, **480p**, **360p**.
  - Containers: **MP4**, **MKV**, **WEBM**.
- **🎧 Audio Extraction Mode**:
  - Extract and convert audio to **MP3 (up to 320 kbps)**, **FLAC (Lossless)**, **M4A (AAC)**, **OPUS**, **WAV**, or **AAC**.
  - Automatically embeds high-resolution cover art and complete ID3 metadata.
- **📋 Batch Multi-URL Queue**: Paste multiple links (one per line) from different platforms with one-click multi-download.
- **⚡ Seal Quick Presets**: One-click quick configurations for Best Video, HQ MP3 Audio, Lossless FLAC, Subtitles, and SponsorBlock.
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

### Installation

```bash
# Clone the repository
git clone https://github.com/PartnerKiller/JAV-Downloader.git
cd JAV-Downloader

# Install dependencies
npm install

# Start the server
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Web server port | `3000` |
| `DEFAULT_DIR` | Destination directory for downloads | `D:\` on Windows, `/media/hdd/JAV` on Linux |

---

## 📜 License

MIT License. Free and open source.
