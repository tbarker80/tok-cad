// TOKCAD: the molding check. Sends the part (as STEP) through TOK CAD's server to a private
// molding-analysis service and shows what comes back on the model: draft, wall thickness,
// undercuts with the slides and lifters they need, the two mold halves and the parting line.
//
// The service returns its own triangle mesh of the part (the STEP file tessellated, every
// triangle tagged with the CAD face it belongs to) with a value per triangle. That mesh is
// drawn over the part, so nothing here has to match triangles with the studio's own meshes.
// Results are for the model as it was sent; any edit clears them.

const DRAFT_NONE_DEG = 0.25;        // a face this close to the pull direction has no draft
const DRAFT_LOW_DEG = 1;            // the usual minimum; 1–3° is better for textured faces
const THIN_FRACTION = 0.6;          // walls under 60% of the nominal thickness may not fill
const THICK_FRACTION = 1.5;         // and over 150% risk sink marks and long cooling

const VIEWS = Object.freeze({
  draft: 'Draft',
  thickness: 'Wall thickness',
  undercut: 'Undercuts',
  halves: 'Mold halves',
});
const PULLS = Object.freeze({
  auto: { label: 'Work it out', vector: null },
  '+z': { label: '+Z (up)', vector: [0, 0, 1] },
  '-z': { label: '−Z', vector: [0, 0, -1] },
  '+y': { label: '+Y', vector: [0, 1, 0] },
  '-y': { label: '−Y', vector: [0, -1, 0] },
  '+x': { label: '+X', vector: [1, 0, 0] },
  '-x': { label: '−X', vector: [-1, 0, 0] },
});

const RED = [0.88, 0.15, 0.18], ORANGE = [0.95, 0.52, 0.10], YELLOW = [0.90, 0.82, 0.12], GREEN = [0.18, 0.78, 0.35];
const BLUE = [0.33, 0.58, 0.95], TEAL = [0.25, 0.80, 0.78], GREY = [0.55, 0.58, 0.62], MAGENTA = [0.85, 0.30, 0.85];
const PARTING_COLOR = 0xffe14d;
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

const WHY = {
  draft: 'A molded part shrinks onto the mold as it cools. Walls that run straight along the opening direction scrape ' +
    'or stick when the part is pushed out, so they get a slight slope, called draft: at least 1°, more on textured faces.',
  thickness: 'Plastic cools from the outside in. Thin spots may not fill before the plastic freezes; thick spots ' +
    'cool last and pull the surface in (sink marks). Keeping walls close to one thickness is the most important molding rule.',
  undercut: 'An undercut is any shape that would lock the part in the mold when it opens, like a side hole or a snap hook. ' +
    'Each needs a moving part in the mold (a slide, or a lifter), which adds cost, so designers remove them where they can.',
  halves: 'A simple mold is two halves. The parting line goes on a flat end face where it can, and the cavity half forms that end; ' +
    'the core half forms the walls and the inside, and the part stays on it to be pushed off. ' +
    'the part stays on it to be pushed off. The yellow line is where the halves meet, and leaves a faint line on the part.',
};

let studio = null;
let panel = null;
let state = {
  open: false, busy: false, message: '', error: false,
  pull: 'auto', view: 'draft', result: null, session: null, sentHash: null,
  account: null,        // { signedIn, verified, available, csrfToken }
  highlight: null,      // { body, face } shown by "Show me"
  // Show faces (cosmetic) the user named for this project: null = not asked yet, [] = none.
  showFaces: null, showFacesProject: null, asking: false, filterBefore: null,
};
let overlay = null;     // THREE.Group under the studio's partGroup

// ── talking to the server ──────────────────────────────────────────────────────────────────
async function loadAccount() {
  const [status, account] = await Promise.all([
    fetch('/api/v1/mold/status', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null),
    fetch('/api/v1/account', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null),
  ]);
  state.account = {
    available: Boolean(status?.available),
    signedIn: Boolean(status?.signedIn),
    verified: Boolean(status?.verified),
    csrfToken: typeof account?.csrfToken === 'string' ? account.csrfToken : '',
  };
  return state.account;
}

async function api(path, { body, type }) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': type, 'x-partmode-csrf': state.account?.csrfToken || '' },
    body,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error?.message || value?.message || value?.error || 'The molding check failed.');
  return value;
}

// -- Show faces: asked once per project, before the first check ---------------------------
function projectId() {
  return studio.document()?.projectId || null;
}

function askShowFaces() {
  state.open = true;
  state.asking = true;
  state.error = false;
  state.message = '';
  // Clicks pick faces while the question is open; the previous filter comes back after.
  if (state.filterBefore === null) state.filterBefore = studio.setSelectionFilter('face');
  render();
}

