# Universal Downloader &bull; Universal Online Media Downloader

A modern, high-performance web service and online media downloader powered by **`yt-dlp`**, **FFmpeg**, and automated Cloudflare anti-bot challenge bypass engines (`curl_cffi`). Users simply paste a link from any video or audio site, the service processes the media, and directly serves the file to their device (mobile phone, tablet, laptop, or PC) with an instant download popup.

---

## ✨ Features

- **Dedicated JAV & Adult Extractors**:
  - **Jav.Guru** (`jav.guru`) &bull; *Automated base64 iframe & Searcho gateway token decoder*
  - **MissAV** (`missav.ws`, `missav.ai`, `missav.live`, `missav.com`) &bull; *Automated Dean Edwards JS unpacker & Surrit HLS resolver*
  - **SupJav** (`supjav.com`, `supjav.net`) &bull; *Reversed OLID decryptor across TV, ST, FST, & VOE servers*
  - **JavGG** (`javgg.net`, `javgg.me`, `javgg.to`) &bull; *Earnvid, JavStreamHQ & Turbovid player iframe decoders*
  - **nJAV & nJAVTv** (`njav.tv`, `njav.to`, `njav.org`) &bull; *Embedded player resolvers*
  - **Jable.tv** (`jable.tv`) &bull; *Direct high-speed multi-quality HLS streams*
  - **XVideos & XNXX** (`xvideos.com`, `xnxx.com`, `xvideos.red`, `xnxx.tv`) &bull; *Direct HLS & 1080p MP4 stream extraction*
  - **xHamster** (`xhamster.com`, `xhamster19.com`, `xhamster.desi`, `xhamster1.com` ... `xhamster20.com`) &bull; *Up to 4K 2160p HDR/SDR multi-bitrate HLS streams*
  - **Rule34Video** (`rule34video.com`) &bull; *Direct 4K (2160p), 1080p, 720p stream extraction & preview*
  - **Pornhub** (`pornhub.com`) &bull; *Multi-resolution HLS media extractor*
  - **TokyoMotion**, **7MMTV**, **JavCL**, **Javmix**, **JavFull**, **JavDoe**, **Javseen**, **JavQuick**, **JavCt**, **JapanHDV**, **JavSubindo**, and more.
- **Spotify Music Extractor**: Paste any Spotify track, album, or playlist link (`open.spotify.com/track/...`) &bull; *Automated Spotify Web API metadata & artwork resolution with 320kbps MP3 audio matching and ID3 tagging*.
- **🎵 Genuine Lossless Audio Engine**: Pure CDDA (16-bit / 44.1 kHz) and Studio Master (24-bit / 96 kHz+) FLAC archiving via Soulseek HiFi P2P network. Never downgrades or transcodes lossy YouTube Opus into fake FLACs.
- **🔬 Inbuilt FLAC Checker & Spectral Analyzer**: Multi-band frequency cutoff analysis (FFmpeg energy detection at 16kHz, 18.5kHz, 20kHz, 22kHz, 24kHz) to instantly expose fake/upscaled FLACs, verify true bit depth and sample rates, and view high-resolution audio spectrograms.
- **💻 Native Windows Desktop Application**: Built with Electron, complete with system tray, desktop shortcut, native Windows folder/file picker dialogs, and offline background daemon support.
- **Universal Multi-Platform Support**: YouTube, Twitter/X, TikTok, Reddit, Instagram, Twitch, Bilibili, SoundCloud, and 1000+ other platforms supported by `yt-dlp`.
- **📥 Direct-to-Device Downloads**: Files are downloaded and delivered directly to the user's chosen folder (`Downloads/JAV-Downloader` by default).
- **🎬 Video Mode**:
  - Custom resolution selection: **Best (Auto 4K/1080p)**, **4K (2160p)**, **2K (1440p)**, **1080p Full HD**, **720p HD**, **480p**, **360p**.
  - Container formats: **MP4**, **MKV**, **WEBM**.
- **🎧 Audio Extraction Mode**:
  - Extract and convert audio to **MP3 (up to 320 kbps)**, **FLAC (Genuine Lossless)**, **M4A (AAC)**, **OPUS**, **WAV**, or **AAC**.
  - Automatically embeds high-resolution cover art and complete ID3 / Vorbis metadata tags.
- **📋 Batch Multi-URL Queue**: Paste multiple links (one per line) from different platforms with one-click queued processing.
- **⚡ Quick Presets**: One-click quick configurations for Best Video, HQ MP3 Audio, Lossless FLAC, Subtitles, and SponsorBlock.
- **📝 Subtitles & Captions**: Embed subtitles with custom language filtering (e.g. `en,ja,zh,all`) and auto-generated captions support.
- **⏩ SponsorBlock & Chapters**: Automatically remove sponsor segments, intros, outros, and split by chapters.
- **▶️ In-Browser Preview & Streaming**: Built-in HTML5 media player to preview or stream media before/during download.

---

## 🚀 Quick Start

### Running as a Windows Desktop App

1. **One-Click Launch**: Double-click the **`JAV Downloader`** desktop shortcut, or run **`JAV-Downloader.bat`**.
2. **Command Line**:
   ```bash
   npm run app
   ```
3. To regenerate the desktop shortcut at any time:
   ```bash
   Create-Desktop-Shortcut.bat
   ```

### Running as a Web Server

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🔬 Inbuilt FLAC Checker

Use the dedicated **FLAC Checker** tab in the desktop app or web UI to verify any audio file:
- **Genuine Hi-Res Studio Master**: 24-bit / 96kHz or 192kHz with harmonic energy extending up to 48kHz+.
- **Genuine CDDA Lossless**: 16-bit / 44.1kHz with full bandwidth up to 22.05kHz.
- **Fake FLAC Detection**: Instantly spots brickwall low-pass cutoffs from 128kbps MP3 (16.0 kHz), 192kbps MP3 (18.5 kHz), or YouTube Opus/AAC (20.0 kHz).

---

## 🔒 Copyright & License

Proprietary software. All rights reserved. Private and confidential.
Unauthorized copying, modification, redistribution, or public deployment is strictly prohibited.
