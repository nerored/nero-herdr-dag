import { osc52, payloadLines } from './clipboard.mjs';
import { commandItems, filterCommands } from './commands.mjs';
import { t } from './i18n.mjs';
import { extractMouse, wheelDirectionFromButton } from './mouse.mjs';
import { recordForKey } from './records.mjs';
import { regionAt } from './scroll.mjs';
import { hitTargetAt } from './view-model.mjs';
import {
  GLOBAL_KEYMAP, MODAL_ORDER, PALETTE_KEYMAP, SETTINGS_KEYMAP, SWITCHER_KEYMAP, TOUR_KEYMAP,
  applyHelpScroll, helpKeyAction, helpScrollMetrics, isEscapeKey, keyToken, matchingKeys,
  resolveKey,
} from './viewer-keymap.mjs';

// The readline keypress and the raw mouse report for the same bytes arrive as
// separate events; this window suppresses the key copy. It also covers
// readline's 30ms escape timeout, so a split report is never read as digits.
const MOUSE_PENDING_KEY_MS = 80;

// Input dispatch writes only these documented modal ui fields. Durable subject
// and transition writes go through the session commands; this module never
// assigns session.snapshot/session.vm/session.ui and never mutates a snapshot.
export const INPUT_MODAL_UI_FIELDS = Object.freeze([
  'help', 'helpScroll', 'paletteFilter', 'paletteIndex',
  'settingsIndex', 'settingsMenu', 'switcher', 'tour',
]);

export function runFooterAction(action, { toggleMouse, clear } = {}) {
  if (action === 'mouse') {
    toggleMouse?.();
    return true;
  }
  if (action === 'clear') {
    clear?.();
    return true;
  }
  return false;
}

