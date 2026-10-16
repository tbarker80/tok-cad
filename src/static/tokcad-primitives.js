// TOKCAD: "Start from a shape" primitives for TOK CAD's start screen.
//
// Each primitive is generated the way the built-in templates are (studio-templates.js): named
// parameters plus ordinary sketch + extrude/cut features whose dimensions are expressions of
// those parameters. So a primitive is real, editable CAD: change `length` in the parameter
// list and the part rebuilds. Nothing here is a fixed mesh.

import { createStudioV5PartProject } from './studio-project-v5.js';

const rect = (x, y, w, h) => ({ kind: 'rect', x, y, w, h });
const circle = (x, y, r) => ({ kind: 'circle', x, y, r });
const poly = (pts) => ({ kind: 'poly', pts });

function shapeWithIds(featureId, shape, index) {
  const id = featureId + '-profile-' + (index + 1);
  return shape.kind === 'poly'
    ? { ...shape, id, edgeIds: shape.pts.map((_p, i) => id + '-edge-' + (i + 1)) }
    : { ...shape, id };
}

const feature = (id, type, shapes, extra = {}) => ({
  id,
  type,
  sketch: { shapes: shapes.map((shape, index) => shapeWithIds(id, shape, index)), z: extra.z ?? 0 },
  ...((type === 'extrude' || type === 'cut') ? { through: false } : {}),
  ...extra,
});

/** Primitive definitions. `fields` drive the form; `explain` is the beginner note. */
export const TOKCAD_PRIMITIVES = Object.freeze([
  {
    id: 'block',
    name: 'Block',
    explain: 'A rectangular block: the starting point for brackets, housings, spacers and most machined parts.',
    fields: [
      { name: 'length', label: 'Length (X)', value: 60 },
      { name: 'width', label: 'Width (Y)', value: 40 },
      { name: 'height', label: 'Height (Z)', value: 20 },
    ],
    features: () => [feature('block-body', 'extrude', [rect(0, 0, 'length', 'width')], { h: 'height' })],
  },
  {
    id: 'cylinder',
    name: 'Cylinder',
    explain: 'A round bar: the starting point for shafts, pins, knobs and turned parts.',
    fields: [
      { name: 'diameter', label: 'Diameter', value: 30 },
      { name: 'height', label: 'Height (Z)', value: 40 },
    ],
    features: () => [feature('cylinder-body', 'extrude', [circle(0, 0, 'diameter/2')], { h: 'height' })],
  },
  {
    id: 'tube',
    name: 'Tube',
    explain: 'A hollow round tube: bushings, sleeves, spacers and pipe fittings.',
    fields: [
      { name: 'outer_dia', label: 'Outside diameter', value: 30 },
      { name: 'inner_dia', label: 'Inside diameter', value: 22 },
      { name: 'length', label: 'Length (Z)', value: 50 },
    ],
    check: (v) => (v.inner_dia >= v.outer_dia ? 'The inside diameter must be smaller than the outside diameter.' : null),
    features: (v) => [
      feature('tube-body', 'extrude', [circle(0, 0, 'outer_dia/2')], { h: 'length' }),
      feature('tube-bore', 'cut', [circle(0, 0, 'inner_dia/2')], { z: v.length, h: v.length * 2, through: true }),
    ],
  },
  {
    id: 'plate',
    name: 'Plate with holes',
    explain: 'A flat plate with a mounting hole in each corner: covers, mounting plates and brackets.',
    fields: [
      { name: 'length', label: 'Length (X)', value: 80 },
      { name: 'width', label: 'Width (Y)', value: 50 },
      { name: 'thickness', label: 'Thickness (Z)', value: 5 },
      { name: 'hole_dia', label: 'Hole diameter', value: 5.5 },
      { name: 'hole_inset', label: 'Hole distance from edge', value: 8 },
    ],
    check: (v) => (2 * v.hole_inset >= Math.min(v.length, v.width) ? 'The holes would overlap: make the plate bigger or the inset smaller.' : null),
    features: (v) => [
      feature('plate-body', 'extrude', [rect(0, 0, 'length', 'width')], { h: 'thickness' }),
      feature('plate-holes', 'cut', [
        circle('length/2-hole_inset', 'width/2-hole_inset', 'hole_dia/2'),
        circle('-(length/2-hole_inset)', 'width/2-hole_inset', 'hole_dia/2'),
        circle('length/2-hole_inset', '-(width/2-hole_inset)', 'hole_dia/2'),
        circle('-(length/2-hole_inset)', '-(width/2-hole_inset)', 'hole_dia/2'),
      ], { z: v.thickness, h: v.thickness * 2, through: true }),
    ],
  },
  {
    id: 'l-bracket',
    name: 'L-bracket',
    explain: 'An angle bracket, drawn as its L-shaped side profile and pulled out to its width.',
    fields: [
      { name: 'leg_a', label: 'Leg A length', value: 50 },
      { name: 'leg_b', label: 'Leg B length', value: 40 },
      { name: 'thickness', label: 'Thickness', value: 5 },
      { name: 'width', label: 'Width (Z)', value: 30 },
    ],
    check: (v) => (v.thickness >= Math.min(v.leg_a, v.leg_b) ? 'The thickness must be smaller than both legs.' : null),
    features: () => [
      feature('bracket-body', 'extrude', [poly([
        [0, 0], ['leg_a', 0], ['leg_a', 'thickness'], ['thickness', 'thickness'], ['thickness', 'leg_b'], [0, 'leg_b'],
      ])], { h: 'width' }),
    ],
  },
]);

export function getTokcadPrimitive(id) {
  return TOKCAD_PRIMITIVES.find((primitive) => primitive.id === id) || null;
}

/** A template ({id, name, document}) for openTemplateNow, or throws with a message for the user. */
export function buildTokcadPrimitive(id, values) {
  const primitive = getTokcadPrimitive(id);
  if (!primitive) throw new Error('Unknown shape.');
  const v = {};
  for (const field of primitive.fields) {
    const value = Number(values?.[field.name] ?? field.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error(field.label + ' must be a positive number.');
    if (value > 10000) throw new Error(field.label + ' must be at most 10,000 mm.');
    v[field.name] = value;
  }
  const problem = primitive.check?.(v);
  if (problem) throw new Error(problem);
  const stamp = Date.now().toString(36);
  const document = createStudioV5PartProject({
    projectId: 'tokcad-' + id + '-' + stamp,
    partId: 'tokcad-' + id + '-part',
    bodyId: 'tokcad-' + id + '-body',
    name: primitive.name,
    parameters: primitive.fields.map((field) => ({ name: field.name, value: v[field.name] })),
    features: primitive.features(v),
  });
  return { id: 'tokcad-' + id, name: primitive.name, document };
}
