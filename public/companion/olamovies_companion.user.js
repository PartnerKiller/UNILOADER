// ==UserScript==
// @name         Sakura OlaMovies Cloud Hopper & Auto-Downloader
// @namespace    https://jav.nazuna.dpdns.org/
// @version      1.1.0
// @description  Automates OlaMovies slider, ad timers, Turnstile, and OM Drive, then sends direct cloud streams straight to Sakura Universal Downloader!
// @author       Universal Downloader Suite
// @match        *://*.olamovies.mov/*
// @match        *://*.olamovies.dad/*
// @match        *://links.olamovies.mov/*
// @match        *://links.ol-am.top/*
// @match        *://*.ol-am.top/*
// @match        *://paybase.olamovies.mov/*
// @match        *://*.srnky.com/*
// @match        *://*.financeehelp.com/*
// @match        *://*.techmags.net/*
// @match        *://drive.olamovies.download/*
// @connect      jav.nazuna.dpdns.org
// @connect      192.168.0.10
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const SAKURA_URL = 'https://jav.nazuna.dpdns.org';
  const SAKURA_LOCAL_URL = 'http://192.168.0.10:3050';

  // Inject sleek HUD notification
  function showHud(msg, type = 'info') {
    let hud = document.getElementById('sakura-hopper-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'sakura-hopper-hud';
      hud.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: linear-gradient(135deg, #1e1b4b, #311042);
        color: #f8fafc;
        padding: 14px 20px;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13.5px;
        font-weight: 600;
        z-index: 999999;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 0 1px rgba(236,72,153,0.3);
        display: flex;
        align-items: center;
        gap: 10px;
        animation: sakuraFadeIn 0.3s ease;
      `;
      document.body.appendChild(hud);
    }
    const icon = type === 'success' ? '⚡' : (type === 'warn' ? '⚠️' : '🌸');
    hud.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  }

  const hostname = window.location.hostname;
  const pathname = window.location.pathname;

  // 1. links.olamovies.mov & links.ol-am.top
  if (hostname.includes('links.olamovies.mov') || hostname.includes('ol-am.top') || hostname.includes('olamovies')) {
    showHud('Sakura Hopper: Checking OlaMovies verification...');

    // Check if login needed
    const checkLogin = setInterval(() => {
      const loginBtn = Array.from(document.querySelectorAll('a, button')).find(el => el.innerText && el.innerText.includes('Login to Continue'));
      if (loginBtn) {
        showHud('Please complete Google Sign-in to unlock link', 'warn');
        clearInterval(checkLogin);
      }
    }, 1000);

    // Auto-solve slider
    const checkSlider = setInterval(() => {
      const handle = document.querySelector('.slider-handle') || 
                     document.querySelector('[role="slider"]') ||
                     Array.from(document.querySelectorAll('div, span, button')).find(e => e.innerText && e.innerText.includes('->'));
      const marker = document.querySelector('.slider-marker') || 
                     document.querySelector('.marker') || 
                     document.querySelector('.target-circle') ||
                     Array.from(document.querySelectorAll('div, span')).find(e => e.className && (e.className.includes('marker') || e.className.includes('circle')));

      if (handle && marker) {
        clearInterval(checkSlider);
        clearInterval(checkLogin);
        showHud('Sakura Hopper: Auto-sliding Human Check...');

        const hRect = handle.getBoundingClientRect();
        const mRect = marker.getBoundingClientRect();

        const startX = hRect.x + hRect.width / 2;
        const startY = hRect.y + hRect.height / 2;
        const targetX = mRect.x + mRect.width / 2;
        const targetY = mRect.y + mRect.height / 2;

        const downEvent = new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY });
        handle.dispatchEvent(downEvent);

        let curStep = 0;
        const totalSteps = 12;
        const interval = setInterval(() => {
          curStep++;
          const curX = startX + (targetX - startX) * (curStep / totalSteps);
          const curY = startY + (targetY - startY) * (curStep / totalSteps);
          const moveEvent = new MouseEvent('mousemove', { bubbles: true, clientX: curX, clientY: curY });
          window.dispatchEvent(moveEvent);

          if (curStep >= totalSteps) {
            clearInterval(interval);
            const upEvent = new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY });
            window.dispatchEvent(upEvent);

            setTimeout(() => {
              const verifyBtn = Array.from(document.querySelectorAll('button, a')).find(el => el.innerText && el.innerText.includes('Verify to generate link'));
              if (verifyBtn) {
                verifyBtn.click();
                showHud('Verified! Waiting for shortener link...');
              }
            }, 800);
          }
        }, 25);
      }
    }, 500);

    // Watch for generated destination button (srnky.com)
    const checkDest = setInterval(() => {
      const destBtn = Array.from(document.querySelectorAll('a, button')).find(el => {
        const txt = (el.innerText || '').toLowerCase();
        const href = el.getAttribute('href') || '';
        return txt.includes('srnky.com') || href.includes('srnky.com');
      });
      if (destBtn) {
        clearInterval(checkDest);
        showHud('Redirecting to shortener...', 'success');
        const href = destBtn.getAttribute('href');
        if (href) {
          window.location.href = href;
        } else {
          destBtn.click();
        }
      }
    }, 500);
  }

  // 2. srnky.com (Shortener Turnstile & Continue)
  if (hostname.includes('srnky.com')) {
    showHud('Sakura Hopper: Checking shortener captcha...');
    const checkCont = setInterval(() => {
      const contBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"]')).find(el => {
        const val = (el.innerText || el.value || '').trim().toLowerCase();
        return val === 'continue' || val.includes('click here to continue');
      });
      if (contBtn && contBtn.offsetParent !== null && !contBtn.disabled) {
        clearInterval(checkCont);
        showHud('Advancing to ad stage...', 'success');
        contBtn.click();
      }
    }, 800);
  }

  // 3. financeehelp.com & techmags.net (15s Ad Countdown Pages)
  if (hostname.includes('financeehelp.com') || hostname.includes('techmags.net')) {
    showHud('Sakura Hopper: Processing ad timer...');

    // Auto-click Continue / #startButton
    setTimeout(() => {
      const startBtn = document.getElementById('startButton') ||
                       Array.from(document.querySelectorAll('button, a')).find(el => {
                         const txt = (el.innerText || '').trim().toLowerCase();
                         return txt === 'continue' || txt === 'continue...';
                       });
      if (startBtn) {
        startBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        startBtn.click();
        showHud('Timer activated: Waiting 15s countdown...');
      }
    }, 1000);

    // Watch for "Get Link" / #getmylink
    const checkGetLink = setInterval(() => {
      const getBtn = document.getElementById('getmylink') ||
                     Array.from(document.querySelectorAll('button, a')).find(el => {
                       const txt = (el.innerText || '').trim().toLowerCase();
                       return txt === 'get link' || txt.includes('get link');
                     });
      if (getBtn && getBtn.offsetParent !== null && !getBtn.disabled) {
        clearInterval(checkGetLink);
        showHud('Advancing to next link...', 'success');
        getBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        getBtn.click();
      }
    }, 800);
  }

  // 4. drive.olamovies.download (OM DRIVE direct link extraction)
  if (hostname.includes('drive.olamovies.download')) {
    showHud('Sakura Hopper: OM DRIVE reached!');

    // Intercept workers.dev links
    function dispatchToSakura(streamUrl, movieTitle) {
      showHud('🚀 Sending to Sakura Universal Downloader (16x Turbo)...', 'success');

      if (typeof GM_setClipboard !== 'undefined') {
        GM_setClipboard(streamUrl);
      }

      const payload = {
        url: streamUrl,
        title: movieTitle || 'OlaMovies Media',
        folder: 'movies'
      };

      const sendReq = (endpoint) => {
        if (typeof GM_xmlhttpRequest !== 'undefined') {
          GM_xmlhttpRequest({
            method: 'POST',
            url: `${endpoint}/api/download`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload),
            onload: (res) => {
              showHud('✅ Download started on Sakura! Auto-closing in 3s...', 'success');
              setTimeout(() => {
                window.close();
              }, 3000);
            },
            onerror: () => {
              if (endpoint === SAKURA_URL) sendReq(SAKURA_LOCAL_URL);
            }
          });
        } else {
          fetch(`${endpoint}/api/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(() => {
            showHud('✅ Download started on Sakura! Auto-closing in 3s...', 'success');
            setTimeout(() => { window.close(); }, 3000);
          }).catch(() => {
            if (endpoint === SAKURA_URL) sendReq(SAKURA_LOCAL_URL);
          });
        }
      };

      sendReq(SAKURA_URL);
    }

    // Auto click "Direct Cloud Link"
    const checkDirect = setInterval(() => {
      const directBtn = Array.from(document.querySelectorAll('button, a')).find(el => {
        const txt = (el.innerText || '').toLowerCase();
        return txt.includes('direct cloud link');
      });

      if (directBtn) {
        clearInterval(checkDirect);
        showHud('Extracting Direct Cloud Link...');
        directBtn.click();

        // Watch for workers.dev URL in inputs or DOM
        const checkUrl = setInterval(() => {
          let foundUrl = null;
          const inputs = Array.from(document.querySelectorAll('input'));
          for (const inp of inputs) {
            if (inp.value && inp.value.includes('workers.dev/serve')) {
              foundUrl = inp.value;
              break;
            }
          }

          if (!foundUrl) {
            const links = Array.from(document.querySelectorAll('a[href*="workers.dev/serve"]'));
            if (links.length > 0) foundUrl = links[0].getAttribute('href');
          }

          if (foundUrl) {
            clearInterval(checkUrl);
            const titleEl = document.querySelector('h1, h2, h3, .movie-title, .file-name');
            const title = titleEl ? titleEl.innerText.trim() : 'OlaMovies Download';
            dispatchToSakura(foundUrl, title);
          }
        }, 500);
      }
    }, 800);
  }

})();
