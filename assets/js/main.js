(async function () {
  'use strict';

  // Helper to enforce Vimeo params while preserving any existing ones
  function buildVimeoUrl(base) {
    try {
      const url = new URL(base);
      const p = url.searchParams;
      p.set('autoplay', '1');
      p.set('muted', '1');
      p.set('loop', '1');
      p.set('background', '1'); // hides controls + enforces autoplay/mute/loop
      url.search = p.toString();
      return url.toString();
    } catch {
      const sep = base.includes('?') ? '&' : '?';
      return base + sep + 'autoplay=1&muted=1&loop=1&background=1';
    }
  }

  // Load manifest with cache-bust
  let manifest;
  try {
    const res = await fetch(`./assets/js/manifest.json?ts=${Date.now()}`, { cache: 'no-store' });
    manifest = await res.json();
    if (!manifest || !Array.isArray(manifest.clips)) return;
  } catch (_) { return; }

  const reel = document.getElementById('reel');
  reel.innerHTML = '';

  // Build DOM from manifest
  const clips = manifest.clips.map((c, i) => {
    const wrap = document.createElement('section');
    wrap.className = 'clip';
    if (typeof c.overlap === 'number' && i > 0) wrap.style.marginTop = `${c.overlap}px`;
    wrap.dataset.speed = String(c.parallax || 0);

    const frame = document.createElement('div');
    frame.className = 'frame';
    if (c.aspect && typeof c.aspect === 'number') frame.style.aspectRatio = `${c.aspect} / 1`;

    const iframe = document.createElement('iframe');
    iframe.src = buildVimeoUrl(c.embedUrl);
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframe.setAttribute('title', c.title || 'video');

    frame.appendChild(iframe);
    wrap.appendChild(frame);
    reel.appendChild(wrap);
    return wrap;
  });

  // Subtle per-clip parallax
  let ticking = false;
  function applyParallax() {
    const y = window.scrollY || 0;
    for (const el of clips) {
      const s = parseFloat(el.dataset.speed || '0') || 0;
      if (s !== 0) el.style.transform = `translateY(${y * s}px)`;
    }
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(applyParallax); }
  }, { passive: true });
  applyParallax();

  // Background audio: robust click-to-start
  let audioStarted = false, audio;
  function ensureAudio() {
    if (!audio) {
      audio = new Audio('./assets/audio/bg.mp3');
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = 1.0;
    }
    return audio;
  }
  async function startAudioOnce() {
    if (audioStarted) return;
    audioStarted = true;
    const a = ensureAudio();
    try { await a.play(); }
    catch { try { a.load(); setTimeout(() => a.play().catch(()=>{}), 60); } catch {}
    }
  }
  ['click','pointerdown','touchstart','keydown'].forEach(ev =>
    window.addEventListener(ev, startAudioOnce, { once: true, passive: true })
  );
})();