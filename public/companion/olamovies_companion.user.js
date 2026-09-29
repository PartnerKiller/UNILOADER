// ==UserScript==
// @name         Sakura OlaMovies Cloud Hopper & Auto-Downloader
// @namespace    https://uniloader.dpdns.org/
// @version      1.3.0
// @description  Automates OlaMovies slider, ad timers, Turnstile, and OM Drive, then sends direct cloud streams straight to Sakura Universal Downloader!
// @author       Universal Downloader Suite
// @match        *://*.olamovies.mov/*
// @match        *://*.olamovies.dad/*
// @match        *://links.olamovies.mov/*
// @match        *://links.olamovies.*/*
// @match        *://links.ol-am.top/*
// @match        *://*.ol-am.top/*
// @match        *://paybase.olamovies.mov/*
// @match        *://*.srnky.com/*
// @match        *://*.financeehelp.com/*
// @match        *://*.techmags.net/*
// @match        *://drive.olamovies.download/*
// @connect      uniloader.dpdns.org
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

  const SAKURA_URL = 'https://uniloader.dpdns.org';
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
        z-index: 9999999;
        box-shadow: 0 10px 30px rgba(0,0,0,0.6), 0 0 0 1px rgba(236,72,153,0.4);
        display: flex;
        align-items: center;
        gap: 10px;
        transition: all 0.3s ease;
      `;
      document.body.appendChild(hud);
    }
    const icon = type === 'success' ? '⚡' : (type === 'warn' ? '⚠️' : '🌸');
    hud.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  }

  const hostname = window.location.hostname;

  // =========================================================================
  // GATE 1: links.olamovies.* & links.ol-am.top (Human Check Slider & Verification)
  // =========================================================================
  if (hostname.includes('links.olamovies') || hostname.includes('ol-am.top') || hostname.includes('olamovies')) {
    showHud('Sakura Hopper: Checking OlaMovies verification...');

    // A. Check for Google login requirement
    const checkLogin = setInterval(() => {
      const loginBtn = Array.from(document.querySelectorAll('a, button')).find(el => {
        const txt = el.innerText || '';
        return txt.includes('Login to Continue') || txt.includes('Continue with Google');
      });
      if (loginBtn) {
        showHud('Please click Google Sign-in to unlock link', 'warn');
        clearInterval(checkLogin);
      }
    }, 1000);

    // B. Watch for generated destination button (srnky.com) appearing at ANY time
    const checkDest = setInterval(() => {
      const destBtn = Array.from(document.querySelectorAll('a, button, div[role="button"]')).find(el => {
        const txt = (el.innerText || '').toLowerCase();
        const href = (el.getAttribute('href') || '').toLowerCase();
        return txt.includes('srnky.com') || href.includes('srnky.com') || href.includes('techmags') || href.includes('financeehelp');
      });
      if (destBtn) {
        clearInterval(checkDest);
        showHud('Redirecting to shortener...', 'success');
        const href = destBtn.getAttribute('href');
        if (href && href.startsWith('http')) {
          window.location.href = href;
        } else {
          destBtn.click();
        }
      }
    }, 300);

    // C. Watch for "Verify to generate link" button unlocked
    let verifyClicked = false;
    const checkVerifyBtn = setInterval(() => {
      if (verifyClicked) return;
      const verifyBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find(el => {
        return (el.innerText || '').toLowerCase().includes('verify to generate link');
      });
      if (verifyBtn) {
        const isDisabled = verifyBtn.disabled || 
                           verifyBtn.hasAttribute('disabled') ||
                           verifyBtn.classList.contains('disabled') || 
                           verifyBtn.classList.contains('cursor-not-allowed') || 
                           verifyBtn.classList.contains('opacity-50') ||
                           window.getComputedStyle(verifyBtn).cursor === 'not-allowed';
        if (!isDisabled) {
          verifyClicked = true;
          clearInterval(checkVerifyBtn);
          showHud('Unlocked! Generating shortener link...', 'success');
          verifyBtn.click();
        }
      }
    }, 150);

    // D. Auto-detect slider & simulate drag
    let dragAttempted = false;
    const checkSlider = setInterval(() => {
      if (dragAttempted || verifyClicked) return;

      // Find slider card
      const card = Array.from(document.querySelectorAll('div, section, main, form')).find(el => {
        const t = el.innerText || '';
        return (t.includes('Human check') || t.includes('Slide to the marker') || t.includes('HOLD & DRAG')) && el.children.length > 0;
      });
      if (!card) return;

      // Find handle: look for svg wrapper or orange element
      const allElements = Array.from(card.querySelectorAll('*'));
      let handle = null;
      const svg = card.querySelector('svg');
      if (svg) {
        let curr = svg.parentElement;
        while (curr && curr !== card) {
          if (curr.offsetWidth >= 20 && curr.offsetWidth <= 85) {
            handle = curr;
            break;
          }
          curr = curr.parentElement;
        }
      }
      if (!handle) {
        handle = allElements.find(el => {
          const bg = window.getComputedStyle(el).backgroundColor;
          return (bg.includes('rgb(255, 6') || bg.includes('rgb(239, 6') || bg.includes('rgb(249, 11') || bg.includes('rgb(255, 69')) && el.offsetWidth >= 20 && el.offsetWidth <= 85;
        });
      }

      // Find marker: round element (border-radius 50%)
      let marker = allElements.find(el => {
        if (el === handle || handle?.contains(el) || el.contains(handle)) return false;
        const s = window.getComputedStyle(el);
        const isRound = s.borderRadius.includes('50%') || s.borderRadius.includes('9999') || parseFloat(s.borderRadius) >= 8;
        return isRound && el.offsetWidth >= 10 && el.offsetWidth <= 50;
      });

      if (handle) {
        clearInterval(checkLogin);
        dragAttempted = true;

        const hRect = handle.getBoundingClientRect();
        const track = handle.parentElement || card;
        const tRect = track.getBoundingClientRect();

        let targetX, targetY;
        if (marker) {
          const mRect = marker.getBoundingClientRect();
          targetX = mRect.x + mRect.width / 2;
          targetY = mRect.y + mRect.height / 2;
        } else {
          targetX = tRect.x + tRect.width * 0.55;
          targetY = hRect.y + hRect.height / 2;
        }

        const startX = hRect.x + hRect.width / 2;
        const startY = hRect.y + hRect.height / 2;

        showHud('Sakura Hopper: Auto-sliding Human Check...');

        // Comprehensive multi-event drag
        const pDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: startX, clientY: startY, pageX: startX, pageY: startY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
        const mDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, clientX: startX, clientY: startY, pageX: startX, pageY: startY, button: 0, buttons: 1, which: 1 });

        handle.dispatchEvent(pDown);
        handle.dispatchEvent(mDown);
        track.dispatchEvent(pDown);
        track.dispatchEvent(mDown);

        const steps = 18;
        let step = 0;
        const dragLoop = setInterval(() => {
          step++;
          const progress = step / steps;
          const curX = startX + (targetX - startX) * progress;
          const curY = startY + (targetY - startY) * progress;

          const pMove = new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, clientX: curX, clientY: curY, pageX: curX, pageY: curY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
          const mMove = new MouseEvent('mousemove', { bubbles: true, cancelable: true, composed: true, clientX: curX, clientY: curY, pageX: curX, pageY: curY, button: 0, buttons: 1, which: 1 });

          handle.dispatchEvent(pMove);
          track.dispatchEvent(pMove);
          document.dispatchEvent(pMove);
          window.dispatchEvent(pMove);

          handle.dispatchEvent(mMove);
          track.dispatchEvent(mMove);
          document.dispatchEvent(mMove);
          window.dispatchEvent(mMove);

          if (step >= steps) {
            clearInterval(dragLoop);
            const pUp = new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, clientX: targetX, clientY: targetY, pageX: targetX, pageY: targetY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 });
            const mUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, clientX: targetX, clientY: targetY, pageX: targetX, pageY: targetY, button: 0, buttons: 0, which: 1 });

            handle.dispatchEvent(pUp);
            track.dispatchEvent(pUp);
            document.dispatchEvent(pUp);
            window.dispatchEvent(pUp);

            handle.dispatchEvent(mUp);
            track.dispatchEvent(mUp);
            document.dispatchEvent(mUp);
            window.dispatchEvent(mUp);

            setTimeout(() => {
              const verifyBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find(el => {
                return (el.innerText || '').toLowerCase().includes('verify to generate link');
              });
              if (verifyBtn && !verifyClicked) {
                verifyBtn.click();
              }
            }, 500);
          }
        }, 25);

        // Fallback prompt: if auto-drag is blocked by isTrusted, clearly guide the user
        setTimeout(() => {
          if (!verifyClicked) {
            handle.style.boxShadow = '0 0 16px 4px #ec4899';
            showHud('👉 Slide orange box into circle marker', 'warn');
          }
        }, 1800);
      }
    }, 400);
  }

  // =========================================================================
  // GATE 2: srnky.com (Shortener Turnstile & Continue)
  // =========================================================================
  if (hostname.includes('srnky.com')) {
    showHud('Sakura Hopper: Checking shortener captcha...');
    const checkCont = setInterval(() => {
      const contBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]')).find(el => {
        const val = (el.innerText || el.value || '').trim().toLowerCase();
        return val === 'continue' || val.includes('click here to continue');
      });
      if (contBtn && contBtn.offsetParent !== null && !contBtn.disabled) {
        clearInterval(checkCont);
        showHud('Advancing to ad stage...', 'success');
        contBtn.click();
      }
    }, 500);
  }

  // =========================================================================
  // GATES 3 & 4: financeehelp.com & techmags.net (15s Countdown Timers)
  // =========================================================================
  if (hostname.includes('financeehelp.com') || hostname.includes('techmags.net')) {
    showHud('Sakura Hopper: Processing ad timer...');

    // Auto-click Continue / #startButton
    const checkStart = setInterval(() => {
      const startBtn = document.getElementById('startButton') ||
                       Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
                         const txt = (el.innerText || '').trim().toLowerCase();
                         return txt === 'continue' || txt === 'continue...';
                       });
      if (startBtn && startBtn.offsetParent !== null && !startBtn.disabled) {
        clearInterval(checkStart);
        startBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        startBtn.click();
        showHud('Timer activated: Waiting 15s countdown...');
      }
    }, 500);

    // Watch for "Get Link" / #getmylink
    const checkGetLink = setInterval(() => {
      const getBtn = document.getElementById('getmylink') ||
                     Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
                       const txt = (el.innerText || '').trim().toLowerCase();
                       const href = (el.getAttribute('href') || '').toLowerCase();
                       return txt === 'get link' || txt.includes('get link') || href.includes('getmylink');
                     });
      if (getBtn && getBtn.offsetParent !== null && !getBtn.disabled) {
        clearInterval(checkGetLink);
        showHud('Advancing to next stage...', 'success');
        getBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const href = getBtn.getAttribute('href');
        if (href && href.startsWith('http')) {
          window.location.href = href;
        } else {
          getBtn.click();
        }
      }
    }, 500);
  }

  // =========================================================================
  // GATE 5: drive.olamovies.download (OM DRIVE Direct Cloud Stream)
  // =========================================================================
  if (hostname.includes('drive.olamovies.download')) {
    showHud('Sakura Hopper: OM DRIVE reached!');

    let streamCaptured = false;

    function dispatchToSakura(streamUrl, movieTitle) {
      if (streamCaptured) return;
      streamCaptured = true;

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
              setTimeout(() => { window.close(); }, 3000);
            },
            onerror: () => {
              if (endpoint === SAKURA_URL) {
                sendReq(SAKURA_LOCAL_URL);
              }
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
            if (endpoint === SAKURA_URL) {
              sendReq(SAKURA_LOCAL_URL);
            }
          });
        }
      };

      sendReq(SAKURA_URL);
    }

    // Intercept network responses (fetch & XHR) for instant capture
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const clone = resp.clone();
        clone.json().then(data => {
          const str = JSON.stringify(data);
          const match = str.match(/https?:\/\/[^\s"'<>]+workers\.dev\/serve\?t=[^\s"'<>]+/);
          if (match) {
            const titleEl = document.querySelector('h1, h2, h3, .movie-title, .file-name');
            const title = titleEl ? titleEl.innerText.trim() : 'OlaMovies Media';
            dispatchToSakura(match[0], title);
          }
        }).catch(() => {});
      } catch (e) {}
      return resp;
    };

    // Auto-click "Direct Cloud Link"
    const checkDirect = setInterval(() => {
      const directBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find(el => {
        const txt = (el.innerText || '').toLowerCase();
        return txt.includes('direct cloud link');
      });

      if (directBtn) {
        clearInterval(checkDirect);
        showHud('Extracting Direct Cloud Link...');
        directBtn.click();

        // Watch for workers.dev URL anywhere in the DOM (inputs, links, or text nodes)
        const checkUrl = setInterval(() => {
          if (streamCaptured) {
            clearInterval(checkUrl);
            return;
          }

          let foundUrl = null;

          // 1. Check all anchor tags
          const links = Array.from(document.querySelectorAll('a[href*="workers.dev"]'));
          if (links.length > 0) foundUrl = links[0].getAttribute('href');

          // 2. Check all inputs
          if (!foundUrl) {
            const inputs = Array.from(document.querySelectorAll('input, textarea'));
            for (const inp of inputs) {
              if (inp.value && inp.value.includes('workers.dev/serve')) {
                foundUrl = inp.value;
                break;
              }
            }
          }

          // 3. Check text content of all elements
          if (!foundUrl) {
            const allElements = Array.from(document.querySelectorAll('*'));
            for (const el of allElements) {
              if (el.children.length === 0 && (el.innerText || '').includes('workers.dev/serve')) {
                const m = el.innerText.match(/https?:\/\/[^\s"'<>]+workers\.dev\/serve\?t=[^\s"'<>]+/);
                if (m) {
                  foundUrl = m[0];
                  break;
                }
              }
            }
          }

          if (foundUrl) {
            clearInterval(checkUrl);
            const titleEl = document.querySelector('h1, h2, h3, .movie-title, .file-name');
            const title = titleEl ? titleEl.innerText.trim() : 'OlaMovies Media';
            dispatchToSakura(foundUrl, title);
          }
        }, 300);
      }
    }, 500);
  }

})();
