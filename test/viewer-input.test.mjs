import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandItems } from '../src/commands.mjs';
import {
  INPUT_MODAL_UI_FIELDS, createViewerInput, runFooterAction,
} from '../src/viewer-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The input module owns dispatch and hit testing, not durable state. This is a
// static contract check (the same style as the architecture scans): an edit
// that starts writing the view model, a snapshot, or an undocumented ui field
// fails here even if no test happens to exercise that branch.
test('input writes only the documented modal ui fields and never session state', async () => {
  const text = await readFile(resolve(root, 'src/viewer-input.mjs'), 'utf8');
  const assignment = /\bui\.([A-Za-z_$][\w$]*)\s*(?:[+\-*/%&|^]|\?\?|\|\||&&)?=(?!=)/g;
  const uiWrites = [...text.matchAll(assignment)].map(match => match[1]);
  assert.ok(uiWrites.length > 0, 'the scan sees the modal assignments');
  assert.deepEqual(
    [...new Set(uiWrites)].sort(),
    [...INPUT_MODAL_UI_FIELDS].sort(),
    'every ui write is documented in INPUT_MODAL_UI_FIELDS',
  );

  assert.doesNotMatch(text, /\bsession\.[A-Za-z_$][\w$]*\s*=(?!=)/, 'no session state writes');
  assert.doesNotMatch(text, /\bvm\.[A-Za-z_$][\w$]*\s*=(?!=)/, 'no view-model writes');
  assert.doesNotMatch(text, /\bsnapshot\.[A-Za-z_$][\w$]*\s*=(?!=)/, 'no snapshot mutation');
  assert.doesNotMatch(text, /Object\.assign\(ui\b/, 'transitions stay in the session');

  const stateWrites = [...text.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(match => match[1]);
  assert.deepEqual(
    [...new Set(stateWrites)].sort(),
    ['ignoreKeysUntil', 'mousePendingUntil', 'rawInput'],
    'only the viewer-owned input adapter state is written',
  );

  // The input module may not reach back into the render boundary or the viewer
  // factory; the composition root supplies those adapters.
  assert.doesNotMatch(text, /from\s+['"]\.\/render\.mjs['"]/);
  assert.doesNotMatch(text, /from\s+['"]\.\/viewer\.mjs['"]/);
});

function harness() {
  const calls = [];
  const ui = {
    language: 'en', help: false, helpScroll: 0, palette: false, paletteFilter: '', paletteIndex: 0,
    settingsMenu: false, settingsIndex: 0, switcher: null, tour: 0, mouseCapture: true,
    expanded: false, focus: 'graph',
  };
  const snapshot = { runs: [], tasks: [] };
  const vm = {
    ui,
    snapshot: null,
    frame: {
      hitboxes: {
        palette: new Map(),
        palettePanel: { x: 0, y: 0, w: 100, h: 100 },
        switcher: new Map(),
        settingsOptions: new Map(),
        nodes: new Map(),
        runs: new Map(),
      },
      run: { id: 'run', nodes: [] },
      layout: { layout: 'investigation', sidebar: true },
    },
  };
  const session = {
    ui,
    vm,
    get snapshot() { return snapshot; },
    addToast: (...args) => calls.push(['toast', ...args]),
    syncPointerViewModel: () => {
      vm.snapshot = snapshot;
      calls.push(['syncPointer']);
    },
    applyPaletteCommand: id => calls.push(['palette', id]),
    closePalette: () => {
      ui.palette = false;
      calls.push(['closePalette']);
    },
    moveSwitcherSelection: delta => calls.push(['switcherMove', delta]),
    scrollHelpPage: direction => calls.push(['helpScroll', direction]),
    scrollRegionBy: (region, delta) => calls.push(['scrollRegion', region, delta]),
    regionStep: () => 1,
    toggleHelp: () => {
      ui.help = !ui.help;
      calls.push(['toggleHelp']);
    },
    invalidateHelpFrame: () => calls.push(['invalidateHelp']),
  };
  const state = {
    pagerActive: false, closing: false, ignoreKeysUntil: 0, mousePendingUntil: 0, rawInput: Buffer.alloc(0),
  };
  const input = createViewerInput({
    session,
    state,
    requestFrame: () => calls.push(['frame']),
    draw: () => calls.push(['draw']),
    close: () => calls.push(['close']),
    openRecordInPager: () => {},
    setMouseCapture: () => {},
    engine: { reset: () => {} },
    interactive: false,
    demoMode: false,
    diagnosisForKey: () => null,
    diagnosisForSelection: () => null,
    recordForSelection: () => null,
    terminalWidth: () => 120,
    terminalHeight: () => 40,
  });
  return { input, ui, vm, state, calls };
}

test('raw mouse bytes resolve through selectAt and dispatch the matching command', () => {
  const { input, ui, vm, state, calls } = harness();
  const first = commandItems('en')[0].id;
  ui.palette = true;
  vm.frame.hitboxes.palette.set(first, { x: 0, y: 0, w: 100, h: 100 });

  // X10 left press at 0,0: the split key/press path must land in the palette.
  input.onRawInput(Buffer.from('\x1b[M\x20\x21\x21'));
  assert.ok(calls.some(([kind, id]) => kind === 'palette' && id === first));
  assert.ok(calls.some(([kind]) => kind === 'syncPointer'));
  assert.ok(calls.some(([kind]) => kind === 'frame'));
  assert.equal(ui.paletteIndex, 0);
  assert.ok(state.ignoreKeysUntil > Date.now(), 'the same bytes are debounced for key dispatch');

  // The keypress copy of the report is ignored while the mouse window is open.
  input.handleKey('a');
  assert.equal(ui.paletteFilter, '', 'a debounced keypress is not text input');

  state.ignoreKeysUntil = 0;
  state.mousePendingUntil = 0;
  input.handleKey('a');
  assert.equal(ui.paletteFilter, 'a', 'the palette keeps typing after the debounce');
  input.handleKey(undefined, { name: 'escape' });
  assert.equal(ui.palette, false);
  assert.ok(calls.some(([kind]) => kind === 'closePalette'));
});

test('modal and global dispatch drive session commands and only modal fields', () => {
  const { input, ui, calls } = harness();

  input.handleKey('?');
  assert.equal(ui.help, true, 'the global help action opens the modal');
  assert.ok(calls.some(([kind]) => kind === 'toggleHelp'));

  calls.length = 0;
  input.onMouseEvent({ button: 65, release: false, x: 1, y: 1 });
  assert.deepEqual(calls.find(([kind]) => kind === 'helpScroll'), ['helpScroll', 1]);
  assert.equal(ui.help, true, 'a wheel scroll never dismisses Help');

  calls.length = 0;
  input.onMouseEvent({ button: 0, release: false, x: 1, y: 1 });
  assert.equal(ui.help, false);
  assert.equal(ui.helpScroll, 0);
  assert.ok(calls.some(([kind]) => kind === 'draw'));
  assert.ok(calls.some(([kind]) => kind === 'invalidateHelp'));

  ui.help = false;
  ui.switcher = { query: '', activeKey: undefined };
  calls.length = 0;
  input.onMouseEvent({ button: 65, release: false, x: 1, y: 1 });
  assert.deepEqual(calls.find(([kind]) => kind === 'switcherMove'), ['switcherMove', 1]);

  ui.switcher = null;
  ui.settingsMenu = true;
  calls.length = 0;
  input.selectAt(1, 1);
  assert.equal(ui.settingsMenu, false, 'a settings backdrop click closes the modal');
  assert.ok(calls.some(([kind]) => kind === 'syncPointer'));

  ui.settingsMenu = true;
  ui.help = true;
  ui.helpScroll = 3;
  calls.length = 0;
  input.handleKey(undefined, { name: 'escape' });
  assert.equal(ui.settingsMenu, false, 'Esc is exempt from the pointer debounce');
  assert.equal(ui.help, false);
  assert.equal(ui.helpScroll, 0);
  assert.ok(calls.some(([kind]) => kind === 'invalidateHelp'));
});

test('footer chrome dispatch stays with the input module', () => {
  const calls = [];
  assert.equal(runFooterAction('mouse', { toggleMouse: () => calls.push('mouse') }), true);
  assert.equal(runFooterAction('clear', { clear: () => calls.push('clear') }), true);
  assert.equal(runFooterAction('legend', { toggleMouse: () => calls.push('wrong') }), false);
  assert.deepEqual(calls, ['mouse', 'clear']);
});
