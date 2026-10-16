// TOKCAD: the engineering coach. A checklist beside the model that walks a beginner through the
// way an engineer designs a part: decide what it's for and how it will be made, build the main
// body, fully define the sketches, add details in a sensible order, name the sizes that matter,
// check it, and hand it over. Steps tick themselves off by reading the model, not by clicking.
//
// Design intent is saved in the part (part.extensions.tokcad.intent, through TokcadStudio), so it
// travels with the project. Panel state (collapsed, closed, measured, exported) is per project in
// this browser's localStorage: it is about this user's session, not the design.

import { sketchDof } from './studio-sketch-solver.js';

export const PROCESSES = Object.freeze({
  printed: { label: '3D printed', up: 'the direction the printer builds (up from the bed)' },
  machined: { label: 'Machined (CNC)', up: 'the direction the cutter comes from' },
  molded: { label: 'Injection molded', up: 'the direction the mold opens' },
  unsure: { label: 'Not sure yet', up: 'up' },
});

const WHY = {
  intent: {
    any: 'Engineers start with the job the part has to do and how it will be made, because that choice changes the rules. ' +
      'A molded part needs sloped walls to come out of the mold, a machined part can\'t have sharp inside corners, and a printed part struggles with overhangs.',
  },
  base: {
    any: 'Start with the biggest, simplest shape: the block the part is made from. Details like holes and rounded edges come later, on top of it.',
    printed: 'Put the part\'s largest flat face on the ground plane: that face sits on the print bed and gives the print a stable start.',
    machined: 'Picture the bar or block of metal you would start from, and model that first. Everything after it is material the machine removes.',
    molded: 'Model the part standing the way it comes out of the mold: up (Z) is the direction the mold opens.',
  },
  sketches: {
    any: 'A sketch is fully defined when every line has a size and the shape is tied to the origin. Otherwise it can quietly change shape when you edit something else, and the part changes with it.',
  },
  order: {
    any: 'Add cuts and holes first, rounded edges (fillets) and chamfers last. A fillet on an edge that a later cut removes is the most common way a model breaks.',
  },
  params: {
    any: 'Give the sizes that matter a name, like wall = 2 or hole_spacing = 40. Then one change updates every feature that uses it, the way real design changes happen.',
  },
  check: {
    any: 'Before anyone makes the part, measure the sizes that have to fit and look at its weight and volume.',
    printed: 'For printing, look for overhangs steeper than 45°, walls thinner than about 0.8 mm, and tiny holes that will close up.',
    machined: 'For machining, look for sharp inside corners (a round cutter can\'t make them), deep narrow pockets, and thin walls that will vibrate.',
    molded: 'For molding, look for walls without draft (slope), walls that change thickness a lot, and sharp inside corners.',
  },
  output: {
    any: 'Hand over the right file: a supplier wants a STEP file, a 3D printer\'s slicer wants STL, and a drawing carries the tolerances that matter.',
  },
};

let studio = null;
let panel = null;
let lastState = null;

