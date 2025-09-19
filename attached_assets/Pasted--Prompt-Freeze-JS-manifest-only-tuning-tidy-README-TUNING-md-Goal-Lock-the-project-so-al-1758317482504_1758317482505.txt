✅ Prompt — “Freeze JS (manifest-only tuning) + tidy + README_TUNING.md”
Goal: Lock the project so all future adjustments happen via assets/js/manifest.json only. No visual or behavioral changes.

Do ONLY the following:

FILES:
- assets/js/main.js
- assets/js/manifest.json
- index.html (verify cache-bust only; do not restructure)
- README_TUNING.md (new)

1) Wire ALL tuning knobs to manifest.json (with safe defaults = current behavior):
   Global keys (top-level manifest):
     - parallaxGain
     - desktopSmooth
     - mobileSmooth
     - maxStepPx           // if used by our smoothing/clamp logic
   Per-clip keys (inside each video item):
     - speed
     - overlapPx
     - offsetPx
     - stabilizePx         // desktop-only per-clip clamp; 0 or missing = disabled

   Mobile reliability keys (IF they already exist — do not introduce new ones):
     - mobileMaxActive
     - mobilePrewarmAhead
     - mobileRetryDelaysMs
     - mobileQuality

   Ensure main.js reads all of the above from manifest, with defaults equal to the current live values so behavior is unchanged.

2) Remove hardcoded/duplicate paths and dead constants:
   - Delete any remaining LERP_DESKTOP, LERP_MOBILE, window.__PARALLAX_GAIN, MAX_STEP_PX, or similar hardcoded values that are now manifest-driven.
   - Remove stale debug logs and unused helpers.
   - Keep the dt-normalized animation loop and current logic intact.

3) Confirm cache-busting is unified:
   - index.html must append ?v=<manifest.rev> (or ?rev=<manifest.rev>) to both CSS and main.js includes.
   - If already correct, leave as-is. Do not add libraries or change structure.

4) Add README_TUNING.md (project root) with:
   - “How to edit” quickstart:
       1) Open assets/js/manifest.json
       2) Change numbers (global or per-clip)
       3) Increment "rev" by +1
       4) Refresh site
   - What each knob does + safe ranges:
       - desktopSmooth: 0.10–0.14
       - mobileSmooth: 0.12–0.20
       - parallaxGain: 0.90–1.12
       - stabilizePx (desktop per-clip): 6–12 (0 = off)
       - offsetPx: adjust in ±10–30px steps
       - overlapPx: small positive values for subtle overlap
       - (If present) mobileMaxActive (2–4), mobilePrewarmAhead (1–3), mobileQuality (540–720)
   - Note: always stage on videowall.zholloran.com, then publish.

5) Bump manifest "rev" by +1 (cache-bust) after edits.

6) Do NOT change layout, watermark, audio overlay, Vimeo params, parallax math targets, or mobile/desktop behavior. This is a wiring/tidy/doc step only.

Reply EXACTLY:
"STEP DONE — JS frozen (manifest-only). Files touched: [list]. README_TUNING.md added. rev++."
