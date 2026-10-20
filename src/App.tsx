import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import type Hls from 'hls.js';
import './styles.css';

type SourceMode = 'none' | 'local' | 'direct' | 'hls' | 'dash';
type IntervalRow = {
  index: number;
  start: number;
  end: number;
  counts: Record<string, number>;
};

type PlayerNotice = { kind: 'info' | 'success' | 'warning' | 'error'; text: string };

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const slug = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'traffic-count';

function normalizeDriveUrl(input: string): string {
  const trimmed = input.trim();
  const fileId = trimmed.match(/drive\.google\.com\/file\/d\/([^/]+)/)?.[1]
    ?? trimmed.match(/[?&]id=([^&]+)/)?.[1];
  if (fileId && /drive\.google\.com/.test(trimmed)) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  }
  return trimmed;
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<any>(null);
  const activeIntervalRef = useRef(0);
  const countsRef = useRef<Record<string, number>>({});
  const rowsRef = useRef<IntervalRow[]>([]);
  const classesRef = useRef<string[]>([]);
  const intervalSecondsRef = useRef(60);

  const [sourceMode, setSourceMode] = useState<SourceMode>('none');
  const [sourceUrl, setSourceUrl] = useState('');
  const [currentFileName, setCurrentFileName] = useState('');
  const [currentFileSize, setCurrentFileSize] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState<PlayerNotice>({ kind: 'info', text: 'Pilih video lokal, atau masukkan URL HLS/DASH untuk menguji HEVC.js.' });
  const [playerReady, setPlayerReady] = useState(false);
  const [nativePlaybackError, setNativePlaybackError] = useState(false);
  const [speed, setSpeed] = useState(1);

  // User-defined classes. Starts with zero classes by design.
  const [classCountInput, setClassCountInput] = useState('0');
  const [nameDrafts, setNameDrafts] = useState<string[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<IntervalRow[]>([]);
  const [activeInterval, setActiveInterval] = useState(0);
  const [intervalMinutesInput, setIntervalMinutesInput] = useState('1');
  const [appliedIntervalMinutes, setAppliedIntervalMinutes] = useState(1);
  const [batchSizeInput, setBatchSizeInput] = useState('5');
  const [batchSize, setBatchSize] = useState(5);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => { countsRef.current = counts; }, [counts]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => { classesRef.current = classes; }, [classes]);
  useEffect(() => { intervalSecondsRef.current = Math.max(1, appliedIntervalMinutes * 60); }, [appliedIntervalMinutes]);

  const zeroCounts = useCallback((names = classesRef.current) =>
    Object.fromEntries(names.map((name) => [name, 0])), []);

  const setRowsBoth = useCallback((next: IntervalRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const setCountsBoth = useCallback((next: Record<string, number>) => {
    countsRef.current = next;
    setCounts(next);
  }, []);

  const resetSession = useCallback((names = classesRef.current) => {
    setRowsBoth([]);
    setCountsBoth(zeroCounts(names));
    activeIntervalRef.current = 0;
    setActiveInterval(0);
    setCurrentTime(videoRef.current?.currentTime ?? 0);
  }, [setRowsBoth, setCountsBoth, zeroCounts]);

  const cleanupPlayers = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (dashRef.current) {
      try { dashRef.current.reset(); } catch { /* ignore cleanup errors */ }
      dashRef.current = null;
    }
  }, []);

  // Each source type has its own playback path. hevc.js is used for HLS/DASH
  // streams; local MP4/MOV files use the browser's native file decoder.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    cleanupPlayers();
    setPlayerReady(false);
    setNativePlaybackError(false);
    video.pause();
    video.removeAttribute('src');
    video.load();

    const setup = async () => {
      if (sourceMode === 'none' || !sourceUrl) return;

      if (sourceMode === 'local' || sourceMode === 'direct') {
        video.src = sourceUrl;
        video.load();
        setNotice({
          kind: 'info',
          text: sourceMode === 'local'
            ? 'File diputar langsung dari komputer. File tidak diunggah ke server.'
            : 'Mencoba pemutaran langsung. Untuk Google Drive, file harus bisa diakses publik dan mendukung pemutaran media.',
        });
        return;
      }

      if (sourceMode === 'hls') {
        setNotice({ kind: 'info', text: 'Menyiapkan HLS + hevc.js. Segmen video diproses di browser, bukan di server Vercel.' });
        try {
          const [{ default: HlsClass }, { attachHevcSupport }] = await Promise.all([
            import('hls.js'),
            import('@hevcjs/hlsjs-plugin'),
          ]);
          if (cancelled) return;
          const isMediaSourceAvailable = typeof MediaSource !== 'undefined';
          if (!HlsClass.isSupported() || !isMediaSourceAvailable) {
            // Safari may play HLS natively, but HEVC fallback may not be possible on every device.
            video.src = sourceUrl;
            video.load();
            setNotice({ kind: 'warning', text: 'hls.js tidak tersedia pada browser ini. Mencoba pemutar HLS bawaan browser; dukungan fallback HEVC bergantung pada perangkat.' });
            return;
          }
          const handle = await attachHevcSupport({ workerUrl: '/hevc/transcode-worker.js' });
          if (cancelled) return;
          const hls = new HlsClass({ preferManagedMediaSource: false });
          hlsRef.current = hls;
          handle.attachComputeAware(hls);
          hls.on(HlsClass.Events.ERROR, (_event, data) => {
            if (data.fatal && !cancelled) {
              setNotice({ kind: 'error', text: `HLS gagal diputar: ${data.details || data.type}. Pastikan URL adalah manifest .m3u8 fMP4, resource mengizinkan CORS, dan sumber tidak memerlukan login.` });
            }
          });
          hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
            if (!cancelled) setNotice({ kind: 'success', text: 'Manifest HLS terbaca. Jika browser tidak mendukung HEVC native, hevc.js akan mencoba transkode HEVC ke H.264 di browser.' });
          });
          hls.attachMedia(video);
          hls.on(HlsClass.Events.MEDIA_ATTACHED, () => {
            if (!cancelled) hls.loadSource(sourceUrl);
          });
        } catch (error) {
          if (!cancelled) setNotice({ kind: 'error', text: `Tidak bisa menyiapkan HEVC.js/HLS. ${error instanceof Error ? error.message : 'Periksa koneksi dan dependensi.'}` });
        }
        return;
      }

      if (sourceMode === 'dash') {
        setNotice({ kind: 'info', text: 'Menyiapkan MPEG-DASH + hevc.js. Segmen video diproses di browser.' });
        try {
          const [dashjs, { attachHevcSupport }] = await Promise.all([
            import('dashjs'),
            import('@hevcjs/dashjs-plugin'),
          ]);
          if (cancelled) return;
          const player = dashjs.MediaPlayer().create();
          dashRef.current = player;
          player.on('error', (event: any) => {
            if (!cancelled) setNotice({ kind: 'error', text: `DASH gagal diputar. ${event?.error?.message || 'Periksa manifest, CORS, dan akses segmen video.'}` });
          });
          await attachHevcSupport(player, { workerUrl: '/hevc/transcode-worker.js' });
          if (cancelled) { player.reset(); return; }
          player.initialize(video, sourceUrl, false);
          setNotice({ kind: 'success', text: 'DASH player siap. hevc.js akan menangani track HEVC yang sesuai bila fallback didukung browser.' });
        } catch (error) {
          if (!cancelled) setNotice({ kind: 'error', text: `Tidak bisa menyiapkan HEVC.js/DASH. ${error instanceof Error ? error.message : 'Periksa koneksi dan dependensi.'}` });
        }
      }
    };

    void setup();
    return () => {
      cancelled = true;
      cleanupPlayers();
      video.pause();
    };
  }, [sourceMode, sourceUrl, cleanupPlayers]);

  useEffect(() => () => {
    cleanupPlayers();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, [cleanupPlayers]);

  const acceptFile = useCallback((file?: File) => {
    if (!file) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setCurrentFileName(file.name);
    setCurrentFileSize(file.size);
    setSourceUrl(url);
    setSourceMode('local');
    setPlayerReady(false);
    setDuration(0);
    setCurrentTime(0);
    resetSession();
    setNotice({ kind: 'info', text: 'File lokal dipilih. Website mencoba pemutaran native dahulu; tidak ada upload ke Vercel.' });
  }, [resetSession]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0]);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    dragDepth.current = 0;
    acceptFile(event.dataTransfer.files?.[0]);
  };

  const submitStreamUrl = (event: FormEvent<HTMLFormElement>, mode: 'hls' | 'dash') => {
    event.preventDefault();
    const value = sourceUrlInput.trim();
    if (!/^https?:\/\//i.test(value)) {
      setNotice({ kind: 'error', text: 'Masukkan URL lengkap yang diawali http:// atau https://.' });
      return;
    }
    if (value.includes('drive.google.com')) {
      setNotice({ kind: 'warning', text: 'Tautan Google Drive biasa bukan manifest HLS/DASH. Gunakan tab Tautan langsung untuk mencoba file media, atau gunakan URL .m3u8/.mpd.' });
      return;
    }
    if (mode === 'hls' && !/\.m3u8(?:$|\?)/i.test(value)) {
      setNotice({ kind: 'warning', text: 'URL tidak tampak berakhiran .m3u8. Anda tetap dapat mencoba, tetapi sumber harus benar-benar berupa manifest HLS.' });
    }
    if (mode === 'dash' && !/\.mpd(?:$|\?)/i.test(value)) {
      setNotice({ kind: 'warning', text: 'URL tidak tampak berakhiran .mpd. Anda tetap dapat mencoba, tetapi sumber harus benar-benar berupa manifest MPEG-DASH.' });
    }
    setCurrentFileName(mode === 'hls' ? 'Streaming HLS' : 'Streaming MPEG-DASH');
    setCurrentFileSize(0);
    setSourceUrl(value);
    setSourceMode(mode);
    setPlayerReady(false);
    resetSession();
  };

  const [sourceUrlInput, setSourceUrlInput] = useState('');
  const [directUrlInput, setDirectUrlInput] = useState('');

  const submitDirectUrl = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = normalizeDriveUrl(directUrlInput);
    if (!/^https?:\/\//i.test(value)) {
      setNotice({ kind: 'error', text: 'Masukkan tautan media lengkap yang diawali http:// atau https://.' });
      return;
    }
    setCurrentFileName(value.includes('drive.google.com') ? 'Video dari Google Drive' : 'Video dari URL');
    setCurrentFileSize(0);
    setSourceUrl(value);
    setSourceMode('direct');
    setPlayerReady(false);
    resetSession();
  };

  const prepareClassNames = () => {
    const count = Number.parseInt(classCountInput, 10);
    if (!Number.isFinite(count) || count < 1 || count > 30) {
      setNotice({ kind: 'warning', text: 'Jumlah kelas harus antara 1 dan 30.' });
      return;
    }
    setNameDrafts(Array.from({ length: count }, (_, index) => nameDrafts[index] ?? ''));
  };

  const applyClasses = () => {
    const names = nameDrafts.map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) {
      setNotice({ kind: 'warning', text: 'Masukkan setidaknya satu nama kelas sebelum menerapkan.' });
      return;
    }
    if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      setNotice({ kind: 'warning', text: 'Setiap kelas harus memiliki nama yang berbeda.' });
      return;
    }
    const hasCounts = rowsRef.current.length > 0 || Object.values(countsRef.current).some((value) => value > 0);
    if (hasCounts && !window.confirm('Mengganti kelas akan menghapus hitungan sesi saat ini. Unduh CSV terlebih dahulu jika masih diperlukan. Lanjutkan?')) return;
    classesRef.current = names;
    setClasses(names);
    resetSession(names);
    setNotice({ kind: 'success', text: `${names.length} kelas diterapkan. Hitungan untuk setiap kelas dimulai dari 0.` });
  };

  const applyIntervalSettings = () => {
    const minutes = Number(intervalMinutesInput);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
      setNotice({ kind: 'warning', text: 'Durasi interval harus lebih dari 0 dan tidak boleh melebihi 1.440 menit.' });
      return;
    }
    const batch = Number.parseInt(batchSizeInput, 10);
    if (!Number.isFinite(batch) || batch < 1 || batch > 1000) {
      setNotice({ kind: 'warning', text: 'Jumlah interval per batch CSV harus antara 1 dan 1.000.' });
      return;
    }
    const hasCounts = rowsRef.current.length > 0 || Object.values(countsRef.current).some((value) => value > 0);
    if (hasCounts && !window.confirm('Mengubah durasi interval akan mereset sesi hitungan agar batas waktunya konsisten. Unduh CSV terlebih dahulu jika diperlukan. Lanjutkan?')) return;
    intervalSecondsRef.current = minutes * 60;
    setAppliedIntervalMinutes(minutes);
    setBatchSize(batch);
    resetSession();
    setNotice({ kind: 'success', text: `Interval diatur ke ${minutes} menit. CSV siap diunduh per ${batch} interval lengkap.` });
  };

  const countForClass = (name: string, delta: number) => {
    const next = Math.max(0, (countsRef.current[name] ?? 0) + delta);
    setCountsBoth({ ...countsRef.current, [name]: next });
  };

  const upsertRow = (target: IntervalRow, sourceRows: IntervalRow[]) => {
    const filtered = sourceRows.filter((row) => row.index !== target.index);
    return [...filtered, target].sort((a, b) => a.index - b.index);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const time = video.currentTime;
    setCurrentTime(time);
    const intervalSeconds = intervalSecondsRef.current;
    const target = Math.max(0, Math.floor(time / intervalSeconds));
    const current = activeIntervalRef.current;
    if (target === current) return;

    if (target > current) {
      let nextRows = [...rowsRef.current];
      for (let index = current; index < target; index += 1) {
        const rowCounts = index === current ? { ...countsRef.current } : zeroCounts();
        const start = index * intervalSeconds;
        const end = (index + 1) * intervalSeconds;
        nextRows = upsertRow({ index, start, end, counts: rowCounts }, nextRows);
      }
      setRowsBoth(nextRows);
      setCountsBoth(zeroCounts());
      activeIntervalRef.current = target;
      setActiveInterval(target);
      return;
    }

    // Seeking back reopens the prior interval and discards later intervals so
    // counting the same timeline again does not silently double-count.
    const existing = rowsRef.current.find((row) => row.index === target);
    setRowsBoth(rowsRef.current.filter((row) => row.index < target));
    setCountsBoth(existing ? { ...existing.counts } : zeroCounts());
    activeIntervalRef.current = target;
    setActiveInterval(target);
    setNotice({ kind: 'warning', text: 'Video digeser ke interval sebelumnya. Interval tersebut dibuka kembali dan interval setelahnya dihapus dari sesi aktif agar tidak terjadi hitungan ganda.' });
  };

  const finalizeCurrentInterval = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const intervalSeconds = intervalSecondsRef.current;
    const index = activeIntervalRef.current;
    const start = index * intervalSeconds;
    const end = Math.min(video.duration, (index + 1) * intervalSeconds);
    if (end <= start + 0.01) return;
    const nextRows = upsertRow({ index, start, end, counts: { ...countsRef.current } }, rowsRef.current);
    setRowsBoth(nextRows);
    setNotice({ kind: 'success', text: 'Video selesai. Interval terakhir disimpan ke sesi dan CSV dapat diunduh.' });
  };

  const resetCounts = () => {
    if (!window.confirm('Reset seluruh hitungan sesi ini? File video tidak akan dihapus.')) return;
    resetSession();
    setNotice({ kind: 'success', text: 'Hitungan sesi direset.' });
  };

  const makeExportRows = () => {
    const result = [...rowsRef.current].sort((a, b) => a.index - b.index);
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      const index = activeIntervalRef.current;
      const start = index * intervalSecondsRef.current;
      const end = Math.min(video.duration, (index + 1) * intervalSecondsRef.current);
      if (end > start + 0.01) {
        const activeRow: IntervalRow = { index, start, end, counts: { ...countsRef.current } };
        const found = result.some((row) => row.index === index);
        if (found) return result.map((row) => row.index === index ? activeRow : row).sort((a, b) => a.index - b.index);
        result.push(activeRow);
      }
    }
    return result.sort((a, b) => a.index - b.index);
  };

  const downloadCsv = (exportRows: IntervalRow[], filename: string) => {
    if (classes.length === 0) {
      setNotice({ kind: 'warning', text: 'Buat dan terapkan kelas terlebih dahulu sebelum mengekspor CSV.' });
      return;
    }
    if (exportRows.length === 0) {
      setNotice({ kind: 'warning', text: 'Belum ada interval yang dapat diekspor. Putar video atau hitung objek terlebih dahulu.' });
      return;
    }
    const header = ['interval', 'waktu_mulai', 'waktu_selesai', ...classes];
    const values = exportRows.map((row) => [
      `${formatTime(row.start)} - ${formatTime(row.end)}`,
      formatTime(row.start),
      formatTime(row.end),
      ...classes.map((name) => String(row.counts[name] ?? 0)),
    ]);
    const escapeCell = (value: string) => /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const csv = '\uFEFF' + [header, ...values].map((line) => line.map((value) => escapeCell(String(value))).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportAll = () => downloadCsv(makeExportRows(), `${slug(currentFileName || 'traffic-count')}-semua-interval.csv`);
  const completedBatches = useMemo(() => Math.floor(rows.length / batchSize), [rows.length, batchSize]);

  const exportBatch = (batchIndex: number) => {
    const sortedRows = [...rows].sort((a, b) => a.index - b.index);
    const chosen = sortedRows.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
    downloadCsv(chosen, `${slug(currentFileName || 'traffic-count')}-batch-${batchIndex + 1}.csv`);
  };

  const applySpeed = (rate: number) => {
    setSpeed(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const onVideoLoaded = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setPlayerReady(true);
    setNativePlaybackError(false);
    if (sourceMode === 'local') setNotice({ kind: 'success', text: 'Metadata video terbaca. Jika browser mendukung codec sumber, video siap diputar tanpa upload.' });
  };

  const onVideoError = () => {
    if (sourceMode === 'hls' || sourceMode === 'dash') return;
    setNativePlaybackError(true);
    setPlayerReady(false);
    setNotice({ kind: 'error', text: 'Browser tidak dapat memutar sumber ini secara native. Untuk file lokal MP4/MOV HEVC, hevc.js belum dapat dipasang langsung ke file biasa: library ini bekerja pada segmen HLS fMP4 atau DASH. Coba browser/perangkat dengan decoder HEVC, atau gunakan URL HLS/DASH yang sesuai.' });
  };

  const activeStart = activeInterval * appliedIntervalMinutes * 60;
  const activeEnd = activeStart + appliedIntervalMinutes * 60;
  const totalCount = Object.values(counts).reduce((sum, amount) => sum + amount, 0);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>TC</span></div>
          <div>
            <div className="brand-name">Traffic Count Studio</div>
            <div className="brand-subtitle">Manual video counting workspace</div>
          </div>
        </div>
        <div className="header-tags">
          <span className="header-tag"><span className="tag-dot" /> Vercel-ready</span>
          <span className="header-tag tag-neutral">Browser-only · Tanpa database</span>
        </div>
      </header>

      <main className="main-content">
        <section className="page-intro">
          <div>
            <p className="eyebrow">CCTV ANALYSIS / MANUAL COUNTER</p>
            <h1>Hitung objek dari rekaman video.</h1>
            <p className="intro-copy">Pilih sendiri kelas objek, hitung sambil video berjalan, lalu unduh hasil per interval ke CSV.</p>
          </div>
          <div className="privacy-note"><span className="privacy-icon">⌁</span><span>Video lokal tidak diunggah ke server</span></div>
        </section>

        <div className="workspace-grid">
          <section className="left-column">
            <div className="panel video-panel">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">01 / VIDEO SOURCE</p>
                  <h2>Video CCTV</h2>
                </div>
                <span className={`source-state ${playerReady ? 'state-ready' : ''}`}><span className="state-dot" />{playerReady ? 'Siap diputar' : 'Belum siap'}</span>
              </div>

              <div className="source-tabs" role="tablist" aria-label="Cara memuat video">
                <button className={sourceMode === 'local' || sourceMode === 'none' ? 'source-tab active' : 'source-tab'} onClick={() => { if (sourceMode !== 'local') { setSourceMode('none'); setSourceUrl(''); setCurrentFileName(''); setCurrentFileSize(0); } }} type="button">File lokal</button>
                <button className={sourceMode === 'hls' ? 'source-tab active' : 'source-tab'} onClick={() => { setSourceMode('none'); setSourceUrl(''); setSourceUrlInput(''); }} type="button">HEVC · HLS</button>
                <button className={sourceMode === 'dash' ? 'source-tab active' : 'source-tab'} onClick={() => { setSourceMode('none'); setSourceUrl(''); setSourceUrlInput(''); }} type="button">HEVC · DASH</button>
                <button className={sourceMode === 'direct' ? 'source-tab active' : 'source-tab'} onClick={() => { setSourceMode('none'); setSourceUrl(''); setDirectUrlInput(''); }} type="button">Tautan langsung</button>
              </div>

              {(sourceMode === 'none' || sourceMode === 'local') && (
                <div
                  className={`dropzone ${isDragging ? 'dragging' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setIsDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setIsDragging(false); } }}
                  onDrop={handleDrop}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}
                >
                  <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v,.ts,.mts,.m2ts,.hevc,.h265" onChange={handleFileChange} />
                  <div className="upload-icon"><span>↑</span></div>
                  <div className="dropzone-main"><strong>Seret file video ke sini</strong><span>atau klik untuk memilih dari komputer</span></div>
                  <div className="dropzone-types">MP4 · MOV · MKV · AVI · H.265/HEVC · lainnya</div>
                  {currentFileName && sourceMode === 'local' && <div className="file-chip"><span className="file-chip-icon">▶</span><span className="file-chip-name">{currentFileName}</span><span className="file-chip-size">{formatBytes(currentFileSize)}</span></div>}
                </div>
              )}

              {sourceMode === 'hls' && (
                <form className="url-form" onSubmit={(event) => submitStreamUrl(event, 'hls')}>
                  <label htmlFor="hls-url">URL manifest HLS (.m3u8)</label>
                  <div className="url-input-row"><input id="hls-url" value={sourceUrlInput} onChange={(event) => setSourceUrlInput(event.target.value)} placeholder="https://server.example/video/playlist.m3u8" /><button className="btn btn-primary" type="submit">Putar HLS</button></div>
                  <p className="helper-text">Untuk fallback HEVC.js, sumber harus HLS fMP4 yang mengizinkan CORS. Tautan Google Drive biasa bukan manifest HLS.</p>
                </form>
              )}

              {sourceMode === 'dash' && (
                <form className="url-form" onSubmit={(event) => submitStreamUrl(event, 'dash')}>
                  <label htmlFor="dash-url">URL manifest MPEG-DASH (.mpd)</label>
                  <div className="url-input-row"><input id="dash-url" value={sourceUrlInput} onChange={(event) => setSourceUrlInput(event.target.value)} placeholder="https://server.example/video/manifest.mpd" /><button className="btn btn-primary" type="submit">Putar DASH</button></div>
                  <p className="helper-text">Manifest dan seluruh segmennya harus dapat diakses browser melalui HTTPS/CORS.</p>
                </form>
              )}

              {sourceMode === 'direct' && (
                <form className="url-form" onSubmit={submitDirectUrl}>
                  <label htmlFor="direct-url">Tautan langsung atau Google Drive</label>
                  <div className="url-input-row"><input id="direct-url" value={directUrlInput} onChange={(event) => setDirectUrlInput(event.target.value)} placeholder="https://drive.google.com/file/d/…/view" /><button className="btn btn-primary" type="submit">Buka tautan</button></div>
                  <p className="helper-text">Mencoba tautan sebagai media langsung. Google Drive dapat menolak streaming, meminta login, atau tidak menyediakan byte-range/CORS; jika gagal, unduh file ke komputer dan pilih File lokal.</p>
                </form>
              )}

              <div className={`notice notice-${notice.kind}`} role="status"><span className="notice-mark">{notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : notice.kind === 'warning' ? '⚠' : 'i'}</span><span>{notice.text}</span></div>

              <div className="video-stage">
                {sourceMode === 'none' && (
                  <div className="video-placeholder">
                    <div className="placeholder-play">▶</div>
                    <strong>Area pratinjau video</strong>
                    <span>Pilih video lokal atau sumber streaming di atas</span>
                  </div>
                )}
                <video
                  ref={videoRef}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={onVideoLoaded}
                  onCanPlay={() => setPlayerReady(true)}
                  onError={onVideoError}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={finalizeCurrentInterval}
                  onDurationChange={() => { const video = videoRef.current; if (video && Number.isFinite(video.duration)) setDuration(video.duration); }}
                />
                {sourceMode === 'none' && <div className="video-placeholder-overlay" />}
              </div>

              <div className="video-controls-row">
                <div className="video-file-detail">
                  <span className="detail-label">SUMBER AKTIF</span>
                  <strong title={currentFileName || 'Belum ada video'}>{currentFileName || 'Belum ada video dipilih'}</strong>
                  <span>{duration > 0 ? `${formatTime(duration)} durasi` : 'Pilih sumber untuk memulai'}</span>
                </div>
                <div className="speed-control">
                  <span className="detail-label">KECEPATAN</span>
                  <div className="speed-buttons">
                    {[0.5, 1, 1.25, 1.5, 2].map((rate) => <button key={rate} className={speed === rate ? 'speed-btn selected' : 'speed-btn'} type="button" onClick={() => applySpeed(rate)}>{rate}×</button>)}
                  </div>
                </div>
              </div>
              {nativePlaybackError && <div className="compat-warning"><strong>Catatan kompatibilitas HEVC</strong><span>hevc.js membantu pemutaran HLS/DASH berisi HEVC. Ia tidak otomatis mengubah file MP4/MOV lokal menjadi HLS. Untuk file lokal yang gagal, gunakan browser/perangkat dengan decoder HEVC atau siapkan aliran HLS/DASH yang kompatibel.</span><a href="https://github.com/lid-labs/hevc.js" target="_blank" rel="noreferrer">Baca kemampuan hevc.js ↗</a></div>}
            </div>

            <div className="panel interval-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">02 / TIME WINDOW</p><h2>Interval penghitungan</h2></div>
                <span className="interval-pill">Interval aktif #{activeInterval + 1}</span>
              </div>
              <div className="interval-stats">
                <div className="interval-stat"><span>WAKTU VIDEO</span><strong>{formatTime(currentTime)} <em>/ {formatTime(duration)}</em></strong><div className="progress-track"><div className="progress-fill" style={{ width: duration > 0 ? `${Math.min(100, (currentTime / duration) * 100)}%` : '0%' }} /></div></div>
                <div className="interval-stat"><span>RENTANG INTERVAL</span><strong>{formatTime(activeStart)} <em>—</em> {formatTime(activeEnd)}</strong><small>Berpatokan pada waktu video, bukan jam komputer.</small></div>
                <div className="interval-stat"><span>OBJEK DI INTERVAL AKTIF</span><strong>{totalCount.toLocaleString('id-ID')} <em>objek</em></strong><small>Hitungan direset otomatis saat masuk interval berikutnya.</small></div>
              </div>
              <div className="settings-row">
                <div className="field"><label htmlFor="interval-minutes">Durasi per interval (menit)</label><input id="interval-minutes" type="number" min="0.1" max="1440" step="0.1" value={intervalMinutesInput} onChange={(event) => setIntervalMinutesInput(event.target.value)} /></div>
                <div className="field"><label htmlFor="batch-size">Interval per file CSV</label><input id="batch-size" type="number" min="1" max="1000" step="1" value={batchSizeInput} onChange={(event) => setBatchSizeInput(event.target.value)} /></div>
                <button className="btn btn-secondary apply-settings" type="button" onClick={applyIntervalSettings}>Terapkan pengaturan</button>
              </div>
              <div className="interval-footnote"><span>↻</span> Saat video maju, hitungan interval sebelumnya disimpan. Jika Anda menggeser video ke interval lama, interval itu dibuka kembali untuk mencegah hitungan ganda.</div>
            </div>
          </section>

          <aside className="right-column">
            <section className="panel classes-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">03 / CUSTOM CLASSES</p><h2>Kelas objek</h2></div>
                <span className="count-badge">{classes.length} kelas</span>
              </div>
              <p className="panel-description">Anda yang menentukan jumlah dan nama kelas. Tidak ada kelas bawaan.</p>
              <div className="class-builder">
                <div className="field"><label htmlFor="class-count">Berapa kelas yang ingin dihitung?</label><div className="class-count-row"><input id="class-count" type="number" min="1" max="30" value={classCountInput} onChange={(event) => setClassCountInput(event.target.value)} /><button type="button" className="btn btn-secondary" onClick={prepareClassNames}>Buat input nama</button></div></div>
                {nameDrafts.length > 0 && <div className="name-drafts">{nameDrafts.map((name, index) => <div className="field" key={`class-name-${index}`}><label htmlFor={`class-name-${index}`}>Nama kelas {index + 1}</label><input id={`class-name-${index}`} value={name} onChange={(event) => setNameDrafts((drafts) => drafts.map((item, i) => i === index ? event.target.value : item))} placeholder={index === 0 ? 'Contoh: Motor' : index === 1 ? 'Contoh: Mobil' : 'Masukkan nama kelas'} maxLength={40} /></div>)}<button type="button" className="btn btn-primary apply-classes" onClick={applyClasses}>Terapkan kelas</button></div>}
              </div>

              {classes.length === 0 ? (
                <div className="empty-classes"><div className="empty-icon">＋</div><strong>Belum ada kelas</strong><span>Masukkan jumlah kelas, buat input nama, lalu terapkan.</span></div>
              ) : (
                <div className="counter-list">
                  {classes.map((name, index) => <div className="counter-card" key={`${name}-${index}`}>
                    <div className="counter-topline"><span className={`class-color class-color-${index % 6}`} /><div className="counter-class-name" title={name}>{name}</div><span className="counter-total">{(counts[name] ?? 0).toLocaleString('id-ID')}</span></div>
                    <div className="counter-actions"><button type="button" className="count-minus" aria-label={`Kurangi ${name}`} onClick={() => countForClass(name, -1)} disabled={(counts[name] ?? 0) === 0}>−</button><button type="button" className="count-plus" onClick={() => countForClass(name, 1)}><span>＋</span> Tambah 1</button></div>
                  </div>)}
                  <div className="class-actions"><button type="button" className="btn btn-quiet" onClick={resetCounts}>Reset hitungan</button><button type="button" className="btn btn-quiet" onClick={() => { setNameDrafts(classes); setClassCountInput(String(classes.length)); }}>Edit nama kelas</button></div>
                </div>
              )}
            </section>

            <section className="panel export-panel">
              <div className="panel-heading"><div><p className="section-kicker">04 / EXPORT</p><h2>Hasil CSV</h2></div><span className="csv-icon">CSV</span></div>
              <p className="panel-description">Ekspor interval yang sudah selesai, per batch atau seluruh sesi. File dibuat langsung di browser.</p>
              <div className="export-summary"><div><span>INTERVAL TERSIMPAN</span><strong>{rows.length}</strong></div><div><span>BATCH SIAP</span><strong>{completedBatches}</strong></div></div>
              <button type="button" className="btn btn-primary export-all" onClick={exportAll}>↓ Unduh seluruh CSV</button>
              <div className="batch-title"><strong>Batch yang siap diunduh</strong><span>{batchSize} interval / file</span></div>
              {completedBatches === 0 ? <div className="empty-batches">Belum ada batch lengkap. Putar video melewati batas interval untuk mulai mengisi CSV.</div> : <div className="batch-list">{Array.from({ length: completedBatches }, (_, index) => <div className="batch-row" key={`batch-${index}`}><div className="batch-icon">▤</div><div className="batch-label"><strong>Batch {index + 1}</strong><span>{formatTime(index * batchSize * appliedIntervalMinutes * 60)} – {formatTime((index + 1) * batchSize * appliedIntervalMinutes * 60)}</span></div><button className="batch-download" type="button" onClick={() => exportBatch(index)}>Unduh ↓</button></div>)}</div>}
              <div className="export-note"><span>i</span><span>Hitungan disimpan di tab browser saat sesi berlangsung. Unduh CSV sebelum menutup atau me-refresh halaman.</span></div>
            </section>
          </aside>
        </div>

        <section className="help-strip">
          <div className="help-symbol">?</div><div><strong>Catatan penting tentang HEVC</strong><p>File lokal diputar dengan decoder video di browser/perangkat Anda. Library hevc.js yang terpasang di proyek ini membantu fallback untuk manifest HLS fMP4 dan MPEG-DASH; bukan decoder plug-and-play untuk semua MP4/MOV lokal. Semua fitur hitung manual dan CSV berjalan di browser, tanpa backend dan tanpa database.</p></div><a href="https://github.com/lid-labs/hevc.js" target="_blank" rel="noreferrer">Dokumentasi library ↗</a>
        </section>
      </main>
      <footer className="footer"><span>Traffic Count Studio</span><span>Client-side counting · Vercel deployment</span></footer>
    </div>
  );
}

export default App;