function answerShowFaces(useSelection) {
  if (useSelection) {
    const picked = studio.selectedFaces();
    if (!picked.length) {
      state.error = true;
      state.message = 'Select the show face on the part first: click it in the 3D view (Ctrl+click to add more).';
      render();
      return;
    }
    state.showFaces = picked.map((f) => f.sig);
  } else {
    state.showFaces = [];
  }
  state.showFacesProject = projectId();
  state.asking = false;
  if (state.filterBefore !== null) { studio.setSelectionFilter(state.filterBefore); state.filterBefore = null; }
  run();
}

async function run() {
  if (state.busy) return;
  state.open = true;
  state.asking = false;
  state.busy = true;
  state.error = false;
  state.message = 'Checking your account…';
  render();
  try {
    const account = await loadAccount();
    if (!account.available) throw new Error('The molding check is not available on this server right now.');
    if (!account.signedIn) throw new Error('signin');
    if (!account.verified) throw new Error('Verify your email address (see the account page) to run the molding check.');
    // The show face is the user's to say: ask before the first check of each project (after the
    // account checks, so nobody is asked a question and then told to sign in).
    if (state.showFaces === null || state.showFacesProject !== projectId()) {
      state.busy = false;
      askShowFaces();
      return;
    }
    const hash = studio.contentHash();
    // The service keeps the part for a session; send it again only when the model changed.
    if (!state.session || state.sentHash !== hash) {
      state.message = 'Sending the part…';
      render();
      const exported = await studio.exportStepBlob();
      if (exported.error) throw new Error(exported.error);
      state.session = (await api('/api/v1/mold/sessions', { body: exported.blob, type: 'application/octet-stream' })).session;
      state.sentHash = hash;
    }
    state.message = 'Analyzing for molding (this can take up to a minute)…';
    render();
    const pull = state.pull === 'custom' ? state.customPull : (PULLS[state.pull]?.vector || null);
    const result = await api(`/api/v1/mold/sessions/${state.session}/analyze`,
      { body: JSON.stringify({ ...(pull ? { pull } : {}), ...(state.showFaces.length ? { cosmetic: state.showFaces } : {}) }),
        type: 'application/json' });
    if (studio.contentHash() !== hash) throw new Error('The model changed while it was being checked. Run the check again.');
    state.result = decode(result);
    state.highlight = null;
    state.message = '';
    draw();
  } catch (error) {
    state.error = true;
    state.message = error.message === 'signin' ? 'signin' : String(error.message || error);
    if (/expired/i.test(state.message)) state.session = null;
  } finally {
    state.busy = false;
    render();
  }
}

// ── results ────────────────────────────────────────────────────────────────────────────────
function typed(b64, Type) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

function decode(result) {
  const bodies = result.bodies.map((body) => {
    const decoded = {
      ...body,
      positions: typed(body.positions, Float32Array),
      faceIds: typed(body.faceIds, Int32Array),
      draftDeg: typed(body.draftDeg, Float32Array),
      thickness: typed(body.thickness, Float32Array),
      undercut: typed(body.undercut, Uint8Array),
      undercutRegion: typed(body.undercutRegion, Int32Array),
      cavityCore: typed(body.cavityCore, Uint8Array),
    };
    // Draft as the mold sees it. Each half pulls its own way, so a face's slope counts whichever
    // way it leans; a face that locks the part in (an undercut) counts as sloped the wrong way.
    // (Judging every face against one direction would show a whole half red, and the halves'
    // labels are decided by neighbors for walls this close to the pull, so they can't set the sign.)
    const draft = new Float32Array(body.triangles);
    for (let t = 0; t < body.triangles; t++) {
      const slope = Math.abs(decoded.draftDeg[t]);
      draft[t] = decoded.undercut[t] ? -slope : slope;
    }
    decoded.draft = draft;
    // per face: the steepest triangle decides whether the face has draft anywhere
    const faces = new Map(body.faces.map((f) => [f.id, { ...f, maxAbsDraft: 0 }]));
    for (let t = 0; t < body.triangles; t++) {
      const face = faces.get(decoded.faceIds[t]);
      if (face) face.maxAbsDraft = Math.max(face.maxAbsDraft, Math.abs(decoded.draftDeg[t]));
    }
    decoded.faceMap = faces;
    return decoded;
  });
  return { ...result, bodies };
}

