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

  // ---- STAGGERED EAGER LOAD (burst + timed batches) ----
  const frames = Array.from(document.querySelectorAll('.frame'));

  // Tunables
  const initialBurstCount   = isSmall ? 6 : 8;  // load these immediately
  const batchSize           = isSmall ? 3 : 4;  // then load this many per tick
  const tickMs              = 700;              // time between batches (ms)
  const maxConcurrentLoads  = isSmall ? 3 : 10; // cap simultaneous iframes
  const loadTimeoutMs       = 7000;             // consider a load "settled" after this

  let inFlight = 0;
  let nextIndex = initialBurstCount; // after the burst, continue here
  let batchTimer = null;

  // Mount one frame if allowed by concurrency
  function mountIframe(frame) {
    if (!frame || frame.dataset.mounted === '1') return;
    const src = frame.dataset.embed;
    if (!src) return;

    if (inFlight >= maxConcurrentLoads) return; // caller will retry next tick

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

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
    };

    const t = setTimeout(settle, loadTimeoutMs);
    iframe.addEventListener('load', () => { clearTimeout(t); settle(); }, { once: true });
  }

  // Initial burst (top-of-page feels instant)
  frames.slice(0, initialBurstCount).forEach(f => mountIframe(f));

  // Timed batches keep loading even without scrolling
  function loadNextBatch() {
    // If everything is mounted, stop.
    if (nextIndex >= frames.length) {
      if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
      return;
    }

    let mountedThisTick = 0;
    // Try to mount up to batchSize frames this tick, respecting concurrency
    while (mountedThisTick < batchSize && nextIndex < frames.length) {
      const f = frames[nextIndex];
      const beforeInFlight = inFlight;
      mountIframe(f);
      // Only count it if we actually started it (inFlight increased)
      if (inFlight > beforeInFlight) {
        mountedThisTick++;
        nextIndex++;
      } else {
        // Concurrency full; break and let next tick try again
        break;
      }
    }
  }

  // Start the interval; also warm on idle to feel snappier
  if (!batchTimer) batchTimer = setInterval(loadNextBatch, tickMs);
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => loadNextBatch(), { timeout: tickMs });
  }

  // Last-resort safety: after ~12s, force-mount anything left (ignores concurrency)
  setTimeout(() => {
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].dataset.mounted !== '1') {
        // Try with cap; if still blocked, attach directly
        const before = inFlight;
        mountIframe(frames[i]);
        if (inFlight === before) {
          const iframe = document.createElement('iframe');
          iframe.src = frames[i].dataset.embed;
          iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
          iframe.setAttribute('loading', 'lazy');
          Object.assign(iframe.style, {
            border:'0', position:'absolute', inset:'0', width:'100%', height:'100%'
          });
          frames[i].style.position = 'relative';
          frames[i].appendChild(iframe);
          frames[i].dataset.mounted = '1';
        }
      }
    }
  }, 12000);

  // Optional: simple diagnostic in console
  window.reportVimeoMounts = () => {
    const total = frames.length;
    const mounted = frames.filter(f => f.dataset.mounted === '1').length;
    return { total, mounted, inFlight };
  };

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