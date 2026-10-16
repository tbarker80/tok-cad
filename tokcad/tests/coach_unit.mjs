// Unit check of the coach's model reading against the real solver (node).
const base = new URL('../../src/static/', import.meta.url).href;
// tokcad-coach.js touches the DOM only in init(); stub what its module body needs.
globalThis.addEventListener = () => {};
const { readModel, coachSteps } = await import(base + 'tokcad-coach.js');
const { buildTokcadPrimitive } = await import(base + 'tokcad-primitives.js');

let ok = true;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok = ok && c; };

const free = {
  entities: [
    { id: 'p1', kind: 'point', at: [0, 0] },
    { id: 'p2', kind: 'point', at: [10, 0] },
    { id: 'l1', kind: 'line', a: 'p1', b: 'p2' },
  ],
  constraints: [],
};
const fixed = {
  entities: [
    { id: 'p1', kind: 'point', at: [0, 0], fixed: true },
    { id: 'p2', kind: 'point', at: [10, 0] },
    { id: 'l1', kind: 'line', a: 'p1', b: 'p2' },
  ],
  constraints: [{ kind: 'horizontal', line: 'l1' }, { kind: 'length', line: 'l1', value: 10 }],
};
const doc = (sketch) => ({
  projectId: 'x', parameters: [],
  rootDocument: { kind: 'part', partId: 'p' },
  partDefinitions: [{ id: 'p', features: [{ id: 'f1', type: 'extrude', name: 'Extrude 1', sketch: { constrained: sketch } }] }],
});
const m1 = readModel(doc(free), 1);
check(m1.underDefined.length === 1 && m1.underDefined[0].dof > 0, `free line is under-defined (dof ${m1.underDefined[0]?.dof})`);
const m2 = readModel(doc(fixed), 1);
check(m2.underDefined.length === 0, 'fixed, horizontal, sized line is fully defined');

const plate = buildTokcadPrimitive('plate', {}).document;
const m3 = readModel(plate, 1);
const s3 = coachSteps(m3, {});
const done = s3.filter((s) => s.done).map((s) => s.id);
check(done.join(',') === 'base,sketches,order,params', `plate primitive ticks base, sketches, order, params (${done.join(',')})`);
check(!s3.find((s) => s.id === 'intent').done, 'intent not done until a process is chosen');

const filletFirst = {
  projectId: 'y', parameters: [], rootDocument: { kind: 'part', partId: 'p' },
  partDefinitions: [{ id: 'p', features: [
    { id: 'a', type: 'extrude', name: 'Extrude' }, { id: 'b', type: 'fillet', name: 'Fillet' }, { id: 'c', type: 'cut', name: 'Cut' }] }],
};
check(readModel(filletFirst, 1).detailBeforeCut, 'a fillet before a cut is flagged');
const intentDoc = structuredClone(plate);
intentDoc.partDefinitions[0].extensions = { tokcad: { intent: { process: 'molded' } } };
check(coachSteps(readModel(intentDoc, 1), {}).find((s) => s.id === 'intent').done, 'saved intent ticks step 1');
console.log(ok ? 'ALL PASSED' : 'FAILED');