export function findings(result) {
  const out = { noDraft: [], lowDraft: [], thin: [], thick: [] };
  if (!result) return out;
  const totalArea = result.bodies.reduce((sum, b) => sum + b.faces.reduce((s, f) => s + f.area, 0), 0) || 1;
  const nominal = result.wall.nominal;
  for (const [bi, body] of result.bodies.entries()) {
    for (const face of body.faceMap.values()) {
      if (face.area < totalArea * 0.0005) continue;           // slivers are not worth a line
      const item = { body: bi, face: face.id, area: face.area, centroid: face.centroid, normal: face.normal };
      if (face.maxAbsDraft < DRAFT_NONE_DEG) out.noDraft.push(item);
      else if (face.maxAbsDraft < DRAFT_LOW_DEG && face.minDraftDeg > -DRAFT_LOW_DEG && face.minDraftDeg < DRAFT_LOW_DEG) {
        out.lowDraft.push(item);
      }
      if (nominal > 0 && face.minThickness != null) {
        if (face.minThickness < nominal * THIN_FRACTION) out.thin.push({ ...item, value: face.minThickness });
      }
    }
    if (nominal > 0) {
      // thick spots per face, from the thickest triangle
      const thickest = new Map();
      for (let t = 0; t < body.triangles; t++) {
        const v = body.thickness[t];
        if (v > 0) thickest.set(body.faceIds[t], Math.max(thickest.get(body.faceIds[t]) || 0, v));
      }
      for (const [id, v] of thickest) {
        const face = body.faceMap.get(id);
        if (face && face.area >= totalArea * 0.0005 && v > nominal * THICK_FRACTION) {
          out.thick.push({ body: bi, face: id, area: face.area, centroid: face.centroid, normal: face.normal, value: v });
        }
      }
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.area - a.area);
  return out;
}

// ── "Fix it": add draft with the studio's own Draft feature ────────────────────────────────
const FIX_DRAFT_DEG = 1.5;        // comfortably above the 1° minimum

/** Up to `limit` vertices of one service face, spread over its triangles. */
function faceVertices(body, faceId, limit = 48) {
  const tris = [];
  for (let t = 0; t < body.triangles; t++) if (body.faceIds[t] === faceId) tris.push(t);
  const step = Math.max(1, Math.floor(tris.length * 3 / limit));
  const out = [];
  for (let k = 0; k < tris.length * 3; k += step) {
    const i = (tris[Math.floor(k / 3)] * 3 + (k % 3)) * 3;
    out.push([body.positions[i], body.positions[i + 1], body.positions[i + 2]]);
  }
  return out;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** How far the points stray from a studio face's surface (its plane, or its cylinder), or
 *  Infinity for surfaces this can't test. */
function offSurface(points, sig) {
  let worst = 0;
  if (sig.topologyKind === 'planar-face' && sig.p && sig.n) {
    const len = Math.hypot(...sig.n) || 1;
    const n = sig.n.map((c) => c / len);
    for (const q of points) worst = Math.max(worst, Math.abs(dot3(sub3(q, sig.p), n)));
    return worst;
  }
  if (sig.topologyKind === 'cylindrical-face' && sig.a && sig.d && sig.r > 0) {
    const len = Math.hypot(...sig.d) || 1;
    const d = sig.d.map((c) => c / len);
    for (const q of points) {
      const v = sub3(q, sig.a);
      const along = dot3(v, d);
      const radial = Math.hypot(v[0] - along * d[0], v[1] - along * d[1], v[2] - along * d[2]);
      worst = Math.max(worst, Math.abs(radial - sig.r));
    }
    return worst;
  }
  return Infinity;
}

/** The studio's face for each flagged face: the one whose surface the flagged face's own
 *  vertices lie on. Planes must also face the same way (the two sides of a thin wall share a
 *  plane only in the limit); for cylinders the radius tells the outside from the bore. When
 *  two studio faces fit (a surface split in two), the nearest one wins. */
export function matchFaces(items, result, studioFaces) {
  const tol = Math.max(result.maxDim * 0.001, 0.005);
  const out = [];
  for (const item of items) {
    const body = result.bodies[item.body];
    if (!body) continue;
    const points = faceVertices(body, item.face);
    if (!points.length) continue;
    let best = null;
    for (const face of studioFaces) {
      const sig = face.sig;
      if (!face.ref || !sig) continue;
      if (sig.topologyKind === 'planar-face') {
        const len = Math.hypot(...sig.n) || 1;
        if (!item.normal || dot3(item.normal, sig.n) / len < 0.995) continue;
      }
      const off = offSurface(points, sig);
      if (!(off <= tol)) continue;
      const dist = sig.p && item.centroid ? Math.hypot(...sub3(item.centroid, sig.p)) : 0;
      if (!best || dist < best.dist) best = { face, dist };
    }
    if (best) out.push({ item, face: best.face });
  }
  return out;
}

/** Where the halves meet, measured along the pull: the parting line the service found. */
function partingHeight(result) {
  const pull = result.pull.vector;
  const along = [];
  for (const body of result.bodies) {
    for (const q of body.partingLine || []) along.push(q[0] * pull[0] + q[1] * pull[1] + q[2] * pull[2]);
  }
  if (along.length) return along.reduce((a, b) => a + b, 0) / along.length;
  let low = Infinity;                       // no parting line: the face of the part nearest the −pull side
  for (const body of result.bodies) {
    for (let i = 0; i < body.positions.length; i += 3) {
      low = Math.min(low, body.positions[i] * pull[0] + body.positions[i + 1] * pull[1] + body.positions[i + 2] * pull[2]);
    }
  }
  return Number.isFinite(low) ? low : 0;
}

function perpendicular(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
  const v = [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
}

const shortId = () => Math.random().toString(36).slice(2, 10);

/** The typed operations that add draft to the flagged faces: a plane where the mold halves meet,
 *  then per body one Draft feature for the faces on each side of it. A face above the plane is
 *  formed by the half that pulls up, so it leans to face up; one below leans to face down. Each
 *  turns about its line on the plane, so the part keeps its size where the halves meet.
 *  Returns { operations, matched, missed } or { error }. */
export function draftOperations(result, items, studioFaces, { flatOnly = false } = {}) {
  const matches = matchFaces(items, result, studioFaces)
    .filter(({ face }) => !flatOnly || face.sig.topologyKind === 'planar-face');
  if (!matches.length) return { error: 'None of these faces could be found in your model to draft.' };
  const pull = result.pull.vector;
  const h = partingHeight(result);
  const datumId = 'tokcad-parting-plane-' + shortId();
  const operations = [{
    kind: 'datum.create',
    input: {
      id: datumId, name: 'Parting plane', datumKind: 'plane',
      definition: { mode: 'point-normal', point: pull.map((c) => +(c * h).toFixed(6)), normal: pull, xDirection: perpendicular(pull) },
    },
  }];
  const groups = new Map();                  // body and side -> face references
  const seen = new Set();
  for (const { item, face } of matches) {
    const refKey = face.bodyId + '|' + face.ref.name;
    if (seen.has(refKey)) continue;          // the service may split a face the studio keeps whole
    seen.add(refKey);
    const c = item.centroid;
    const below = c[0] * pull[0] + c[1] * pull[1] + c[2] * pull[2] < h;
    const key = face.bodyId + (below ? '|below' : '|above');
    if (!groups.has(key)) groups.set(key, { bodyId: face.bodyId, below, faceRefs: [] });
    groups.get(key).faceRefs.push(face.ref);
  }
  const sides = new Set(groups.keys());
  for (const { bodyId, below, faceRefs } of groups.values()) {
    operations.push({
      kind: 'feature.draft',
      input: {
        id: 'tokcad-draft-' + shortId(),
        // One feature per body is plain "Draft for molding"; when a body has faces on both sides
        // of the parting line, the two features say which half each one serves.
        name: sides.has(bodyId + '|above') && sides.has(bodyId + '|below')
          ? (below ? 'Draft for molding (core side)' : 'Draft for molding (cavity side)') : 'Draft for molding',
        bodyId, neutralPlaneDatumId: datumId, angle: FIX_DRAFT_DEG, faceRefs, flip: below,
      },
    });
  }
  const round = matches.filter(({ face }) => face.sig.topologyKind !== 'planar-face').length;
  return { operations, matched: seen.size, round, missed: items.length - matches.length };
}

async function fixDraft() {
  if (state.busy || !state.result) return;
  const doc = studio.document();
  if (doc?.rootDocument?.kind !== 'part') {
    state.error = true;
    state.message = 'Draft can be added to a part you model here. For an imported file, add draft in the CAD program it came from.';
    render();
    return;
  }
  if (state.sentHash !== studio.contentHash()) {
    state.error = true;
    state.message = 'The model has changed since this check. Run the check again first.';
    render();
    return;
  }
  const items = findings(state.result).noDraft;
  const built = draftOperations(state.result, items, studio.faces());
  if (built.error) {
    state.error = true;
    state.message = built.error;
    render();
    return;
  }
  state.busy = true;
  state.error = false;
  state.message = `Adding ${FIX_DRAFT_DEG}° of draft to ${plural(built.matched, 'face')}…`;
  render();
  let applied = await studio.applyOperations('Add draft for molding', built.operations);
  let skippedRound = 0;
  if (applied.error && built.round) {
    // The modeling kernel can't draft some round faces (whole cylinders): do the flat ones.
    const flat = draftOperations(state.result, items, studio.faces(), { flatOnly: true });
    if (!flat.error) {
      applied = await studio.applyOperations('Add draft for molding', flat.operations);
      skippedRound = built.round;
    }
  }
  state.busy = false;
  if (applied.error) {
    state.error = true;
    state.message = 'The draft could not be added: ' + applied.error + '.' + (built.round ? ' ' + ROUND_ADVICE : '');
    render();
    return;
  }
  state.message = '';
  await run();                                   // check again, so the faces turn green
  if (!state.error) {
    state.message = `Added ${FIX_DRAFT_DEG}° of draft. It is the "Draft for molding" feature in your history: edit it or undo it like any other.` +
      (skippedRound ? ` ${plural(skippedRound, 'round face')} could not be drafted here. ${ROUND_ADVICE}` : '');
    render();
  }
}

const ROUND_ADVICE = 'To slope a round wall, model it with Loft between a circle and a slightly smaller one, ' +
  'or Revolve a profile whose side leans by a degree or two.';

// ── drawing on the model ───────────────────────────────────────────────────────────────────
function triangleColor(view, body, t, result) {
  if (state.highlight && state.highlight.body === result.bodies.indexOf(body) && body.faceIds[t] === state.highlight.face) {
    return MAGENTA;
  }
  if (view === 'draft') {
    const deg = body.draft[t];
    if (deg <= 0) return RED;
    if (deg < 1) return lerp3(ORANGE, YELLOW, deg);
    if (deg < 3) return lerp3(YELLOW, GREEN, (deg - 1) / 2);
    return GREEN;
  }
  if (view === 'thickness') {
    const v = body.thickness[t];
    if (v <= 0) return GREY;
    const nominal = result.wall.nominal || 1;
    const r = v / nominal;
    if (r < THIN_FRACTION) return RED;
    if (r > THICK_FRACTION) return BLUE;
    if (r < 0.9) return lerp3(RED, GREEN, (r - THIN_FRACTION) / (0.9 - THIN_FRACTION));
    if (r > 1.1) return lerp3(GREEN, BLUE, (r - 1.1) / (THICK_FRACTION - 1.1));
    return GREEN;
  }
  if (view === 'undercut') return body.undercut[t] ? RED : GREEN;
  // mold halves
  const label = body.cavityCore[t];
  if (label === body.labels.undercut) return RED;
  if (label === body.labels.coreSide) return TEAL;
  if (label === body.labels.plus || label === body.labels.minus) return ORANGE;
  return GREY;
}

function clearOverlay() {
  if (!overlay) return;
  overlay.parent?.remove(overlay);
  overlay.traverse((object) => {
    object.geometry?.dispose();
    if (object.material) [].concat(object.material).forEach((m) => m.dispose());
  });
  overlay = null;
  studio.requestRender();
}

function draw() {
  clearOverlay();
  const result = state.result;
  if (!result || !state.open) return;
  const { THREE, partGroup } = studio.scene();
  overlay = new THREE.Group();
  overlay.name = 'tokcad-mold-overlay';
  const view = state.view;
  for (const body of result.bodies) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(body.positions, 3));
    const colors = new Float32Array(body.triangles * 9);
    for (let t = 0; t < body.triangles; t++) {
      const c = triangleColor(view, body, t, result);
      for (let k = 0; k < 3; k++) colors.set(c, t * 9 + k * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,   // in front of the part's own surface
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    mesh.userData.tokcadMold = true;
    overlay.add(mesh);

    if (view === 'halves' && body.partingLine?.length > 2) {
      const points = body.partingLine.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: PARTING_COLOR, depthTest: false }));
      line.renderOrder = 3;
      overlay.add(line);
    }
  }
  if (view === 'undercut') {
    const length = result.maxDim * 0.18;
    for (const group of result.undercut.groups || []) {
      const dir = new THREE.Vector3(...group.dir).normalize();
      const color = group.kind === 'slide' ? 0x4fa3ff : 0xff9a3c;
      for (const c of group.centroids) {
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(...c), length, color, length * 0.28, length * 0.16);
        arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; } o.renderOrder = 4; });
        overlay.add(arrow);
      }
    }
  }
  if (view === 'draft' || view === 'halves') {
    const dir = new THREE.Vector3(...result.pull.vector);
    const box = new THREE.Box3();
    for (const body of result.bodies) {
      for (let i = 0; i < body.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(body.positions[i], body.positions[i + 1], body.positions[i + 2]));
    }
    const start = box.getCenter(new THREE.Vector3()).addScaledVector(dir, result.maxDim * 0.55);
    const arrow = new THREE.ArrowHelper(dir, start, result.maxDim * 0.3, 0xffe14d, result.maxDim * 0.08, result.maxDim * 0.05);
    arrow.name = 'tokcad-mold-pull';
    overlay.add(arrow);
  }
  partGroup.add(overlay);
  studio.requestRender();
}

