# One-Click Deployment Script for JAV-Downloader to Remote Server (sakura@192.168.0.10)
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Deploying JAV-Downloader to Remote Server" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$RemoteHost = "sakura@192.168.0.10"
$RemoteDir = "/home/sakura/jav"
$BundleName = "deploy_bundle.tar.gz"

Write-Host "`n[1/4] Packing deployment bundle..." -ForegroundColor Yellow
tar.exe -czf $BundleName server.js extractor.js fetcher.py flac_checker.py hifi_engine.py deezer_hifi_engine.py hls_downloader.py instagram_engine.py soulseek_flac_engine.py spotiflac_engine.py spotiflac_next_engine.py spotify_downloader.py tiktok_engine.py tidal_monochrome_engine.py package.json package-lock.json public

try {
    Write-Host "[2/4] Uploading $BundleName via SCP to $RemoteHost..." -ForegroundColor Yellow
    scp -o BatchMode=yes $BundleName "${RemoteHost}:${RemoteDir}/${BundleName}"

    Write-Host "[3/4] Extracting bundle and restarting service on remote server..." -ForegroundColor Yellow
    ssh -o BatchMode=yes $RemoteHost "cd $RemoteDir && tar -xzvf $BundleName && rm $BundleName && npm install --omit=dev && echo 'sakura' | sudo -S -p '' systemctl restart jav-downloader.service"

    Write-Host "[4/4] Verifying remote service health..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    $Health = Invoke-RestMethod -Uri "https://jav.nazuna.dpdns.org/api/health"
    if ($Health.status -eq "ok") {
        Write-Host "`nDeployment Succeeded! Site is live at https://jav.nazuna.dpdns.org" -ForegroundColor Green
    } else {
        Write-Host "`nDeployment completed with warning: Health check status is $($Health.status)" -ForegroundColor Yellow
    }
}
finally {
    if (Test-Path $BundleName) {
        Remove-Item $BundleName -Force
    }
}