// ── per-project panel state ────────────────────────────────────────────────────────────────
function prefsKey(doc) { return 'tokcad-coach:' + (doc?.projectId || 'none'); }
function prefs(doc) {
  try { return JSON.parse(localStorage.getItem(prefsKey(doc)) || '{}'); } catch { return {}; }
}
function setPrefs(doc, patch) {
  const next = { ...prefs(doc), ...patch };
  try { localStorage.setItem(prefsKey(doc), JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

// ── reading the model ──────────────────────────────────────────────────────────────────────
function rootPart(doc) {
  const parts = doc?.partDefinitions || [];
  const id = doc?.rootDocument?.kind === 'part' ? doc.rootDocument.partId : null;
  return parts.find((part) => part.id === id) || (parts.length === 1 ? parts[0] : null);
}

function isImported(part) {
  return Boolean(part?.features?.some((feature) => feature.extensions?.studioImportedStep) ||
    part?.bodies?.some((body) => body.extensions?.studioImportedStep));
}

const DETAIL = /fillet|chamfer|round/i;
const CUTLIKE = /cut|hole|pocket|bore/i;

/** Everything the checklist needs, from the document and the scene. */
export function readModel(doc, solids) {
  const part = rootPart(doc);
  const features = part?.features || [];
  const imported = isImported(part);
  const intent = part?.extensions?.tokcad?.intent || null;

  const underDefined = [];
  for (const feature of features) {
    const constrained = feature.sketch?.constrained;
    if (!constrained) continue;
    try {
      const status = sketchDof(constrained, { analyzeDefinition: true });
      if (!status?.fullyDefined) underDefined.push({ name: feature.name || feature.type || feature.id, dof: status?.dof ?? null });
    } catch {
      underDefined.push({ name: feature.name || feature.id, dof: null });
    }
  }

  const types = features.map((feature) => String(feature.type || ''));
  const firstDetail = types.findIndex((type) => DETAIL.test(type));
  const lastCut = types.map((type) => CUTLIKE.test(type)).lastIndexOf(true);
  const detailBeforeCut = firstDetail !== -1 && lastCut > firstDetail;

  const parameters = [...(doc?.parameters || []), ...(part?.parameters || [])].map((p) => p.name).filter(Boolean);
  const json = JSON.stringify(features);
  const usedParameters = parameters.filter((name) => new RegExp('\\b' + name.replace(/[^\w]/g, '') + '\\b').test(json));

  return {
    part, features, imported, intent, underDefined, detailBeforeCut, parameters, usedParameters,
    hasSolid: solids > 0 || features.some((feature) => /extrude|revolve|loft|sweep|import/i.test(String(feature.type))),
  };
}

/** The seven steps with done / not applicable, from the model and this project's panel state. */
export function coachSteps(model, panelState) {
  const process = model.intent?.process || null;
  const na = model.imported;
  return [
    { id: 'intent', title: 'Decide what you\'re making', done: Boolean(process) },
    { id: 'base', title: 'Make the main body', done: model.hasSolid, na },
    { id: 'sketches', title: 'Fully define your sketches', done: model.hasSolid && model.underDefined.length === 0, na },
    { id: 'order', title: 'Add details in a sensible order', done: model.features.length >= 2 && !model.detailBeforeCut, na },
    { id: 'params', title: 'Name the sizes that matter', done: model.usedParameters.length > 0, na },
    { id: 'check', title: 'Check the part', done: Boolean(panelState.checked) },
    { id: 'output', title: 'Hand it over', done: Boolean(panelState.exported) },
  ];
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────
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

function why(stepId, process) {
  const text = WHY[stepId] || {};
  const parts = [text.any, process && text[process]].filter(Boolean);
  const details = el('details', { class: 'tokcad-why' }, el('summary', {}, 'Why?'), ...parts.map((t) => el('p', {}, t)));
  return details;
}

function intentForm(model) {
  const intent = model.intent || {};
  const purpose = el('input', { type: 'text', name: 'purpose', maxlength: '200', placeholder: 'e.g. a bracket to hold a sensor on a 20 mm rail',
    value: intent.purpose || '' });
  const keyDims = el('input', { type: 'text', name: 'keyDims', maxlength: '200', placeholder: 'e.g. holes 40 mm apart to match the rail',
    value: intent.keyDims || '' });
  const choices = Object.entries(PROCESSES).map(([id, info]) => el('label', { class: 'tokcad-radio' },
    el('input', { type: 'radio', name: 'process', value: id, checked: intent.process === id }), ' ' + info.label));
  const form = el('form', { class: 'tokcad-intent' },
    el('label', {}, el('span', {}, 'What is it for?'), purpose),
    el('fieldset', {}, el('legend', {}, 'How will it be made?'), ...choices),
    el('label', {}, el('span', {}, 'Which sizes or features have to fit something else?'), keyDims),
    el('button', { type: 'submit', class: 'tokcad-btn tokcad-primary' }, intent.process ? 'Update' : 'Save'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.process) { studio.say('Pick how the part will be made (or "Not sure yet").'); return; }
    const saved = studio.setPartExtension('intent', {
      purpose: String(data.purpose || '').slice(0, 200),
      process: data.process,
      keyDims: String(data.keyDims || '').slice(0, 200),
      up: '+Z',
    }, 'Design intent');
    if (!saved) studio.say('Start a part first: the design notes are saved with it.');
  });
  return form;
}

function stepBody(step, model, panelState, doc) {
  const process = model.intent?.process;
  const body = [];
  if (step.id === 'intent') body.push(intentForm(model));
  if (step.id === 'base') {
    body.push(el('p', {}, step.done ? 'Done: the part has a solid body.' :
      'Use Extrude on a closed sketch, or open the start screen and pick a basic shape.'));
  }
  if (step.id === 'sketches') {
    if (!model.underDefined.length) {
      body.push(el('p', {}, step.done ? 'Every sketch is fully defined, or sized by named dimensions.' : 'Make a body first.'));
    } else {
      body.push(el('p', {}, 'These sketches can still change shape:'),
        el('ul', {}, model.underDefined.map((s) => el('li', {}, s.name + (s.dof != null ? ` (${s.dof} size${s.dof === 1 ? '' : 's'} or position${s.dof === 1 ? '' : 's'} still free)` : '')))),
        el('p', { class: 'tokcad-hint' }, 'Open the sketch, add dimensions to every line, and dimension one corner from the origin.'));
    }
  }
  if (step.id === 'order') {
    body.push(el('p', {}, model.detailBeforeCut
      ? 'A fillet or chamfer comes before a cut in the feature list. Drag it below the cut, or recreate it last.'
      : model.features.length >= 2 ? 'Good: details come after the cuts.' : 'Add holes and cuts to your body, then fillets and chamfers last.'));
  }
  if (step.id === 'params') {
    body.push(el('p', {}, model.usedParameters.length
      ? 'Named sizes in use: ' + model.usedParameters.slice(0, 6).join(', ') + (model.usedParameters.length > 6 ? '…' : '') + '.'
      : 'In the Parameters panel (bottom right), add a size like "wall = 2", then type "wall" instead of a number in a feature.'));
  }
  if (step.id === 'check') {
    const run = (command) => () => {
      document.querySelector(`[data-inspection-command="${command}"]`)?.click();
      setPrefs(doc, { checked: true });
      render();
    };
    body.push(el('div', { class: 'tokcad-actions' },
      el('button', { type: 'button', class: 'tokcad-btn', onclick: run('measure') }, 'Measure'),
      el('button', { type: 'button', class: 'tokcad-btn', onclick: run('properties') }, 'Weight & volume'),
      globalThis.TokcadChecks
        ? el('button', { type: 'button', class: 'tokcad-btn tokcad-primary', onclick: () => { setPrefs(doc, { checked: true }); globalThis.TokcadChecks.run(); render(); } },
          'Check for ' + (PROCESSES[process]?.label.toLowerCase() || 'manufacturing'))
        : null));
  }
  if (step.id === 'output') {
    const exp = (id) => () => { document.getElementById(id)?.click(); setPrefs(doc, { exported: true }); render(); };
    body.push(el('div', { class: 'tokcad-actions' },
      el('button', { type: 'button', class: 'tokcad-btn', onclick: exp('bw-export-step') }, 'STEP for a supplier'),
      el('button', { type: 'button', class: 'tokcad-btn', onclick: exp('bw-export-stl') }, 'STL for printing'),
      el('button', { type: 'button', class: 'tokcad-btn', onclick: exp('bw-export-drawing') }, 'Drawing (PDF)')));
  }
  body.push(why(step.id, process));
  return body;
}

function render() {
  if (!panel || !studio) return;
  const doc = studio.document();
  const state = prefs(doc);
  const model = readModel(doc, studio.bodyMeshes().size);
  const steps = coachSteps(model, state);
  const doneCount = steps.filter((s) => s.done || s.na).length;
  const current = steps.find((s) => !s.done && !s.na) || null;
  lastState = { steps, model };

  panel.hidden = Boolean(state.closed) || !studio.hasContent() && !model.intent;
  panel.replaceChildren(
    el('header', {},
      el('button', { type: 'button', class: 'tokcad-coach-toggle', 'aria-expanded': String(!state.collapsed),
        onclick: () => { setPrefs(doc, { collapsed: !state.collapsed }); render(); } },
      el('b', {}, 'Engineering coach'), el('span', {}, ` ${doneCount} of ${steps.length}`)),
      el('button', { type: 'button', class: 'tokcad-coach-close', title: 'Close the coach for this part', 'aria-label': 'Close the coach',
        onclick: () => { setPrefs(doc, { closed: true }); render(); } }, '×')),
    state.collapsed ? null : el('ol', { class: 'tokcad-steps' }, steps.map((step) => {
      const open = state.open === step.id || (!state.open && step === current);
      const mark = step.na ? '–' : step.done ? '✓' : '';
      return el('li', { class: 'tokcad-step' + (step.done ? ' is-done' : '') + (step.na ? ' is-na' : '') + (open ? ' is-open' : ''), 'data-step': step.id },
        el('button', { type: 'button', class: 'tokcad-step-head', 'aria-expanded': String(open),
          onclick: () => { setPrefs(doc, { open: open ? '__none__' : step.id }); render(); } },
        el('span', { class: 'tokcad-mark', 'aria-hidden': 'true' }, mark),
        el('span', {}, step.title),
        step.na ? el('small', {}, 'not needed for an imported part') : null),
        open ? el('div', { class: 'tokcad-step-body' }, stepBody(step, model, state, doc)) : null);
    })),
  );
}

function init(tokcadStudio) {
  studio = tokcadStudio;
  panel = el('section', { class: 'tokcad-coach', id: 'tokcad-coach', 'aria-label': 'Engineering coach' });
  const side = document.getElementById('bw-side');
  (side || document.body).prepend(panel);
  // A way to bring it back after closing it, beside "New part…" in the status bar.
  const help = document.getElementById('bw-help-status');
  help?.before(el('button', { type: 'button', id: 'tokcad-coach-open',
    onclick: () => { setPrefs(studio.document(), { closed: false, collapsed: false }); render(); } }, 'Coach'));
  // Exports from the toolbar count too.
  for (const id of ['bw-export-step', 'bw-export-stl', 'bw-export-drawing', 'bw-export-3mf']) {
    document.getElementById(id)?.addEventListener('click', () => { setPrefs(studio.document(), { exported: true }); render(); });
  }
  studio.on(() => render());
  globalThis.TokcadCoach = { render, state: () => lastState };
  render();
}

if (globalThis.TokcadStudio) init(globalThis.TokcadStudio);
else globalThis.addEventListener('tokcad:studio-ready', () => init(globalThis.TokcadStudio), { once: true });
