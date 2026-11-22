import createSimulator from '../node_modules/.cache/saarathi/simulator.mjs';
import wasmUrl from '../node_modules/.cache/saarathi/simulator.wasm?url';
import catalogue from '../../data/catalogue.json?raw';

export const engineLabel = 'C++17 WebAssembly';
export const engineError = 'Unable to load the simulation engine. Reload the page to try again.';

let engine;

function callJson(module, name, input) {
  const json = input === undefined
    ? module.ccall(name, 'string', [], [])
    : module.ccall(name, 'string', ['string'], [input]);
  const result = JSON.parse(json);
  if (result?.error) throw new Error(result.error);
  return result;
}

function getEngine() {
  engine ??= createSimulator({locateFile: () => wasmUrl}).then(module => {
    callJson(module, 'simulator_init', catalogue);
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      module._simulator_tick((now - previous) / 1000);
      previous = now;
    }, 34);
    return module;
  });
  return engine;
}

export async function readState() {
  return callJson(await getEngine(), 'simulator_state');
}

export async function sendAction(action, value) {
  return callJson(await getEngine(), 'simulator_action', JSON.stringify({action, value}));
}

export async function exportSession() {
  const snapshot = callJson(await getEngine(), 'simulator_export');
  return new Blob([JSON.stringify(snapshot)], {type: 'application/json'});
}