// Input dispatch owns the key/mouse/wheel/modal event vocabulary and the
// selectAt hit test. It is created by the viewer with the session, its input
// adapter state, and the runtime adapters it calls; the session object carries
// the durable state and every command that changes it.
export function createViewerInput(ctx) {
  const { session, state } = ctx;

  function onMouseEvent(mouse) {
    const { ui } = session;
    // Readline may also emit a keypress for the same bytes; ignore that copy.
    state.ignoreKeysUntil = Date.now() + MOUSE_PENDING_KEY_MS;
    // Button bit 32 marks motion (drag). A terminal that leaves a motion mode
    // enabled must not turn dragging into repeated selection changes or modal
    // dismissal, so motion reports are never treated as clicks.
    if (mouse.button & 32) return;
    if (ui.settingsMenu) {
      if (!mouse.release && (mouse.button & 3) === 0) selectAt(mouse.x, mouse.y);
      return;
    }
    if (ui.help) {
      if (mouse.button & 64) {
        const direction = wheelDirectionFromButton(mouse.button);
        if (direction) session.scrollHelpPage(direction);
        return;
      }
      if (!mouse.release && (mouse.button & 3) === 0) {
        ui.help = false;
        ui.helpScroll = 0;
        session.invalidateHelpFrame();
        void ctx.draw();
      }
      return;
    }
    if (mouse.button & 64) {
      applyWheel(mouse);
      return;
    }
    if (!mouse.release && (mouse.button & 3) === 0) selectAt(mouse.x, mouse.y);
  }

  function inputBytes(chunk) {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    // Already-decoded input (tests, embedding) keeps one character per byte.
    return Buffer.from(String(chunk), 'latin1');
  }

  function onRawInput(chunk) {
    if (state.pagerActive) return;
    state.rawInput = Buffer.concat([state.rawInput, inputBytes(chunk)]);
    if (state.rawInput.length > 8192) state.rawInput = state.rawInput.subarray(state.rawInput.length - 8192);
    const { events, rest, pending } = extractMouse(state.rawInput);
    const remainder = Buffer.isBuffer(rest) ? rest : Buffer.from(String(rest), 'latin1');
    state.rawInput = remainder.subarray(Math.max(0, remainder.length - 64));
    // readline also emits the partial report bytes as individual keys (its
    // digits are duty focus hotkeys), so key dispatch waits for the report to
    // finish instead of acting on a fragment.
    state.mousePendingUntil = pending ? Date.now() + MOUSE_PENDING_KEY_MS : 0;
    for (const event of events) onMouseEvent(event);
    if (events.length) ctx.requestFrame();
  }

  function applyWheel(mouse) {
    const { ui, vm } = session;
    const direction = wheelDirectionFromButton(mouse.button);
    if (!direction) return;
    // Wheel stays in the modal switcher; it never scrolls the frame underneath.
    if (ui.switcher) {
      session.moveSwitcherSelection(direction);
      return;
    }
    if (!vm.frame) return;
    const region = regionAt(mouse.x, mouse.y, vm.frame.hitboxes?.regions);
    if (!region) return;
    session.scrollRegionBy(region, direction * session.regionStep(region));
  }

  function selectAt(x, y) {
    const { ui, vm } = session;
    const snapshot = session.snapshot;
    if (!snapshot) return;
    // Read paths that install a failed-read placeholder do not redraw first;
    // point the model at the snapshot the next pointer event must resolve.
    session.syncPointerViewModel();
    const target = hitTargetAt(vm, x, y);
    if (!target) return;
    if (target.kind === 'palette') {
      const items = filterCommands(commandItems(ui.language), ui.paletteFilter);
      const index = items.findIndex(item => item.id === target.id);
      if (index >= 0) {
        ui.paletteIndex = index;
        session.applyPaletteCommand(target.id);
      }
      return;
    }
    if (target.kind === 'palette-panel') return;
    if (target.kind === 'palette-backdrop') {
      session.closePalette();
      return;
    }
    if (target.kind === 'switcher') {
      session.confirmSwitcher(target.key);
      return;
    }
    if (target.kind === 'switcher-panel') return;
    if (target.kind === 'switcher-backdrop') {
      ui.switcher = null;
      return;
    }
    if (target.kind === 'settings') {
      const index = ['theme', 'animation', 'language'].indexOf(target.id);
      if (index >= 0) session.applySetting(index);
      return;
    }
    if (target.kind === 'settings-backdrop') {
      ui.settingsMenu = false;
      return;
    }
    if (target.kind === 'tasks-toggle') {
      session.toggleCompleted();
      return;
    }
    if (target.kind === 'context') {
      if (target.subject === 'run') {
        session.selectRunFromPointer(target.id);
        return;
      }
      if (target.subject === 'task') {
        session.selectTaskById(target.id, { announce: true });
        session.focusTaskDetails();
        return;
      }
      session.selectNodeFromContext(target.id);
      return;
    }
    if (target.kind === 'chrome') {
      if (target.action === 'mouse' || target.action === 'clear') {
        runFooterAction(target.action, {
          toggleMouse: () => ctx.setMouseCapture(!ui.mouseCapture),
          clear: session.clearCompleted,
        });
      } else if (target.action === 'help') {
        session.toggleHelp();
      } else if (target.action === 'settings') {
        session.openSettingsMenu();
      }
      return;
    }
    if (target.kind === 'node') {
      session.selectNodeFromPointer(target.id);
      return;
    }
    if (target.kind === 'task') {
      const clicked = session.selectTaskById(target.id, { announce: true });
      if (!clicked.handled) return;
      session.focusTaskDetails();
      return;
    }
    if (target.kind === 'run') {
      // A run row selects the run subject so the details pane paints RUN SUMMARY.
      session.selectRunFromPointer(target.id);
    }
  }

  function handleDiagnosisKey(key) {
    const { ui } = session;
    const snapshot = session.snapshot;
    if (!['c', 'p', 'o'].includes(key)) return false;
    if (key === 'o') {
      // Opening a raw record is status-independent: a completed task has no
      // diagnosis card, but its record is still the only place the full
      // final_response survives. The same safe-file gates apply to every status.
      const record = ctx.recordForSelection(snapshot, ui);
      if (!record) {
        session.addToast(t(ui.language, 'diagnosisNothing'), 'warning');
        return true;
      }
      const action = recordForKey('o', record);
      if (action.kind === 'open') void ctx.openRecordInPager(action.path);
      else session.addToast(t(ui.language, 'diagnosisOpenUnavailable'), 'warning');
      return true;
    }
    const diagnosis = ctx.diagnosisForSelection(snapshot, ui);
    if (!diagnosis) {
      session.addToast(t(ui.language, 'diagnosisNothing'), 'warning');
      return true;
    }
    // The copied bundle is the artifact the user keeps, so it must use the
    // same UI language as the diagnosis panel.
    const action = ctx.diagnosisForKey(key, diagnosis, undefined, ui.language);
    if (!action) return false;
    if (action.kind === 'copy-diagnosis' || action.kind === 'copy-paths') {
      if (!ctx.interactive || !process.stdout.isTTY) {
        session.addToast(t(ui.language, 'diagnosisCopyUnavailable'), 'warning');
        return true;
      }
      process.stdout.write(osc52(action.text));
      session.addToast(t(ui.language, 'diagnosisCopied', { lines: payloadLines(action.text) }), 'info');
    } else {
      session.addToast(t(ui.language, action.reason === 'no-paths' ? 'diagnosisNoPaths' : 'diagnosisOpenUnavailable'), 'warning');
    }
    return true;
  }

  function handlePaletteKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(PALETTE_KEYMAP, key, pressed);
    if (!action) return;
    if (action.id === 'close') { session.closePalette(); return; }
    if (action.id === 'move') { session.movePalette(action.value); return; }
    if (action.id === 'confirm') {
      const { active } = session.paletteView();
      if (active) session.applyPaletteCommand(active.id);
      return;
    }
    if (action.id === 'backspace') {
      ui.paletteFilter = ui.paletteFilter.slice(0, -1);
      ui.paletteIndex = 0;
      return;
    }
    if (action.id === 'type') {
      ui.paletteFilter += action.value;
      ui.paletteIndex = 0;
    }
  }

  function handleSwitcherKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(SWITCHER_KEYMAP, key, pressed);
    if (!action) return;
    switch (action.id) {
      case 'quit':
        void ctx.close({ closePane: true });
        return;
      case 'close':
        ui.switcher = null;
        return;
      case 'move':
        session.moveSwitcherSelection(action.value);
        return;
      case 'confirm':
        session.confirmSwitcher(undefined);
        return;
      case 'backspace': {
        const query = ui.switcher.query.slice(0, -1);
        ui.switcher = { ...ui.switcher, query };
        return;
      }
      case 'clearQuery':
        ui.switcher = { ...ui.switcher, query: '' };
        return;
      case 'type':
        ui.switcher = { ...ui.switcher, query: `${ui.switcher.query}${action.value}` };
        return;
      default:
        // '/' and every unconsumed key are modal no-ops: the switcher owns the
        // keyboard while it is open.
        return;
    }
  }

  function handleTourKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(TOUR_KEYMAP, key, pressed);
    if (action?.id === 'close') { ui.tour = 0; return; }
    if (action?.id === 'advance') { ui.tour = ui.tour >= 5 ? 0 : ui.tour + 1; }
  }

  function handleHelpKey(key, pressed) {
    const { ui } = session;
    const metrics = helpScrollMetrics(ctx.terminalHeight());
    const action = helpKeyAction(key, pressed, metrics);
    if (action === 'close') {
      ui.help = false;
      ui.helpScroll = 0;
      session.invalidateHelpFrame();
      void ctx.draw();
    } else if (action === 'scroll' && applyHelpScroll(ui, key, pressed, metrics)) {
      session.invalidateHelpFrame();
      void ctx.draw();
    }
  }

  function handleSettingsKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(SETTINGS_KEYMAP, key, pressed);
    if (!action) return;
    if (action.id === 'close') { ui.settingsMenu = false; return; }
    if (action.id === 'cycle') {
      ui.settingsIndex = (ui.settingsIndex + action.value + 3) % 3;
      return;
    }
    if (action.id === 'apply') session.applySetting(ui.settingsIndex);
  }

  const MODAL_HANDLERS = {
    switcher: handleSwitcherKey,
    palette: handlePaletteKey,
    tour: handleTourKey,
    help: handleHelpKey,
    settings: handleSettingsKey,
  };

  // Ordered modal dispatch: an open modal owns every key, and the first active
  // row in MODAL_ORDER wins. Global keys never fire underneath an overlay
  // unless the row explicitly yields that key (Settings yields the quit keys).
  function dispatchModal(key, pressed) {
    for (const modal of MODAL_ORDER) {
      if (!modal.active(session.ui)) continue;
      if (modal.preemptedBy?.(key, pressed)) continue;
      MODAL_HANDLERS[modal.id](key, pressed);
      return true;
    }
    return false;
  }

  function runGlobalAction({ id, value }, key, pressed) {
    const { ui } = session;
    switch (id) {
      case 'quit':
        void ctx.close({ closePane: true });
        return true;
      case 'escape':
        session.escape();
        return true;
      case 'runOverviewBack':
        return session.showRunOverview();
      case 'graphFilter':
        session.setGraphFilter(value);
        return true;
      case 'focusNode':
        session.focusGraphNode();
        return true;
      case 'stepNode':
        session.stepGraphNode(value);
        return true;
      case 'undo':
        session.undoCleared();
        return true;
      case 'palette':
        session.openPalette();
        return true;
      case 'help':
        session.toggleHelp();
        return true;
      case 'settings':
        session.openSettingsMenu();
        return true;
      case 'mouseCapture':
        ctx.setMouseCapture(!ui.mouseCapture);
        return true;
      case 'clearCompleted':
        session.clearCompleted();
        return true;
      case 'restoreHidden':
        session.restoreHidden();
        return true;
      case 'sidebar':
        session.toggleSidebar();
        return true;
      case 'follow':
        session.toggleFollow();
        return true;
      case 'demoReset':
        ctx.engine.reset();
        session.resetDemoView();
        return true;
      case 'verbose':
        session.toggleVerbose();
        return true;
      case 'dutyFocus':
        session.focusDuty(value.focus);
        return true;
      case 'diagnosis':
        return handleDiagnosisKey(key);
      case 'expand':
        session.expandDetails();
        return true;
      case 'switcher':
        session.openSwitcher();
        return true;
      case 'completed':
        session.toggleCompleted();
        return true;
      case 'taskScope':
        session.toggleTaskScope();
        return true;
      case 'cycle':
        session.cycle(value);
        return true;
      case 'switchRun':
        session.switchRun(value);
        return true;
      case 'keyboardScroll':
        return session.dispatchKeyboardScroll(key, pressed);
      case 'detailsSection':
        session.jumpDetailsSection(value);
        return true;
      case 'detailsToggle':
        session.toggleDetailsSection();
        return true;
      case 'fold':
        session.foldSelectedNode();
        return true;
      default:
        return false;
    }
  }

  function handleGlobalKey(key, pressed) {
    const { ui } = session;
    for (const hit of matchingKeys(GLOBAL_KEYMAP, key, pressed, { ui, context: { demoMode: ctx.demoMode } })) {
      if (runGlobalAction(hit, key, pressed) !== false) return;
    }
  }

  function handleKey(text, pressed) {
    const { ui } = session;
    if (state.pagerActive) return;
    const key = keyToken(text, pressed);
    // Dismissal is exempt from the close/pointer debounce: Esc must always
    // close Help or Settings, even while a mouse report is still settling.
    if (isEscapeKey(key, pressed) && (ui.settingsMenu || ui.help)) {
      ui.settingsMenu = false;
      ui.help = false;
      ui.helpScroll = 0;
      session.invalidateHelpFrame();
      return;
    }
    if (state.closing || Date.now() < state.ignoreKeysUntil || Date.now() < state.mousePendingUntil) return;
    if (dispatchModal(key, pressed)) return;
    handleGlobalKey(key, pressed);
  }

  return { onMouseEvent, onRawInput, selectAt, handleKey };
}