// ── the panel ──────────────────────────────────────────────────────────────────────────────
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

const mm = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' mm';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function legend(view, result) {
  const rows = {
    draft: [[RED, 'No draft (or sloped the wrong way)'], [ORANGE, 'Under 1°'], [YELLOW, '1–3°'], [GREEN, '3° or more']],
    thickness: [[RED, `Thin (under ${mm(result.wall.nominal * THIN_FRACTION)})`], [GREEN, `About ${mm(result.wall.nominal)} (the usual wall)`],
      [BLUE, `Thick (over ${mm(result.wall.nominal * THICK_FRACTION)})`], [GREY, 'Not measured']],
    undercut: [[RED, 'Undercut: locks the part in the mold'], [GREEN, 'Releases cleanly']],
    halves: [[ORANGE, 'Cavity half (forms the parting-line end)'], [TEAL, 'Core half (forms the walls; the part stays on it)'],
      [RED, 'Needs a slide or lifter'], [GREY, 'Unclear']],
  }[view];
  return el('ul', { class: 'tokcad-legend' }, rows.map(([c, text]) =>
    el('li', {}, el('span', { class: 'tokcad-swatch', style: `background:${css(c)}` }), text)));
}

function showMe(item, view) {
  state.view = view;
  state.highlight = { body: item.body, face: item.face };
  draw();
  render();
}

