import aiohttp
import asyncio
import os
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
            "quality": "flac" if flac else "320k"
        }
        try:
            async with session.post(f"{self.base_url}/api/music/download", json=payload, headers=self._headers(), timeout=20) as resp:
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

    def resolve_local_media_file(self, job: Dict[str, Any]) -> Optional[Path]:
        """Locates the downloaded file on local disk"""
        # 1. Direct filePath in job object
        file_path = job.get("filePath")
        if file_path and os.path.isfile(file_path):
            return Path(file_path)

        # 2. Check filename in TEMP_DIR
        filename = job.get("filename")
        if filename:
            p = TEMP_DIR / filename
            if p.is_file():
                return p

        # 3. Check job folder or prefix in TEMP_DIR
        job_id = job.get("id")
        if job_id and TEMP_DIR.exists():
            # Check dedicated subfolder
            job_subfolder = TEMP_DIR / job_id
            if job_subfolder.is_dir():
                media_files = [f for f in job_subfolder.glob("**/*") if f.is_file() and not f.name.endswith(('.aria2', '.part', '.temp', '.txt'))]
                if media_files:
                    # Return largest file
                    return max(media_files, key=lambda f: f.stat().st_size)

            # Check files starting with jobId_
            matches = [f for f in TEMP_DIR.glob(f"{job_id}_*") if f.is_file() and not f.name.endswith(('.part', '.temp'))]
            if matches:
                return max(matches, key=lambda f: f.stat().st_size)

        return None

backend_client = BackendClient()
