// TOKCAD: TOK CAD's start screen. Replaces the upstream first-visit welcome with a guided start:
// drop a file, start from scratch (a sketch or a primitive shape), or start from an example.
// Shown whenever a new, empty part starts, unless the user turns it off.
//
// Everything acts through globalThis.TokcadStudio (the hook at the end of studio.js), so no
// studio logic is duplicated: files go through the studio's own open handler, primitives open
// like templates.

import { TOKCAD_PRIMITIVES, buildTokcadPrimitive, getTokcadPrimitive } from './tokcad-primitives.js';

const PREF_KEY = 'tokcad-start-hidden';
const FILE_TYPES = '.step,.stp,.dxf,.json';

function prefHidden() {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}
function setPrefHidden(hidden) {
  try { hidden ? localStorage.setItem(PREF_KEY, '1') : localStorage.removeItem(PREF_KEY); } catch { /* private mode */ }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Dimension sketches for the shape cards and forms (simple line drawings, no external assets).
const SHAPE_ART = {
  block: '<svg viewBox="0 0 120 80"><path d="M25 30 L70 18 L100 32 L55 45 Z M25 30 L25 58 L55 72 L55 45 M55 72 L100 58 L100 32"/></svg>',
  cylinder: '<svg viewBox="0 0 120 80"><ellipse cx="60" cy="20" rx="26" ry="9"/><path d="M34 20 L34 60 M86 20 L86 60"/><path d="M34 60 A26 9 0 0 0 86 60"/></svg>',
  tube: '<svg viewBox="0 0 120 80"><ellipse cx="60" cy="20" rx="26" ry="9"/><ellipse cx="60" cy="20" rx="16" ry="5.5"/><path d="M34 20 L34 60 M86 20 L86 60"/><path d="M34 60 A26 9 0 0 0 86 60"/></svg>',
  plate: '<svg viewBox="0 0 120 80"><path d="M15 38 L70 22 L108 36 L53 52 Z M15 38 L15 46 L53 60 L53 52 M53 60 L108 44 L108 36"/><ellipse cx="34" cy="38" rx="4" ry="2"/><ellipse cx="66" cy="28" rx="4" ry="2"/><ellipse cx="57" cy="47" rx="4" ry="2"/><ellipse cx="89" cy="36" rx="4" ry="2"/></svg>',
  'l-bracket': '<svg viewBox="0 0 120 80"><path d="M30 15 L42 12 L42 52 L92 40 L100 46 L38 62 L30 58 Z M30 15 L30 58"/></svg>',
};

let studio = null;
let overlay = null;
let pendingStep = null;      // name of a STEP file just opened from the start screen or toolbar
let ourActionUntil = 0;      // the start screen itself is creating the new part (a short window)
let hadContent = false;

function close() {
  overlay?.remove();
  overlay = null;
}

function frame(title, subtitle, body, { back = null, kind = 'start' } = {}) {
  close();
  const dontShow = el('input', { type: 'checkbox', id: 'tokcad-start-hide' });
  dontShow.checked = prefHidden();
  dontShow.addEventListener('change', () => setPrefHidden(dontShow.checked));
  overlay = el('div', { class: 'tokcad-start', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tokcad-start-title' },
    el('div', { class: 'tokcad-start-card' },
      el('header', {},
        back ? el('button', { type: 'button', class: 'tokcad-back', onclick: back }, '← Back') : null,
        el('h1', { id: 'tokcad-start-title' }, title),
        subtitle ? el('p', { class: 'tokcad-sub' }, subtitle) : null,
      ),
      body,
      el('footer', {},
        el('label', { class: 'tokcad-hide' }, dontShow, ' Don\'t show this when I start a new part'),
        el('button', { type: 'button', class: 'tokcad-link', onclick: close }, 'Close and use the full toolbar'),
      ),
    ),
  );
  overlay.dataset.kind = kind;
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  document.body.append(overlay);
  overlay.querySelector('button, input')?.focus();
}

// ── Screen 1: how do you want to begin? ────────────────────────────────────────────────────
export function showStart() {
  const browse = el('input', { type: 'file', accept: FILE_TYPES, hidden: true });
  browse.addEventListener('change', () => { if (browse.files?.[0]) openFile(browse.files[0]); });
  const drop = el('div', { class: 'tokcad-drop', tabindex: '0', role: 'button',
    'aria-label': 'Drop a STEP, DXF or TOK CAD file here, or press Enter to browse',
    onclick: () => browse.click(),
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); browse.click(); } } },
  el('div', { class: 'tokcad-drop-icon', 'aria-hidden': 'true' }, '⇩'),
  el('strong', {}, 'Drop a part file here'),
  el('span', {}, 'STEP (.step, .stp) from any CAD program, a DXF outline, or a TOK CAD project'),
  el('span', { class: 'tokcad-btn' }, 'or browse your computer'),
  browse);
  frame('Start a new part', 'TOK CAD walks you from an idea to a part you can make. How do you want to begin?',
    el('div', { class: 'tokcad-start-body' },
      drop,
      el('div', { class: 'tokcad-choices' },
        el('button', { type: 'button', class: 'tokcad-choice', onclick: showScratch },
          el('strong', {}, 'Start from scratch'),
          el('span', {}, 'Design your own part, from a sketch or a basic shape.')),
        el('button', { type: 'button', class: 'tokcad-choice', onclick: () => { close(); studio.openTemplateLibrary(); } },
          el('strong', {}, 'Start from an example'),
          el('span', {}, '30 ready-made parts (plates, brackets, knobs, enclosures) to change and learn from.')),
      ),
    ));
}