function findingList(items, text, view) {
  if (!items.length) return null;
  const shown = items.slice(0, 5);
  return el('div', { class: 'tokcad-finding' },
    el('p', {}, text),
    el('ul', {}, shown.map((item, i) => el('li', {},
      `Face ${i + 1}` + (item.value != null ? ` (${mm(item.value)})` : '') + ' ',
      el('button', { type: 'button', class: 'tokcad-link', onclick: () => showMe(item, view) }, 'Show me')))),
    items.length > shown.length ? el('p', { class: 'tokcad-hint' }, `and ${items.length - shown.length} more.`) : null);
}

function summary(result) {
  const f = findings(result);
  const u = result.undercut;
  const view = state.view;
  const blocks = [];
  if (view === 'draft') {
    blocks.push(el('p', {}, f.noDraft.length
      ? `${plural(f.noDraft.length, 'face')} run straight along the opening direction with no draft.`
      : 'Every large face has some draft.'));
    blocks.push(findingList(f.noDraft, 'Add 1° or more to:', 'draft'));
    if (f.noDraft.length && studio.document()?.rootDocument?.kind === 'part') {
      blocks.push(el('button', { type: 'button', class: 'tokcad-btn', 'data-mold-fix': 'draft', disabled: state.busy, onclick: fixDraft },
        `Fix it: add ${FIX_DRAFT_DEG}° of draft`));
    }
    if (f.lowDraft.length) blocks.push(findingList(f.lowDraft, `${plural(f.lowDraft.length, 'face')} have under 1°:`, 'draft'));
  }
  if (view === 'thickness') {
    const pct = Math.round(result.wall.uniformFraction * 100);
    blocks.push(el('p', {}, `The usual wall is about ${mm(result.wall.nominal)}; ${pct}% of the part is close to it. ` +
      `Thinnest ${mm(result.wall.min)}, thickest ${mm(result.wall.max)}.`));
    blocks.push(findingList(f.thin, `${plural(f.thin.length, 'face')} may be too thin to fill:`, 'thickness'));
    blocks.push(findingList(f.thick, `${plural(f.thick.length, 'face')} are thick enough to sink:`, 'thickness'));
  }
  if (view === 'undercut') {
    blocks.push(el('p', {}, u.regions
      ? `${plural(u.regions, 'undercut')}, which need ${[u.slides ? plural(u.slides, 'slide') : null, u.lifters ? plural(u.lifters, 'lifter') : null].filter(Boolean).join(' and ') || 'side actions'}.` +
        (u.unreleasable ? ` ${plural(u.unreleasable, 'region')} cannot be released by any straight pull.` : '')
      : 'No undercuts: the part comes straight out of a two-part mold.'));
    if (u.groups?.length) blocks.push(el('p', { class: 'tokcad-hint' }, 'Blue arrows: slides. Orange arrows: lifters. Each points the way it moves out.'));
  }
  if (view === 'halves') {
    const area = result.bodies.reduce((s, b) => s + (b.projectedAreaMm2 || 0), 0);
    blocks.push(el('p', {}, `Seen along the opening direction the part covers ${(area / 100).toFixed(1)} cm². ` +
      'That area, times the plastic\'s pressure, is the force the machine needs to keep the mold shut.'));
    blocks.push(splitBlock(result));
  }
  return blocks;
}

