#!/usr/bin/env python3
"""
OlaMovies Direct Cloud Stream Solver
Automates:
  1. links.olamovies.mov (Slider verification)
  2. srnky.com (Cloudflare Turnstile & Continue)
  3. financeehelp.com (Ad 1: 15s Countdown & Get Link)
  4. financeehelp.com (Ad 2: 15s Countdown & Get Link)
  5. drive.olamovies.download (OM DRIVE: Direct Cloud Link extraction)
Output: Emits streaming JSON progress updates to stdout.
"""

import sys
import os
import json
import time
import re
import argparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

try:
    from playwright_stealth.stealth import Stealth
except ImportError:
    try:
        from playwright_stealth import Stealth
    except ImportError:
        Stealth = None


def emit(data):
    """Emit JSON payload to stdout with immediate flush."""
    print(json.dumps(data, ensure_ascii=False), flush=True)


def emit_progress(step, total, percent, message):
    emit({
        "type": "progress",
        "step": step,
        "total": total,
        "percent": percent,
        "message": message,
        "timestamp": int(time.time() * 1000)
    })


def emit_log(text):
    emit({
        "type": "log",
        "text": text,
        "timestamp": int(time.time() * 1000)
    })


def emit_result(success, stream_url=None, filename=None, filesize=None, error=None):
    emit({
        "type": "result",
        "success": success,
        "streamUrl": stream_url,
        "filename": filename,
        "filesize": filesize,
        "error": error,
        "timestamp": int(time.time() * 1000)
    })


