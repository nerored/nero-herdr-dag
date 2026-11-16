import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { t } from './i18n.mjs';
import {
  boundSnapshotInput, failedReadPlaceholder, readFailureEvidence, readStateFile, ViewerSnapshotError,
} from './viewer-snapshot.mjs';

// Bounded exponential watch retry. A dead watch (directory removed, EMFILE,
// ENOSPC) is re-established instead of leaving the frame frozen forever.
export function watchRetryDelay(attempt, { base = 1_000, max = 30_000 } = {}) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

// Install the watch before the first read so a one-shot producer that writes
// while the viewer is starting is not missed.
export async function loadInitialSnapshot({ statePath, interactive, setupWatch, load }) {
  if (statePath && interactive) setupWatch();
  return load();
}

// The source adapter owns the watched state file: reads, bounds, generation
// guards, failure placeholders, and the watch/retry lifecycle. It writes the
// snapshot only through the session's documented installer so the session
// remains the single owner of the visible state.
export function createViewerSource({
  session,
  statePath,
  once = false,
  readStateFileFn = readStateFile,
  watchFn = watch,
  watchRetryBaseMs = 1_000,
  requestRepaint = () => {},
} = {}) {
  const ui = session.ui;
  let watcher;
  let watchTimer;
  let watchRetryTimer;
  let watchAttempt = 0;
  let lastReadError;
  let loadGeneration = 0;
  let closed = false;

  async function loadState(silent = false) {
    const generation = ++loadGeneration;
    let raw;
    try {
      raw = await readStateFileFn(statePath);
    } catch (error) {
      if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
      const failure = readFailureEvidence(session.snapshot, error);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) session.installPlaceholder(failure.placeholder);
      session.invalidateViewState();
      if (!silent) session.addToast(t(ui.language, 'toastSnapshotError', { error: error.message }), 'failed');
      requestRepaint();
      return { kind: 'unreadable', loaded: false, error };
    }
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };

    let bounded;
    try {
      bounded = boundSnapshotInput(raw);
    } catch (error) {
      if (!(error instanceof ViewerSnapshotError)) throw error;
      if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
      const invalid = new ViewerSnapshotError(`invalid snapshot: ${error.message}`);
      const failure = readFailureEvidence(session.snapshot, invalid);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) session.installPlaceholder(failure.placeholder);
      session.invalidateViewState();
      if (!silent) session.addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
      requestRepaint();
      return { kind: 'invalid', loaded: false, error: invalid };
    }
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };

    // Programming errors from normalization are not read failures; they reach
    // the fatal handlers instead of being disguised as an unreadable file.
    const loaded = session.acceptSnapshot(bounded, { silent, view: once ? 'once' : 'watch' });
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
    if (!loaded) {
      const invalid = new ViewerSnapshotError('snapshot failed schema validation');
      const failure = readFailureEvidence(session.snapshot, invalid);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) session.installPlaceholder(failure.placeholder);
      session.invalidateViewState();
      requestRepaint();
      return { kind: 'invalid', loaded: false, error: invalid };
    }
    lastReadError = undefined;
    await session.syncViewState(() => generation === loadGeneration);
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
    return { kind: 'ok', loaded: true };
  }

  function showPlaceholder(view) {
    session.installPlaceholder(failedReadPlaceholder(statePath, lastReadError, { view }));
    session.ensureSelection();
  }

  function scheduleWatchRetry() {
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = undefined;
    if (closed) return;
    clearTimeout(watchRetryTimer);
    const attempt = watchAttempt++;
    watchRetryTimer = setTimeout(() => {
      if (closed) return;
      setupFileWatch();
      // Re-read after re-establishing: the file may have changed while the
      // watch was dead. loadState's generation guard drops any stale overlap.
      void loadState(true);
    }, watchRetryDelay(attempt, { base: watchRetryBaseMs }));
  }

  function setupFileWatch() {
    if (!statePath || closed) return;
    clearTimeout(watchRetryTimer);
    try {
      watcher = watchFn(dirname(statePath), (_event, name) => {
        if (name && String(name) !== basename(statePath)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => { void loadState(); }, 50);
      });
      watcher.on('error', error => {
        session.addToast(t(ui.language, 'toastWatchError', { error: error.message }), 'failed');
        scheduleWatchRetry();
      });
      watchAttempt = 0;
    } catch (error) {
      session.addToast(t(ui.language, 'toastWatchUnavailable', { error: error.message }), 'warning');
      scheduleWatchRetry();
    }
  }

  // close() tears down the timer set and the watcher as separate steps so the
  // documented ordering (timers -> watcher) stays observable.
  function clearTimers() {
    clearTimeout(watchTimer);
    clearTimeout(watchRetryTimer);
  }

  function closeWatcher() {
    closed = true;
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = undefined;
  }

  return {
    loadState,
    showPlaceholder,
    setupFileWatch,
    scheduleWatchRetry,
    clearTimers,
    closeWatcher,
  };
}
