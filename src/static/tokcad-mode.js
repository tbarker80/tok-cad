// TOKCAD: Beginner / Expert mode. Beginner trims the ribbon to the tools a first part needs and
// explains each one in its tooltip; Expert is the full studio. Nothing is removed from the
// page: advanced controls are hidden by a body class, so switching is instant and lossless.

const MODE_KEY = 'tokcad-mode';

export function getMode() {
  try { return localStorage.getItem(MODE_KEY); } catch { return null; }
}

// Ribbon tabs a beginner keeps; every other tab is hidden.
const BEGINNER_TABS = ['sketch', 'solid'];
// Whole ribbon groups hidden for beginners, by their title.
const ADVANCED_GROUPS = ['Reference', 'Advanced shape', 'Transform', 'Project'];
// Single controls hidden for beginners.
const ADVANCED_CONTROLS = [
  '[data-sktool="spline"]', '[data-sktool="offset"]', '#bw-sk-project',
  '#bw-thread-open', '#bw-structural-member-open', '#bw-structural-treatment-open', '#bw-weld-bead-open',
  '#bw-sheet-metal-open', '#bw-direct-push-pull-open', '#bw-replace-face-open', '#bw-delete-face-open',
  '[data-command-target="bw-export-dxf"]', '[data-command-target="bw-export-pdf-open"]',
];
// Controls with no id or data attribute, hidden by their visible label.
const ADVANCED_LABELS = ['Split body'];
// Plain-language tooltips for the tools a beginner sees.
const BEGINNER_TIPS = {
  '[data-feat="extrude"]': 'Extrude: pull a closed sketch straight up into a solid. Most parts start here.',
  '[data-feat="cut"]': 'Cut: remove material using a sketch, like drilling or milling a pocket.',
  '#bw-hole-wizard-open': 'Hole Wizard: add a standard hole (clearance, tapped, counterbore or countersink) by size.',
  '[data-feat="revolve"]': 'Revolve: spin a sketch around an axis, for round parts like shafts and knobs.',
  '[data-feat="fillet"]': 'Fillet: round off a sharp edge. Add these last.',
  '[data-feat="chamfer"]': 'Chamfer: bevel a sharp edge at an angle. Add these last.',
  '[data-feat="shell"]': 'Shell: hollow the part out to a wall thickness, for boxes and enclosures.',
  '[data-sktool="line"]': 'Line: click to place points; close the shape back at the start.',
  '[data-sktool="rect"]': 'Rectangle: click two opposite corners.',
  '[data-sktool="circle"]': 'Circle: click the center, then the edge.',
  '[data-sktool="arc"]': 'Arc: a curved line between two points.',
  '[data-sktool="poly"]': 'Polygon: a shape with equal sides, like a hexagon.',
  '[data-sktool="trim"]': 'Trim: click a line segment to remove it.',
};

let tagged = false;
let checkGroup = null;

function tagAdvanced() {
  if (tagged) return;
  tagged = true;
  for (const tab of document.querySelectorAll('[data-workspace]')) {
    if (!BEGINNER_TABS.includes(tab.dataset.workspace)) tab.classList.add('tokcad-adv');
  }
  for (const group of document.querySelectorAll('.ws-ribbon .ws-group')) {
    const title = group.querySelector('.wsg-title')?.textContent.trim();
    if (ADVANCED_GROUPS.includes(title)) group.classList.add('tokcad-adv');
  }
  for (const selector of ADVANCED_CONTROLS) {
    for (const node of document.querySelectorAll(selector)) node.classList.add('tokcad-adv');
  }
  for (const label of document.querySelectorAll('.ws-ribbon .wsr-label')) {
    if (ADVANCED_LABELS.includes(label.textContent.trim())) label.closest('button')?.classList.add('tokcad-adv');
  }
  for (const [selector, tip] of Object.entries(BEGINNER_TIPS)) {
    for (const node of document.querySelectorAll(selector)) {
      node.dataset.tokcadTip = tip;
      node.dataset.tokcadExpertTitle = node.getAttribute('title') || '';
    }
  }
  // A small "Check" group in 3D Tools for beginners: measure, weight and volume.
  const solidTools = document.querySelector('#ws-panel-solid');
  if (solidTools) {
    checkGroup = document.createElement('div');
    checkGroup.className = 'ws-group tokcad-beginner-only';
    checkGroup.innerHTML = '<span class="wsg-title">Check</span><div class="wsg-tools"></div>';
    const tools = checkGroup.querySelector('.wsg-tools');
    for (const [command, label, tip] of [
      ['measure', 'Measure', 'Measure: click faces and edges to read distances, diameters and angles.'],
      ['properties', 'Weight & volume', 'Weight and volume of the part, from its material.'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wsr-btn is-compact';
      button.title = tip;
      button.textContent = label;
      button.addEventListener('click', () => document.querySelector(`[data-inspection-command="${command}"]`)?.click());
      tools.append(button);
    }
    solidTools.append(checkGroup);
  }
}

export function setMode(mode) {
  if (mode !== 'beginner' && mode !== 'expert') return;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  applyMode();
  globalThis.dispatchEvent(new CustomEvent('tokcad:mode', { detail: mode }));
}

export function applyMode() {
  tagAdvanced();
  const beginner = getMode() !== 'expert';         // undecided visitors see the simple studio
  document.body.classList.toggle('tokcad-beginner', beginner);
  for (const node of document.querySelectorAll('[data-tokcad-tip]')) {
    node.setAttribute('title', beginner ? node.dataset.tokcadTip : node.dataset.tokcadExpertTitle);
  }
  // A beginner never lands on a hidden tab.
  const active = document.querySelector('[data-workspace][aria-selected="true"]');
  if (beginner && active && !BEGINNER_TABS.includes(active.dataset.workspace)) {
    document.querySelector('[data-workspace="solid"]')?.click();
  }
  const toggle = document.getElementById('tokcad-mode-toggle');
  if (toggle) toggle.textContent = beginner ? 'Beginner mode' : 'Expert mode';
}

function init() {
  applyMode();
  const help = document.getElementById('bw-help-status');
  if (help && !document.getElementById('tokcad-mode-toggle')) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'tokcad-mode-toggle';
    toggle.title = 'Switch between the simple Beginner studio and the full Expert studio';
    toggle.addEventListener('click', () => setMode(getMode() === 'expert' ? 'beginner' : 'expert'));
    help.before(toggle);
    applyMode();
  }
  globalThis.TokcadMode = { get: getMode, set: setMode };
}

if (globalThis.TokcadStudio) init();
else globalThis.addEventListener('tokcad:studio-ready', init, { once: true });