// ── Screen 2: from scratch ─────────────────────────────────────────────────────────────────
function showScratch() {
  frame('How do you want to start?', 'Both give you a fully editable part. Engineers usually start with a sketch.',
    el('div', { class: 'tokcad-start-body' },
      el('div', { class: 'tokcad-choices' },
        el('button', { type: 'button', class: 'tokcad-choice tokcad-choice-big', onclick: startSketch },
          el('strong', {}, 'Sketch it'),
          el('span', {}, 'Draw the outline of your part on the ground plane, give it exact dimensions, then pull it up into 3D. ' +
            'This is how most real parts begin.'),
          el('em', {}, 'Tip: draw the shape you would see looking down on the part as it sits on a table.')),
      ),
      el('h2', {}, 'Or start from a basic shape'),
      el('div', { class: 'tokcad-shapes' },
        TOKCAD_PRIMITIVES.map((primitive) => {
          const art = el('div', { class: 'tokcad-art', 'aria-hidden': 'true' });
          art.innerHTML = SHAPE_ART[primitive.id] || '';
          return el('button', { type: 'button', class: 'tokcad-shape', onclick: () => showPrimitive(primitive.id) },
            art, el('strong', {}, primitive.name));
        })),
    ), { back: showStart });
}

function startSketch() {
  close();
  ourActionUntil = Date.now() + 3000;
  studio.startBlank();
  // startBlank opens Extrude's "choose a face" step; an empty part sketches on the base plane.
  setTimeout(() => {
    const base = document.getElementById('bw-face-base');
    if (base && base.offsetParent !== null) base.click();
    studio.say('Sketching on the ground plane. Draw your outline, then add dimensions so every line has an exact size.');
  }, 50);
}

// ── Screen 3: a primitive's dimensions ─────────────────────────────────────────────────────
function showPrimitive(id) {
  const primitive = getTokcadPrimitive(id);
  const error = el('p', { class: 'tokcad-error', role: 'alert' });
  const inputs = primitive.fields.map((field) => {
    const input = el('input', { type: 'number', name: field.name, value: String(field.value), min: '0.01', step: 'any', required: true });
    return el('label', {}, el('span', {}, field.label), el('span', { class: 'tokcad-unit' }, input, ' mm'));
  });
  const art = el('div', { class: 'tokcad-art tokcad-art-big', 'aria-hidden': 'true' });
  art.innerHTML = SHAPE_ART[id] || '';
  const form = el('form', { class: 'tokcad-form' },
    art,
    el('p', {}, primitive.explain),
    el('div', { class: 'tokcad-fields' }, inputs),
    el('p', { class: 'tokcad-note' }, 'Each size becomes a named parameter. You can change any of them later and the part rebuilds.'),
    error,
    el('button', { type: 'submit', class: 'tokcad-btn tokcad-primary' }, 'Create ' + primitive.name.toLowerCase()));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      const template = buildTokcadPrimitive(id, values);
      close();
      ourActionUntil = Date.now() + 3000;
      studio.openTemplate(template);
    } catch (problem) {
      error.textContent = problem.message;
    }
  });
  frame(primitive.name, 'Enter the sizes you want, in millimeters.', el('div', { class: 'tokcad-start-body' }, form), { back: showScratch });
}

// ── Files: drop or browse, then "what next?" ───────────────────────────────────────────────
function isStep(name) {
  return /\.(step|stp)$/i.test(name || '');
}