def load_cookies(cookie_input):
    """Parse cookie string or JSON array."""
    if not cookie_input:
        return []
    if os.path.exists(cookie_input):
        try:
            with open(cookie_input, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            emit_log(f"[WARN] Failed to read cookie file: {e}")
            return []
    try:
        return json.loads(cookie_input)
    except Exception:
        cookies = []
        for pair in cookie_input.split(';'):
            if '=' in pair:
                k, v = pair.strip().split('=', 1)
                cookies.append({
                    "name": k,
                    "value": v,
                    "domain": ".olamovies.mov",
                    "path": "/"
                })
        return cookies


def solve_slider(page):
    """Check Cloudflare, find slider handle, and perform human drag."""
    emit_log("[Step 1] Loading release page...")
    page.wait_for_timeout(2000)

    # Check for Cloudflare Turnstile managed challenge on links host
    if "Just a moment" in page.title() or "challenges.cloudflare.com" in page.content():
        emit_log("[Step 1] Cloudflare Turnstile challenge detected on link host...")
        for sec in range(12):
            page.wait_for_timeout(1000)
            if "Just a moment" not in page.title():
                emit_log("[Step 1] Cloudflare verification passed!")
                break
            for frame in page.frames:
                if 'challenges.cloudflare.com' in frame.url:
                    try:
                        box = frame.locator('#challenge-stage, .ctp-checkbox-label, input[type="checkbox"]').first
                        if box.is_visible():
                            box.click(timeout=2000)
                            emit_log("[Step 1] Clicked Turnstile checkbox...")
                    except Exception:
                        pass
        if "Just a moment" in page.title():
            return False, "Cloudflare Turnstile challenge blocked headless server. Please click '🚀 Auto-Hop in Browser' on the download card to complete via the Sakura Companion Script."

    # Check if login prompt exists
    login_btn = page.locator('a:has-text("Login to Continue"), button:has-text("Login to Continue")')
    if login_btn.count() > 0 and login_btn.first.is_visible():
        emit_log("[WARN] OlaMovies requested Google login. Stored session cookie required.")
        return False, "Google login required on OlaMovies. Please save your session cookie in Admin settings or use Browser Auto-Hop."

    # Look for slider container
    slider_handle = page.locator('.slider-handle, [role="slider"], .drag-handle, .arrow-handle, button:has-text("->"), div:has-text("->")')
    marker = page.locator('.slider-marker, .marker, .target-marker, .target-circle')

    try:
        handle_box = page.evaluate('''() => {
            const el = document.querySelector('.slider-handle') || 
                       document.querySelector('[role="slider"]') ||
                       Array.from(document.querySelectorAll('div, span, button')).find(e => e.innerText && e.innerText.includes('->'));
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }''')

        marker_box = page.evaluate('''() => {
            const el = document.querySelector('.slider-marker') || 
                       document.querySelector('.marker') || 
                       document.querySelector('.target-circle') ||
                       Array.from(document.querySelectorAll('div, span')).find(e => e.className && (e.className.includes('marker') || e.className.includes('circle')));
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }''')

        if handle_box and marker_box:
            start_x = handle_box['x'] + handle_box['width'] / 2
            start_y = handle_box['y'] + handle_box['height'] / 2
            end_x = marker_box['x'] + marker_box['width'] / 2
            end_y = marker_box['y'] + marker_box['height'] / 2

            emit_log(f"[Step 1] Dragging slider from ({int(start_x)}, {int(start_y)}) to ({int(end_x)}, {int(end_y)})...")
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            steps = 15
            for s in range(1, steps + 1):
                cur_x = start_x + (end_x - start_x) * (s / steps)
                cur_y = start_y + (end_y - start_y) * (s / steps)
                page.mouse.move(cur_x, cur_y)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(1000)
    except Exception as e:
        emit_log(f"[Step 1] Slider drag note: {e}")

    # Now click "Verify to generate link"
    verify_btn = page.locator('button:has-text("Verify to generate link"), a:has-text("Verify to generate link")')
    if verify_btn.count() > 0:
        emit_log("[Step 1] Clicking 'Verify to generate link'...")
        try:
            verify_btn.first.click(timeout=5000)
            page.wait_for_timeout(2000)
        except Exception as e:
            emit_log(f"[Step 1] Click verify note: {e}")

    # Look for destination link button
    for _ in range(8):
        page.wait_for_timeout(1000)
        dest = page.locator('a[href*="srnky.com"], a[href*="financeehelp"], a[href*="techmags"], a.btn-success, .btn-generate')
        if dest.count() > 0:
            href = dest.first.get_attribute('href')
            if href and href.startswith('http'):
                emit_log(f"[Step 1] Generated shortener link: {href}")
                return True, href

    if 'links.olamovies' not in page.url and 'links.ol-am' not in page.url and 'ol-am.top' not in page.url:
        return True, page.url

    return False, "Gate 1 Human Check slider did not generate shortener link on server. Please click '🚀 Auto-Hop in Browser' on the download card to resolve."


def solve_turnstile(page):
    """Check for Cloudflare Turnstile on srnky.com and click if needed."""
    emit_log("[Step 2] Checking Cloudflare Turnstile on shortener...")
    page.wait_for_timeout(3000)

    for frame in page.frames:
        if 'challenges.cloudflare.com' in frame.url or 'turnstile' in frame.url:
            emit_log("[Step 2] Found Cloudflare Turnstile frame. Clicking verification box...")
            try:
                box = frame.locator('input[type="checkbox"], .ctp-checkbox-label, #cf-stage, body')
                if box.count() > 0:
                    box.first.click(timeout=4000)
                    page.wait_for_timeout(2500)
            except Exception as e:
                emit_log(f"[Step 2] Turnstile frame click notice: {e}")

    cont_btn = page.locator('button:has-text("Continue"), a:has-text("Continue"), input[value="Continue"]')
    for _ in range(12):
        if cont_btn.count() > 0 and cont_btn.first.is_visible():
            emit_log("[Step 2] Clicking 'Continue' button...")
            try:
                cont_btn.first.click()
                page.wait_for_timeout(3000)
                return True
            except Exception as e:
                emit_log(f"[Step 2] Click continue retry: {e}")
        page.wait_for_timeout(1000)

    return True


def solve_ad_timer_step(page, step_num):
    """Handle 15-second ad timer on financeehelp.com."""
    emit_log(f"[Step {step_num}] On ad page: {page.url}")
    page.wait_for_timeout(2000)

    start_btn = page.locator('#startButton, button:has-text("Continue"), a:has-text("Continue"), .btn-continue')
    if start_btn.count() > 0 and start_btn.first.is_visible():
        emit_log(f"[Step {step_num}] Found start/continue button. Clicking...")
        try:
            start_btn.first.scroll_into_view_if_needed()
            start_btn.first.click()
        except Exception as e:
            emit_log(f"[Step {step_num}] Click start notice: {e}")

    emit_log(f"[Step {step_num}] Waiting 15s timer countdown...")
    for sec in range(15, 0, -3):
        emit_progress(step_num, 5, 20 + step_num * 15, f"Ad timer countdown: {sec}s remaining...")
        page.wait_for_timeout(3000)

    get_link_btn = page.locator('#getmylink, a:has-text("Get Link"), button:has-text("Get Link"), a[href*="#getmylink"]')
    for _ in range(10):
        if get_link_btn.count() > 0 and get_link_btn.first.is_visible():
            emit_log(f"[Step {step_num}] Clicking 'Get Link' button...")
            try:
                get_link_btn.first.scroll_into_view_if_needed()
                get_link_btn.first.click()
                page.wait_for_timeout(3000)
                return True
            except Exception as e:
                emit_log(f"[Step {step_num}] Click get link notice: {e}")
        page.wait_for_timeout(1000)

    return True


def extract_om_drive(page):
    """Extract direct cloud streaming link from drive.olamovies.download."""
    emit_log("[Step 5] Accessing OM DRIVE page...")
    page.wait_for_timeout(3000)

    body_text = page.locator('body').inner_text()
    if 'Sign in with Google' in body_text and 'Direct Cloud Link' not in body_text:
        return False, None, None, "OM DRIVE requires Google sign-in. Use saved browser session or companion script."

    title = ""
    size = ""
    try:
        title_el = page.locator('h1, h2, h3, .movie-title, .file-name')
        if title_el.count() > 0:
            title = title_el.first.inner_text().strip()
        size_el = page.locator(':has-text("GB"), :has-text("MB")')
        if size_el.count() > 0:
            m = re.search(r'([\d.]+\s*(?:GB|MB))', size_el.first.inner_text())
            if m:
                size = m.group(1)
    except Exception:
        pass

    direct_url = None

    def on_response(response):
        nonlocal direct_url
        if 'workers.dev/serve' in response.url:
            direct_url = response.url
            emit_log(f"[Step 5] Intercepted workers.dev direct URL: {direct_url[:60]}...")

    page.on('response', on_response)

    direct_btn = page.locator('button:has-text("Direct Cloud Link"), a:has-text("Direct Cloud Link"), .btn-direct-cloud')
    if direct_btn.count() > 0:
        emit_log("[Step 5] Clicking 'Direct Cloud Link'...")
        try:
            direct_btn.first.click()
            page.wait_for_timeout(3000)
        except Exception as e:
            emit_log(f"[Step 5] Click direct cloud link error: {e}")

    inputs = page.locator('input').all()
    for inp in inputs:
        try:
            val = inp.input_value()
            if val and 'workers.dev/serve' in val:
                direct_url = val
                break
        except Exception:
            pass

    if not direct_url:
        links = page.locator('a[href*="workers.dev/serve"]').all()
        for lnk in links:
            href = lnk.get_attribute('href')
            if href:
                direct_url = href
                break

    if direct_url:
        return True, direct_url, title, size
    return False, None, title, "Could not extract Direct Cloud Link from OM DRIVE"


def main():
    parser = argparse.ArgumentParser(description="OlaMovies Direct Cloud Solver")
    parser.add_argument("--url", required=True, help="Initial links.olamovies.mov URL")
    parser.add_argument("--cookies", help="Path to cookies JSON file or raw cookie string")
    parser.add_argument("--timeout", type=int, default=120, help="Overall timeout in seconds")
    parser.add_argument("--debug", action="store_true", help="Capture debug screenshots")
    args = parser.parse_args()

    emit_progress(1, 5, 10, "Launching high-speed browser engine on Sakura...")
    emit_log(f"Starting OlaMovies resolution for: {args.url}")

    cookies = load_cookies(args.cookies)
    if cookies:
        emit_log(f"Loaded {len(cookies)} session cookies.")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-infobars',
                '--start-maximized'
            ]
        )
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            viewport={'width': 1920, 'height': 1080},
            locale='en-US',
            timezone_id='Asia/Kolkata'
        )

        if cookies:
            try:
                context.add_cookies(cookies)
            except Exception as e:
                emit_log(f"[WARN] Failed to inject cookies: {e}")

        context.add_init_script('''
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        ''')

        page = context.new_page()
        if Stealth:
            try:
                Stealth().apply_stealth_sync(page)
            except Exception as e:
                emit_log(f"[WARN] Stealth application note: {e}")

        try:
            emit_progress(1, 5, 20, "Step 1/5: Loading OlaMovies link & Human Check...")
            page.goto(args.url, wait_until='domcontentloaded', timeout=30000)
            ok, next_link = solve_slider(page)
            if not ok:
                emit_result(False, error=next_link or "Failed slider verification")
                browser.close()
                return 1

            if next_link and next_link.startswith('http'):
                page.goto(next_link, wait_until='domcontentloaded', timeout=30000)

            emit_progress(2, 5, 40, "Step 2/5: Bypassing shortener Turnstile captcha...")
            solve_turnstile(page)

            emit_progress(3, 5, 60, "Step 3/5: Waiting Ad step 1 timer (15 seconds)...")
            solve_ad_timer_step(page, 3)

            emit_progress(4, 5, 80, "Step 4/5: Waiting Ad step 2 timer (15 seconds)...")
            solve_ad_timer_step(page, 4)

            emit_progress(5, 5, 95, "Step 5/5: Resolving OM DRIVE Direct Cloud Stream...")
            success, final_url, title, size_or_err = extract_om_drive(page)

            if success and final_url:
                emit_progress(5, 5, 100, "Successfully resolved Direct Cloud Stream!")
                emit_result(True, stream_url=final_url, filename=title, filesize=size_or_err)
                browser.close()
                return 0
            else:
                emit_result(False, error=size_or_err or "Failed to extract direct stream URL from OM Drive")
                browser.close()
                return 1

        except Exception as e:
            emit_log(f"[FATAL ERROR] {e}")
            if args.debug:
                try:
                    page.screenshot(path='/tmp/olamovies_error.png')
                    emit_log("Saved debug screenshot to /tmp/olamovies_error.png")
                except Exception:
                    pass
            emit_result(False, error=str(e))
            browser.close()
            return 1


if __name__ == "__main__":
    sys.exit(main())
