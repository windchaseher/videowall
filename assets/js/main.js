(async function () {
  'use strict';

  const isSmall = window.matchMedia('(max-width: 768px)').matches;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Helper to enforce Vimeo params while preserving any existing ones
  function buildVimeoUrl(base) {
    try {
      const url = new URL(base);
      const p = url.searchParams;
      p.set('autoplay','1'); p.set('muted','1'); p.set('loop','1'); p.set('background','1');
      url.search = p.toString();
      return url.toString();
    } catch {
      return base + (base.includes('?') ? '&' : '?') + 'autoplay=1&muted=1&loop=1&background=1';
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
    let ov = (typeof c.overlap === 'number' ? c.overlap : -10);
    ov = Math.max(isSmall ? -8 : -12, Math.min(isSmall ? -4 : -6, ov));
    if (i > 0) wrap.style.marginTop = `${ov}px`;
    wrap.style.marginBottom = '4px';
    
    const baseSpeed = Number(c.parallax || 0);
    const speed = (isSmall || prefersReduced) ? baseSpeed * 0.6 : baseSpeed;
    wrap.dataset.speed = String(speed);

    const frame = document.createElement('div');
    frame.className = 'frame';
    if (c.aspect && typeof c.aspect === 'number') frame.style.aspectRatio = `${c.aspect} / 1`;
    const finalUrl = buildVimeoUrl(c.embedUrl);
    frame.dataset.embed = finalUrl; // defer actual iframe creation
    frame.style.background = '#000';
    wrap.appendChild(frame);
    
    reel.appendChild(wrap);
    return wrap;
  });

  // --- Lazy embed stabilized ---
  const frames = Array.from(document.querySelectorAll('.frame'));
  const maxConcurrentLoads = isSmall ? 2 : 8;
  const rootMarginY         = isSmall ? '1200px' : '2400px';

  let inFlight = 0;
  const queue = [];
  const mounted = new Set(); // track frames that currently have an iframe

  function mountIframe(frame) {
    if (frame.dataset.mounted === '1') return;
    const src = frame.dataset.embed;
    if (!src) return;

    // Prevent double-queueing
    if (queue.includes(frame)) return;

    // Desktop-only recycling
    if (!isSmall) {
      const maxMountedIframes = 9;
      if (mounted.size >= maxMountedIframes) {
        unmountFarthest();
      }
    }

    if (inFlight >= maxConcurrentLoads) {
      queue.push(frame);
      return;
    }
    inFlight++;

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframe.setAttribute('loading', 'lazy');
    Object.assign(iframe.style, {
      border:'0', position:'absolute', inset:'0', width:'100%', height:'100%'
    });

    frame.style.position = 'relative';
    frame.appendChild(iframe);
    frame.dataset.mounted = '1';
    mounted.add(frame);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      const next = queue.shift();
      if (next) mountIframe(next);
    };

    const t = setTimeout(settle, 8000);
    iframe.addEventListener('load', () => { clearTimeout(t); settle(); }, { once: true });
  }

  function unmountIframe(frame) {
    if (!isSmall) {
      if (frame.dataset.mounted !== '1') return;
      const iframe = frame.querySelector('iframe');
      if (iframe) iframe.remove();
      frame.dataset.mounted = '0';
      mounted.delete(frame);
      // keep placeholder
    }
  }

  function unmountFarthest() {
    if (!isSmall) {
      if (!mounted.size) return;
      // Unmount the frame whose center is farthest from viewport center
      const viewportCenter = window.scrollY + window.innerHeight / 2;
      let worst = null, worstDist = -1;
      mounted.forEach(f => {
        const r = f.getBoundingClientRect();
        const center = window.scrollY + r.top + r.height / 2;
        const d = Math.abs(center - viewportCenter);
        if (d > worstDist) { worstDist = d; worst = f; }
      });
      if (worst) unmountIframe(worst);
    }
  }

  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            mountIframe(e.target);
            // Keep observing; do NOT unobserve here
          } else {
            // Desktop-only recycling (optional)
            if (!isSmall) {
              // If far off-screen, you may unmount here as before; otherwise do nothing
              const r = e.target.getBoundingClientRect();
              const offscreen = r.top > window.innerHeight + 2 * parseInt(rootMarginY) ||
                                r.bottom < -2 * parseInt(rootMarginY);
              if (offscreen) unmountIframe(e.target);
            }
          }
        });
      }, { root: null, rootMargin: `${rootMarginY} 0px`, threshold: 0.01 })
    : null;

  // Ensure at least one frame mounts immediately on EVERY device
  frames.forEach((f, idx) => {
    if (idx === 0) mountIframe(f);        // eager mount the first clip always
  });

  frames.forEach(f => { if (io) io.observe(f); else mountIframe(f); });

  // Subtle per-clip parallax
  let ticking = false;
  function applyParallax() {
    const viewportCenter = window.innerHeight / 2;
    // Use a cached NodeList each frame to avoid layout thrash
    document.querySelectorAll('.clip').forEach(el => {
      const s = parseFloat(el.dataset.speed || '0') || 0;
      if (!s) { el.style.transform = ''; return; }
      const rect = el.getBoundingClientRect();
      const elCenter = rect.top + rect.height / 2;
      const delta = viewportCenter - elCenter; // positive when element is below center
      el.style.transform = `translateY(${delta * s}px)`;
    });
    ticking = false;
  }
  // Keep the same scroll listener but also listen to resize and load:
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(applyParallax); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('load', onScroll);
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