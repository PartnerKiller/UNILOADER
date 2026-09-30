import aiohttp
import asyncio
import os
import re
from pathlib import Path
from typing import Optional, Dict, Any, List
from config import BACKEND_URL, BACKEND_ADMIN_USER, BACKEND_ADMIN_PASS, TEMP_DIR

class BackendClient:
    def __init__(self):
        self.base_url = BACKEND_URL
        self.token: Optional[str] = None
        self._session: Optional[aiohttp.ClientSession] = None

    async def get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def ensure_auth(self) -> bool:
        if self.token:
            return True
        session = await self.get_session()
        payload = {
            "username": BACKEND_ADMIN_USER,
            "password": BACKEND_ADMIN_PASS,
            "rememberMe": True
        }
        try:
            async with session.post(f"{self.base_url}/api/auth/login", json=payload, timeout=10) as resp:
                data = await resp.json()
                if resp.status == 200 and data.get("success") and data.get("token"):
                    self.token = data["token"]
                    return True
        except Exception as e:
            print(f"[BackendClient] Auth failed: {e}")
        return False

    def _headers(self) -> Dict[str, str]:
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def search_music(self, query: str, source: str = "all") -> List[Dict[str, Any]]:
        await self.ensure_auth()
        session = await self.get_session()
        params = {"q": query, "source": source}
        try:
            async with session.get(f"{self.base_url}/api/music/search", params=params, headers=self._headers(), timeout=30) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data if isinstance(data, list) else data.get("results", [])
        except Exception as e:
            print(f"[BackendClient] Music search error: {e}")
        return []

    async def search_movies(self, query: str) -> List[Dict[str, Any]]:
        await self.ensure_auth()
        session = await self.get_session()
        params = {"q": query}
        try:
            async with session.get(f"{self.base_url}/api/movies/search", params=params, headers=self._headers(), timeout=30) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("results", []) if isinstance(data, dict) else data
        except Exception as e:
            print(f"[BackendClient] Movie search error: {e}")
        return []

    async def search_adult(self, query: str) -> List[Dict[str, Any]]:
        await self.ensure_auth()
        session = await self.get_session()
        params = {"q": query}
        try:
            async with session.get(f"{self.base_url}/api/adult/search", params=params, headers=self._headers(), timeout=30) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("results", []) if isinstance(data, dict) else data
        except Exception as e:
            print(f"[BackendClient] Adult search error: {e}")
        return []

    async def fetch_preview_image(self, url: str) -> Optional[bytes]:
        """Fetches an image preview buffer from remote URL or backend image proxy"""
        if not url:
            return None
        session = await self.get_session()
        target_url = url
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        if url.startswith("/"):
            target_url = f"{self.base_url}{url}"
            headers.update(self._headers())

        try:
            async with session.get(target_url, headers=headers, timeout=12) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    if len(data) > 500:
                        return data
        except Exception as e:
            print(f"[BackendClient] Fetch preview image error for {url}: {e}")
        return None

    async def download_url(self, url: str, video_quality: str = "best", audio_format: Optional[str] = None) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {
            "url": url,
            "videoQuality": video_quality,
        }
        if audio_format:
            payload["audioFormat"] = audio_format
            if audio_format.lower() == "flac":
                payload["mode"] = "audiophile_flac"
                payload["quality"] = "24bit"
        try:
            async with session.post(f"{self.base_url}/api/download", json=payload, headers=self._headers(), timeout=20) as resp:
                data = await resp.json()
                return data
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def download_music(self, track_info: Dict[str, Any], flac: bool = True) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {
            "title": track_info.get("title", ""),
            "artist": track_info.get("artist", ""),
            "album": track_info.get("album", ""),
            "cover": track_info.get("cover") or track_info.get("image", ""),
            "duration": track_info.get("duration", 0),
            "format": "flac" if flac else "mp3",
            "quality": "24bit" if flac else "320k"
        }
        try:
            async with session.post(f"{self.base_url}/api/music/download", json=payload, headers=self._headers(), timeout=20) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def download_movie(self, movie_info: Dict[str, Any], release: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {
            "title": movie_info.get("title", ""),
            "pureTitle": movie_info.get("pureTitle") or movie_info.get("title", ""),
            "poster": movie_info.get("poster", ""),
            "year": movie_info.get("year", "")
        }
        if release:
            payload.update({
                "magnet": release.get("magnet", ""),
                "torrentUrl": release.get("torrentUrl", ""),
                "quality": release.get("quality", "1080p"),
                "releaseFilename": release.get("filename", ""),
                "releaseLabel": release.get("label", ""),
                "size": release.get("size", "")
            })
        try:
            async with session.post(f"{self.base_url}/api/movies/download", json=payload, headers=self._headers(), timeout=20) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def download_adult(self, adult_info: Dict[str, Any]) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {
            "title": adult_info.get("title", ""),
            "magnet": adult_info.get("magnet", ""),
            "torrentUrl": adult_info.get("torrentUrl", ""),
            "url": adult_info.get("url", ""),
            "thumb": adult_info.get("thumb") or adult_info.get("rawThumb", ""),
            "code": adult_info.get("code", ""),
            "type": adult_info.get("type", "jav")
        }
        try:
            async with session.post(f"{self.base_url}/api/adult/download", json=payload, headers=self._headers(), timeout=20) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        await self.ensure_auth()
        session = await self.get_session()
        try:
            async with session.get(f"{self.base_url}/api/jobs?all=1", headers=self._headers(), timeout=10) as resp:
                if resp.status == 200:
                    jobs = await resp.json()
                    for j in jobs:
                        if j.get("id") == job_id:
                            return j
        except Exception as e:
            print(f"[BackendClient] Get job error: {e}")
        return None

    async def cancel_job(self, job_id: str) -> bool:
        await self.ensure_auth()
        session = await self.get_session()
        try:
            async with session.post(f"{self.base_url}/api/jobs/{job_id}/cancel", headers=self._headers(), timeout=10) as resp:
                return resp.status == 200
        except Exception:
            return False

    async def ai_status(self) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        try:
            async with session.get(f"{self.base_url}/api/ai/status", headers=self._headers(), timeout=15) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_copilot(self, prompt: str) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        try:
            async with session.post(f"{self.base_url}/api/ai/copilot", json={"prompt": prompt}, headers=self._headers(), timeout=40) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_chat(self, prompt: str, system_context: str = "") -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {"prompt": prompt}
        if system_context:
            payload["systemContext"] = system_context
        try:
            async with session.post(f"{self.base_url}/api/ai/chat", json=payload, headers=self._headers(), timeout=40) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_audit_spectrogram(self, image_base64: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {"imageBase64": image_base64, "metadata": metadata or {}}
        try:
            async with session.post(f"{self.base_url}/api/ai/audit-spectrogram", json=payload, headers=self._headers(), timeout=45) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_clean_filename(self, filename: str) -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        try:
            async with session.post(f"{self.base_url}/api/ai/clean-filename", json={"filename": filename}, headers=self._headers(), timeout=35) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_jav_recognize(self, image_base64: str, context_text: str = "") -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {"imageBase64": image_base64, "contextText": context_text}
        try:
            async with session.post(f"{self.base_url}/api/ai/jav-recognize", json=payload, headers=self._headers(), timeout=45) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def ai_jav_translate(self, title: str, synopsis: str = "") -> Dict[str, Any]:
        await self.ensure_auth()
        session = await self.get_session()
        payload = {"title": title, "synopsis": synopsis}
        try:
            async with session.post(f"{self.base_url}/api/ai/jav-translate", json=payload, headers=self._headers(), timeout=35) as resp:
                return await resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}

    def resolve_local_media_file(self, job: Dict[str, Any]) -> Optional[Path]:
        """Locates the downloaded file on local disk across temp and permanent storage"""
        # 1. Direct filePath in job object
        file_path = job.get("filePath")
        if file_path and os.path.isfile(file_path):
            return Path(file_path)

        filename = job.get("filename")
        job_id = job.get("id") or ""
        
        # Build candidate filenames (both with and without job_id prefixes)
        candidates = []
        if filename:
            candidates.append(filename)
            if job_id and filename.startswith(f"{job_id}_"):
                candidates.append(filename[len(job_id) + 1:])
            # Also handle generic job_ prefix
            clean_job_prefix = re.sub(r"^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_", "", filename)
            if clean_job_prefix != filename:
                candidates.append(clean_job_prefix)

        # 2. Check downloadFolder assigned in job
        download_folder = job.get("downloadFolder")
        if download_folder and os.path.isdir(download_folder):
            p_dl = Path(download_folder)
            for c in candidates:
                # Direct in folder
                if (p_dl / c).is_file():
                    return p_dl / c
                # Recursive in subfolders (e.g. Music, Movies, Adult, Links)
                matches = list(p_dl.glob(f"**/{c}"))
                if matches:
                    return matches[0]

        # 3. Check filename candidates in TEMP_DIR
        if TEMP_DIR.exists():
            for c in candidates:
                p = TEMP_DIR / c
                if p.is_file():
                    return p

        # 4. Check dedicated job folder or job_id matches in TEMP_DIR
        if job_id and TEMP_DIR.exists():
            job_subfolder = TEMP_DIR / job_id
            if job_subfolder.is_dir():
                media_files = [f for f in job_subfolder.glob("**/*") if f.is_file() and not f.name.endswith(('.aria2', '.part', '.temp', '.txt'))]
                if media_files:
                    return max(media_files, key=lambda f: f.stat().st_size)

            matches = [f for f in TEMP_DIR.glob(f"{job_id}_*") if f.is_file() and not f.name.endswith(('.part', '.temp'))]
            if matches:
                return max(matches, key=lambda f: f.stat().st_size)

        # 5. Check permanent Uni-Downloads folder
        uni_root = Path("/home/sakura/Uni-Downloads")
        if uni_root.exists():
            for c in candidates:
                matches_uni = list(uni_root.glob(f"**/{c}"))
                if matches_uni:
                    return matches_uni[0]

        # 6. Check Soulseek downloads directory
        slskd_dir = Path("/home/sakura/slskd_downloads")
        if slskd_dir.exists():
            for c in candidates:
                matches_slskd = [f for f in slskd_dir.glob(f"**/{c}") if f.is_file()]
                if matches_slskd:
                    return matches_slskd[0]

        return None

backend_client = BackendClient()