const fmtVec = (v) => v.map((c) => (Math.abs(c) < 1e-9 ? 0 : +c.toFixed(3))).join(', ');

const REASONS = {
  'least-undercut': 'the direction with the fewest undercuts',
  'depth-capped': 'the direction with the fewest undercuts among those no deeper than the part is long',
  shallowest: 'the shallowest direction (every direction is deeper than the part is long)',
  'show-face': 'the direction that puts your show face in the cavity',
};

function directionText(result) {
  const how = result.pull.inferred ? `worked out as ${REASONS[result.pull.reason] || 'the best fit'}: ` : '';
  return `Opening direction: ${how}${fmtVec(result.pull.vector)} (yellow arrow). The parting line is on the end the arrow points to.`;
}

// -- The mold split: cavity, core and parting surface, built by the service ----------------
/** The parting line is flat when the main loop stays at one height along the pull: the only
 *  kind the split builds so far. */
function flatPartingLine(result) {
  const loops = result.bodies.map((b) => b.partingLine).filter((l) => l && l.length > 2);
  if (!loops.length) return false;
  const loop = loops.reduce((a, b) => (b.length > a.length ? b : a));
  const p = result.pull.vector;
  const h = loop.map((q) => q[0] * p[0] + q[1] * p[1] + q[2] * p[2]);
  return Math.max(...h) - Math.min(...h) <= Math.max(result.maxDim * 0.001, 0.01);
}