function openFile(file) {
  if (!/\.(step|stp|dxf|json)$/i.test(file.name)) {
    studio.say('TOK CAD opens STEP (.step, .stp), DXF and TOK CAD project (.json) files.');
    return;
  }
  close();
  ourActionUntil = Date.now() + 3000;
  pendingStep = isStep(file.name) ? file.name : null;
  studio.openFile(file);
}

function showWhatNext(fileName) {
  const go = (fn) => () => { close(); fn(); };
  const click = (selector) => document.querySelector(selector)?.click();
  frame('What do you want to do with this part?', '“' + fileName + '” is open. A STEP file is a finished solid: ' +
    'you can measure it, add to it, check it or export it.',
  el('div', { class: 'tokcad-start-body' },
    el('div', { class: 'tokcad-next' },
      el('button', { type: 'button', class: 'tokcad-choice', onclick: go(() => click('[data-inspection-command="measure"]')) },
        el('strong', {}, 'Measure and inspect it'),
        el('span', {}, 'Click faces and edges to read distances, diameters and angles.')),
      el('button', { type: 'button', class: 'tokcad-choice', onclick: go(() => studio.say(
        'An imported STEP has no feature history. Change it by adding features on top: Cut, Hole Wizard, Fillet, or Direct Push/Pull on a face.')) },
        el('strong', {}, 'Change it'),
        el('span', {}, 'Add holes, cuts, fillets, or push and pull its faces.')),
      el('button', { type: 'button', class: 'tokcad-choice', disabled: true },
        el('strong', {}, 'Check it for manufacturing'),
        el('span', {}, 'Coming soon: draft, wall thickness, sharp corners and overhangs for molding, machining or 3D printing.')),
      el('button', { type: 'button', class: 'tokcad-choice', onclick: go(() => click('#bw-export-stl')) },
        el('strong', {}, 'Export it for 3D printing'),
        el('span', {}, 'Save it as an STL file for a slicer.')),
    ),
  ), { kind: 'next' });
}

// The whole window accepts a dropped file while the start screen is open.
function installDropTarget() {
  const active = () => Boolean(overlay);
  window.addEventListener('dragover', (event) => {
    if (!active() || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    overlay.classList.add('is-dragging');
  });
  window.addEventListener('dragleave', (event) => {
    if (active() && event.relatedTarget === null) overlay.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (event) => {
    if (!active() || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    openFile(event.dataTransfer.files[0]);
  });
}

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────
function onStudioEvent(kind) {
  if (kind !== 'change') return;
  const hasContent = studio.hasContent();
  if (hasContent && pendingStep) {
    const name = pendingStep;
    pendingStep = null;
    setTimeout(() => showWhatNext(name), 200);
  } else if (!hasContent && hadContent && Date.now() > ourActionUntil && !prefHidden()) {
    showStart();                              // New / Clear: a fresh empty part
  }
  if (hasContent && overlay?.dataset.kind === 'start') close();   // never the "what next" card
  hadContent = hasContent;
}

function init(tokcadStudio) {
  studio = tokcadStudio;
  // The upstream welcome is replaced by this start screen.
  const welcome = document.getElementById('bw-welcome');
  if (welcome) welcome.hidden = true;
  new MutationObserver(() => { if (welcome && !welcome.hidden) welcome.hidden = true; })
    .observe(welcome || document.body, { attributes: true, attributeFilter: ['hidden'] });
  // STEP files opened from the toolbar also get the "what next" card.
  document.getElementById('bw-open-file')?.addEventListener('change', (event) => {
    const name = event.target.files?.[0]?.name;
    if (isStep(name) && !pendingStep) pendingStep = name;
  }, true);
  // Clearer labels on the upstream open control.
  const openBtn = document.getElementById('bw-open-btn');
  if (openBtn) openBtn.title = 'Open a project, or import STEP / DXF';
  // A way back to the start screen at any time, beside Help in the status bar.
  const help = document.getElementById('bw-help-status');
  help?.before(el('button', { type: 'button', id: 'tokcad-start-open', onclick: showStart }, 'New part…'));
  installDropTarget();
  studio.on(onStudioEvent);
  hadContent = studio.hasContent();
  globalThis.TokcadStart = { show: showStart };
  if (!hadContent && !prefHidden()) showStart();
}

if (globalThis.TokcadStudio) init(globalThis.TokcadStudio);
else globalThis.addEventListener('tokcad:studio-ready', () => init(globalThis.TokcadStudio), { once: true });
