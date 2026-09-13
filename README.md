# Universal Downloader &bull; Universal Media & Audiophile Lossless Downloader

A modern, high-performance web service, desktop application, and Android companion client for streaming and downloading online media. Powered by **`yt-dlp`**, **FFmpeg**, automated TLS-fingerprinted Cloudflare bypass engines (**`curl_cffi`**), and a dedicated **Multi-Tier Lossless FLAC Pipeline** (**Tidal Hi-Res**, **Soulseek P2P**, and **Deezer HiFi**).

---

## ✨ Features

### 🎵 Multi-Tier Lossless FLAC Audio Engine (Strictly Genuine Lossless)
- **Always Downloads the Best Quality FLAC**:
  - Automatically prioritizes **24-bit / 32-bit Hi-Res Studio Masters (192 kHz, 96 kHz, 88.2 kHz, 48 kHz)** over standard 16-bit 44.1 kHz CD Lossless.
  - Multi-factor peer scoring evaluates bit depth (`bitDepth`), sample rate (`sampleRate`), free upload slots, queue length, and transfer speeds.
- **Source Resolution Pipeline**:
  - **Tier 1 (Studio Masters)**: Tidal Hi-Res / Monochrome engine (24-bit / 96–192 kHz FLAC).
  - **Tier 2 (P2P Audiophile Masters)**: Soulseek P2P Network (SLSKD) with 24-bit prioritization, audiophile keyword recognition (`vinyl`, `sacd`, `studio master`), and instant free-slot routing.
  - **Tier 3 (Lossless CD Bitstream)**: Deezer HiFi 1411 kbps 16-bit 44.1 kHz FLAC CDN with automatic territory fallback token failover and Blowfish CBC stream decryption.
- **No Fake Transcoding Guarantee**:
  - YouTube transcoding to FLAC is completely disabled to guarantee 100% genuine lossless bitstreams without upscaled lossy audio.

### 🎧 Spotify Lossless & Full Catalog Archiving (SpotiFLAC-Next)
- **Resilient Embed Scraper Fallback**:
  - Automatically bypasses Spotify API `401 Valid user authentication required` restrictions on playlist and album items using embedded JSON state extraction.
  - Supports individual tracks, full albums, and playlists of any length.
- **Rich Metadata & Synced Lyrics**:
  - Injects full Vorbis/ID3 comments (`TITLE`, `ARTIST`, `ALBUM`, `DATE`, `TRACKNUMBER`, `ISRC`).
  - Fetches synchronized lyrics (`.lrc`) via LRCLIB.
  - Embeds 640x640 high-resolution album artwork into FLAC tags and generates front cover files.
- **Automated Archive Packaging**:
  - Multi-track playlists and albums are automatically organized, tagged, and packaged into a `.zip` archive for single-click downloads.

### 🎬 Universal Video & Stream Downloader
- **Adult & JAV Specialized Extractors**:
  - **Jav.Guru** (`jav.guru`) &bull; *Base64 iframe & Searcho gateway token decoder*
  - **MissAV** (`missav.*`) &bull; *Dean Edwards JS unpacker & Surrit HLS resolver*
  - **SupJav** (`supjav.*`) &bull; *Reversed OLID decryptor across TV, ST, FST, & VOE servers*
  - **JavGG** (`javgg.*`) &bull; *Earnvid, JavStreamHQ & Turbovid player iframe decoders*
  - **nJAV / nJAVTv** (`njav.*`) &bull; *Embedded player resolvers*
  - **Jable.tv** (`jable.tv`) &bull; *Direct high-speed multi-quality HLS streams*
  - **XVideos & XNXX** &bull; *Direct HLS & 1080p MP4 stream extraction*
  - **xHamster** &bull; *Up to 4K 2160p HDR/SDR multi-bitrate HLS streams*
  - **Rule34Video** &bull; *Direct 4K, 1080p, 720p stream extraction*
  - **Pornhub**, **TokyoMotion**, **7MMTV**, **JavCL**, **Javmix**, and more.
- **Mainstream Social & Streaming Platforms**:
  - YouTube (up to 4K/8K HDR, 60fps), Twitter/X, TikTok, Instagram, Reddit, Twitch, Bilibili, SoundCloud, and 1000+ others via `yt-dlp`.
- **Quality & Format Controls**:
  - Video: **4K (2160p)**, **2K (1440p)**, **1080p Full HD**, **720p HD**, **480p**, **360p** in **MP4**, **MKV**, or **WEBM**.
  - Audio: **FLAC (Genuine Lossless)**, **MP3 (up to 320 kbps)**, **M4A (AAC)**, **OPUS**, **WAV**.
  - Subtitles with language filters (`en,ja,zh,all`) and SponsorBlock chapter skipping.

### 🔬 Inbuilt FLAC Checker & Spectrogram Analyzer
- Multi-band frequency cutoff analysis (FFmpeg energy detection at 16kHz, 18.5kHz, 20kHz, 22kHz, 24kHz) to expose fake/upscaled FLACs.
- Verifies bit depth, sample rate, bit rate, and generates in-browser logarithmic audio spectrograms.

### 📱 Multi-Platform Clients
- **Responsive Web UI**: Modern dark-theme web dashboard accessible from desktop, tablet, and mobile browsers.
- **Windows Desktop App**: Built with Electron, complete with system tray, desktop shortcuts, and native file pickers.
- **Android App (`JAV-Downloader.apk`)**: Native Android client with WebView integration, background downloads, and server switching.

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** >= 18.x
- **Python** >= 3.10
- **FFmpeg** installed and accessible in `PATH`
- **yt-dlp** installed and accessible in `PATH`

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/PartnerKiller/JAV-Downloader.git
cd JAV-Downloader

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt # or: pip install curl_cffi beautifulsoup4 mutagen spotdl deezer-py pycryptodomex requests
```

### 3. Configuration

Copy the example environment configuration:

```bash
cp .env.example .env
```

Edit `.env` to configure optional integrations:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Web server listening port | `3000` |
| `SPOTIFY_CLIENT_ID` | Spotify Developer Client ID (optional metadata resolution) | `""` |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer Client Secret (optional metadata resolution) | `""` |
| `DEEZER_ARL` | Deezer HiFi ARL cookie for 1411 kbps FLAC streaming | `""` |
| `SLSKD_API_BASE` | SLSKD daemon REST API endpoint for Soulseek P2P FLAC | `http://127.0.0.1:5030/api/v0` |

> [!NOTE]
> Never commit your `.env` file or private credentials to version control. The repository includes strict `.gitignore` rules to protect all sensitive keys.

### 4. Running the Application

#### Web Server
```bash
npm start
```
Access the dashboard at `http://localhost:3000`.

#### Windows Desktop App (Electron)
```bash
npm run app
```
Or double-click `JAV-Downloader.bat` / desktop shortcut.

---

## 🛡️ Security & Confidentiality

- All credentials, session tokens (ARLs), and private keys are loaded dynamically from environment variables or ignored `.env` files.
- Deployment scripts with infrastructure parameters must use `deploy.ps1.example` as a template and remain gitignored.

---

## 🔒 License

Proprietary software. All rights reserved. Private and confidential.
