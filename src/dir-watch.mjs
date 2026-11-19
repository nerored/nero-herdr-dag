import { existsSync, watch } from 'node:fs';
import { dirname, relative } from 'node:path';

// fs.watch is not recursive, and an OmO store is created lazily: the task and
// checkpoint directories may not exist when a session starts. Watch the
// nearest existing ancestor and re-arm as each component appears, so the event
// that creates the target is not lost.
//
// A dead watch (EMFILE, ENOSPC, a removed directory) must not freeze the
// viewer forever. Retry with bounded exponential backoff; the caller owns the
// user-facing warning so one broken store is reported once, not on every
// retry.
export class DirectoryWatcher {
  constructor({
    target, onChange, onError, retryBaseMs = 500, retryMaxMs = 30_000, maxAncestorDepth = 8,
  }) {
    this.target = target;
    this.onChange = onChange;
    this.onError = onError ?? (() => {});
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.maxAncestorDepth = maxAncestorDepth;
    this.watcher = undefined;
    this.watchedDirectory = undefined;
    this.retryTimer = undefined;
    this.attempt = 0;
    this.closed = false;
  }

  start() {
    this.arm();
  }

  stop() {
    this.closed = true;
    this.closeWatcher();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  closeWatcher() {
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = undefined;
    this.watchedDirectory = undefined;
  }

  arm() {
    if (this.closed) return;
    let directory = this.target;
    for (let depth = 0; !existsSync(directory) && dirname(directory) !== directory && depth < this.maxAncestorDepth; depth++) {
      directory = dirname(directory);
    }
    if (dirname(directory) === directory) return;
    if (this.watchedDirectory === directory) return;
    this.closeWatcher();
    // While watching an ancestor, ignore siblings: only the path component
    // that leads to the target can mean the watch can be narrowed.
    const next = relative(directory, this.target).split(/[\\/]/)[0];
    let watcher;
    try {
      watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (this.closed || (next && filename && String(filename) !== next)) return;
        try {
          this.arm();
          this.onChange();
        } catch (error) {
          this.fail(error);
        }
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    watcher.on('error', error => {
      if (this.watcher !== watcher) return;
      this.closeWatcher();
      this.fail(error);
    });
    this.watcher = watcher;
    this.watchedDirectory = directory;
    this.attempt = 0;
    // The target may have appeared between the ancestor walk and watch().
    this.arm();
  }

  fail(error) {
    if (this.closed) return;
    // A throwing notification must not cancel the retry and leave the watch
    // dead for the rest of the session.
    try { this.onError(error); }
    finally { this.scheduleRetry(); }
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const attempt = ++this.attempt;
    const delay = Math.min(this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(attempt - 1, 6));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.arm();
    }, delay);
    this.retryTimer.unref?.();
  }
}