function splitBlock(result) {
  if (!flatPartingLine(result)) {
    return el('p', { class: 'tokcad-note' }, 'This part needs a stepped or shaped parting line. ' +
      'Splitting the mold handles flat parting lines so far.');
  }
  return el('div', { class: 'tokcad-finding' },
    el('p', {}, 'Build the mold from this check: a steel block 1.5 in larger than the part all round and 1 in beyond ' +
      'each end, split at the parting line into the cavity and the core. It opens as a new assembly with the part in place.'),
    el('button', { type: 'button', class: 'tokcad-btn tokcad-primary', 'data-mold-split': '', disabled: state.busy, onclick: splitMold },
      'Split the mold'));
}

async function splitMold() {
  if (state.busy || !state.result || !state.session) return;
  const name = (studio.document()?.name || 'part').replace(/[^\w .-]+/g, '').trim() || 'part';
  state.busy = true;
  state.error = false;
  state.message = 'Building the mold (cavity, core and parting surface)…';
  render();
  try {
    const out = await api(`/api/v1/mold/sessions/${state.session}/split`, {
      body: JSON.stringify({ pull: state.result.pull.vector, ...(state.showFaces?.length ? { cosmetic: state.showFaces } : {}) }),
      type: 'application/json',
    });
    const bytes = Uint8Array.from(atob(out.step), (c) => c.charCodeAt(0));
    const file = new File([bytes], `${name} mold.step`, { type: 'application/step' });
    const size = out.report.block.size.map((v) => Math.round(v)).join(' × ');
    // Opening it is the studio's own STEP import; the start screen should not ask "what next?".
    // Success is judged from the studio (a new model with the pieces in it), not from the call.
    const before = studio.contentHash();
    globalThis.__tokcadOpeningSplit = Date.now();
    state.message = 'Opening the mold…';
    render();
    studio.openFile(file);
    const opened = await new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (studio.contentHash() !== before && !studio.building() && studio.bodyMeshes().size >= 2) resolve(true);
        else if (Date.now() - started > 90_000) resolve(false);
        else setTimeout(tick, 500);
      };
      tick();
    });
    if (!opened) throw new Error('The mold was built, but TOK CAD could not open it. The message at the bottom of the window says why.');
    state.message = `Opened "${name} mold": the part, the cavity and the core, in a ${size} mm block, ` +
      'meeting at the parting line. Your part is still in Recover. Slides and lifters are not built yet.';
  } catch (error) {
    state.error = true;
    state.message = String(error.message || error);
  } finally {
    state.busy = false;
    render();
  }
}

/** What became of the show faces, and a way to change them. */
function showFaceNote(result) {
  const named = state.showFaces?.length || 0;
  const rows = [];
  const sf = result.showFaces;
  if (named && sf) {
    if (sf.found < sf.given) {
      rows.push(el('p', { class: 'tokcad-note' }, `${plural(sf.given - sf.found, 'show face')} could not be found on the part sent for checking.`));
    }
    if (sf.found && sf.inCavity < 0.99) {
      rows.push(el('p', { class: 'tokcad-note' }, `${Math.round((1 - sf.inCavity) * 100)}% of the show face is under an undercut: ` +
        'the cavity cannot reach it, so forming it needs a slide or lifter.'));
    }
  }
  return el('div', { class: 'tokcad-mold-show' },
    el('p', { class: 'tokcad-hint' }, named ? `Show face: ${plural(named, 'face')} you picked, kept in the cavity. ` : 'No show face picked. ',
      el('button', { type: 'button', class: 'tokcad-link', 'data-mold-show': 'change', disabled: state.busy,
        onclick: () => { state.showFaces = null; askShowFaces(); } }, 'Change')),
    ...rows);
}

function showFacePrompt() {
  return el('div', { class: 'tokcad-finding', 'data-mold-ask': '' },
    el('p', {}, el('b', {}, 'Which face do customers see?')),
    el('p', {}, 'Click the show face on the part (Ctrl+click to add more), then press "Use selected faces". ' +
      'It goes in the cavity, and the mold opens the way that face looks. If no face matters, the check decides.'),
    el('div', { class: 'tokcad-actions' },
      el('button', { type: 'button', class: 'tokcad-btn tokcad-primary', 'data-mold-show': 'use', onclick: () => answerShowFaces(true) },
        'Use selected faces'),
      el('button', { type: 'button', class: 'tokcad-btn', 'data-mold-show': 'none', onclick: () => answerShowFaces(false) },
        'No show face')));
}

/** A close call on which end takes the parting line: say so, and offer the other end. */
function endNote(result) {
  const end = result.partingEnd;
  if (!end || !end.close) return null;
  const text = end.noFlatEnd
    ? 'Neither end has a flat face for the parting line, so it may need a stepped or shaped one. You can try the other end.'
    : 'Close call: the other end has nearly as much flat face for the parting line.';
  return el('div', { class: 'tokcad-finding' }, el('p', {}, text),
    el('button', { type: 'button', class: 'tokcad-btn', 'data-mold-flip': '', disabled: state.busy, onclick: flipEnd },
      'Put the parting line on the other end'));
}

