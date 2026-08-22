import fs from 'node:fs';
import vm from 'node:vm';
import { silhouette } from './figure.js';

const html = fs.readFileSync('../NewDesignTemplate/Замеры - Фигура.dc.html', 'utf8');
const script = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const start = script.indexOf('class Component extends DCLogic');
const end = script.indexOf('  // ---------- данные');
const geometryClass = `${script.slice(start, end)}\n}`
  .replace('class Component extends DCLogic', 'globalThis.ReferenceComponent = class Component extends DCLogic');

globalThis.DCLogic = class {};
vm.runInThisContext(geometryClass);
const reference = new globalThis.ReferenceComponent();

const cases = [
  {
    name: 'male-current',
    sex: 'male',
    values: {
      height: 178, neck: 38, chest: 100.5, waist_who: 84, pelvis: 90,
      hip: 98, thigh: 53, calf: 38, biceps_relaxed: 30.5, forearm: 28,
      wrist: 20, shoulder_width: 43, foot_length: 27
    }
  },
  {
    name: 'female-wide-range',
    sex: 'female',
    values: {
      height: 163, neck: 31, chest: 118, waist_who: 67, pelvis: 110,
      hip: 126, thigh: 72, calf: 46, biceps_relaxed: 41, forearm: 33,
      wrist: 14, shoulder_width: 39, foot_length: 23
    }
  },
  { name: 'defaults', sex: 'male', values: {} }
];

let failures = 0;
for (const testCase of cases) {
  const expected = reference.geom(testCase.values, testCase.sex);
  const actual = silhouette(testCase.values, { figure: testCase.sex });
  if (actual.paths[0].d !== expected.path) {
    console.error(`${testCase.name}: path differs`);
    failures += 1;
  }
  for (const [key, node] of Object.entries(expected.nodes)) {
    const actualNode = actual.nodes[key];
    if (!actualNode || actualNode.x1 !== node.x1 || actualNode.x2 !== node.x2 || actualNode.y !== node.y) {
      console.error(`${testCase.name}: node ${key} differs`);
      failures += 1;
    }
  }
  if (actual.ground.y !== expected.ground.y || actual.ground.r !== expected.ground.r) {
    console.error(`${testCase.name}: ground differs`);
    failures += 1;
  }
}

if (failures) process.exitCode = 1;
else console.log(`Exact mockup parity: ${cases.length}/${cases.length} cases`);
