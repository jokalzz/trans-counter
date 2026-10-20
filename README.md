# Traffic Count Studio — Vercel-only frontend with hevc.js

A browser-only manual video counting website built with React, Vite and TypeScript. It can be hosted as a static site on Vercel. No database or backend is required for manual class counts and CSV export.

## Important HEVC limitation

`hevc.js` is integrated for **HLS fMP4 (`.m3u8`) and MPEG-DASH (`.mpd`) streams**. It decodes HEVC with WebAssembly and transcodes to H.264 in the browser when native playback is unavailable. It is **not a drop-in player for arbitrary local `.mp4`, `.mov`, `.mkv`, or Google Drive sharing links**.

- Local file: uses the browser/device's native decoder. The video is not uploaded.
- HLS tab: enter a real `.m3u8` manifest URL whose segments are accessible to the browser and have suitable CORS headers.
- DASH tab: enter a real `.mpd` manifest URL with accessible segments and suitable CORS headers.
- Direct URL tab: attempts native playback only; ordinary Google Drive share links may not work because they are not direct media URLs and can require authentication or block cross-origin playback.

If you need every arbitrary local HEVC MP4/MOV to play on every browser, this Vercel-only version cannot guarantee that. The options are a media preparation step that creates HLS/DASH fMP4, a server-side FFmpeg converter, or native HEVC support on the user's device. Browser-side whole-file transcoding is not recommended for 5–10 GB videos.

## Run locally (Windows PowerShell)

1. Install Node.js 20.19+ (or current compatible LTS) and Git if needed.
2. Extract this folder and open it in VS Code.
3. In a terminal opened at this folder, run:

```powershell
npm install
npm run dev
```

4. Open the local URL shown by Vite, usually `http://localhost:5173`.

The `postinstall` script copies the hevc.js worker and WASM assets into `public/hevc`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, select **Add New → Project** and import the repository.
3. Framework preset: **Vite**. Root directory: repository root (this folder).
4. Build command: `npm run build`. Output directory: `dist`. Install command: `npm install`.
5. Deploy. The included `vercel.json` contains these settings.

No environment variables are required for the basic local counter.

## How the counter works

- Create any number of custom classes (up to 30) and apply their names.
- Use `+1` and `−1` while the video plays.
- Interval changes follow video time, not wall-clock time.
- Export all rows or batches as CSV. Counts are kept in browser memory; download the CSV before refreshing or closing the tab.

## HEVC.js sources

- https://github.com/lid-labs/hevc.js
- https://www.hevcjs.dev/

The app pins the player plugin dependencies and copies the WASM/worker assets locally for deployment. Browser fallback requires WebAssembly, HTTPS/localhost, and a supported WebCodecs H.264 encoder. For HLS/DASH sources, the media host must permit cross-origin access.