function flipEnd() {
  if (!state.result) return;
  state.customPull = state.result.pull.vector.map((c) => (c === 0 ? 0 : -c));
  state.pull = 'custom';
  run();
}

function render() {
  if (!panel) return;
  panel.hidden = !state.open;
  if (!state.open) return;
  const result = state.result;
  const stale = result && state.sentHash !== studio.contentHash();
  const pullSelect = el('select', { 'aria-label': 'Mold opening direction', disabled: state.busy,
    onchange: (event) => { state.pull = event.target.value; } },
  Object.entries(PULLS).map(([id, p]) => el('option', { value: id, selected: state.pull === id }, p.label)),
  state.customPull ? el('option', { value: 'custom', selected: state.pull === 'custom' }, 'Flipped: ' + fmtVec(state.customPull)) : null);

  let message = null;
  if (state.message === 'signin') {
    message = el('p', { class: 'tokcad-error' }, 'Create a free account (or sign in) to run the molding check. ',
      el('a', { href: '/account' }, 'Account page'));
  } else if (state.message) {
    message = el('p', { class: state.error ? 'tokcad-error' : 'tokcad-note', role: 'status' }, state.message);
  }

  panel.replaceChildren(
    el('header', {},
      el('b', {}, 'Molding check'),
      el('button', { type: 'button', class: 'tokcad-coach-close', title: 'Close the molding check', 'aria-label': 'Close the molding check',
        onclick: close }, '×')),
    el('div', { class: 'tokcad-mold-body' },
      el('label', { class: 'tokcad-mold-pull' }, el('span', {}, 'Mold opens along'), pullSelect),
      state.asking ? showFacePrompt()
        : el('button', { type: 'button', class: 'tokcad-btn tokcad-primary', disabled: state.busy, onclick: run, 'data-mold-run': '' },
          state.busy ? 'Checking…' : result ? 'Check again' : 'Run the check'),
      message,
      result && !state.busy ? [
        stale ? el('p', { class: 'tokcad-note' }, 'The model has changed since this check. Run it again to update.') : null,
        el('p', { class: 'tokcad-hint' }, directionText(result)),
        showFaceNote(result),
        endNote(result),
        el('div', { class: 'tokcad-mold-views', role: 'tablist' }, Object.entries(VIEWS).map(([id, label]) =>
          el('button', { type: 'button', role: 'tab', 'aria-selected': String(state.view === id), 'data-mold-view': id,
            class: 'tokcad-mold-tab' + (state.view === id ? ' is-on' : ''),
            onclick: () => { state.view = id; state.highlight = null; draw(); render(); } }, label))),
        legend(state.view, result),
        ...summary(result),
        el('details', { class: 'tokcad-why' }, el('summary', {}, 'Why?'), el('p', {}, WHY[state.view])),
        el('p', { class: 'tokcad-hint' }, 'Parts sent for a molding check are kept for 7 days, then deleted.'),
      ] : null),
  );
}

function open() {
  state.open = true;
  render();
  draw();
  panel.scrollIntoView({ block: 'nearest' });
}

function close() {
  state.open = false;
  clearOverlay();
  render();
}

function init(tokcadStudio) {
  studio = tokcadStudio;
  panel = el('section', { class: 'tokcad-coach tokcad-mold', id: 'tokcad-mold', 'aria-label': 'Molding check', hidden: true });
  // Top of the right-hand panel, above the coach: when it is open it is what the user is reading.
  (document.getElementById('bw-side') || document.body).prepend(panel);
  const help = document.getElementById('bw-help-status');
  help?.before(el('button', { type: 'button', id: 'tokcad-mold-open', onclick: open }, 'Molding'));
  // A change to the model makes the overlay wrong: take it off (the panel says to re-run).
  studio.on((kind) => {
    if (kind === 'change' && state.result && state.sentHash !== studio.contentHash()) {
      clearOverlay();
      render();
    }
  });
  globalThis.TokcadChecks = {
    supports: (process) => process === 'molded',
    run: () => { open(); if (!state.result) run(); },
  };
  globalThis.TokcadMold = {
    open, close, run, fixDraft, splitMold, state: () => state, findings: () => findings(state.result),
    // Name the show faces without clicking them (scripts and tests); [] for none.
    setShowFaces: (sigs) => { state.showFaces = sigs; state.showFacesProject = projectId(); state.asking = false; },
    draftOperations: () => draftOperations(state.result, findings(state.result).noDraft, studio.faces()),
  };
  globalThis.dispatchEvent(new Event('tokcad:checks-ready'));
}

if (globalThis.TokcadStudio) init(globalThis.TokcadStudio);
else globalThis.addEventListener('tokcad:studio-ready', () => init(globalThis.TokcadStudio), { once: true });
