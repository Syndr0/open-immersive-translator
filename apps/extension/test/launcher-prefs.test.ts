import assert from 'node:assert/strict';
import test from 'node:test';
import { hiddenOn, hideLauncher, readLauncherPrefs, savePlacement, showLauncher } from '../src/launcher-prefs';

function memoryArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); },
  } as unknown as chrome.storage.StorageArea & { data: Record<string, unknown> };
}

test('hiding on a site, everywhere and showing again keep the saved position', async () => {
  const area = memoryArea();
  await savePlacement(area, { side: 'left', top: 0.25 });
  await hideLauncher(area, 'site', 'example.org');
  await hideLauncher(area, 'site', 'example.org');
  let prefs = await readLauncherPrefs(area);
  assert.deepEqual(prefs.hiddenSites, ['example.org']);
  assert.equal(hiddenOn(prefs, 'example.org'), true);
  assert.equal(hiddenOn(prefs, 'other.org'), false);
  await hideLauncher(area, 'everywhere', 'example.org');
  assert.equal(hiddenOn(await readLauncherPrefs(area), 'other.org'), true);
  await showLauncher(area, 'example.org');
  prefs = await readLauncherPrefs(area);
  assert.equal(hiddenOn(prefs, 'example.org'), false);
  assert.deepEqual(prefs.placement, { side: 'left', top: 0.25 });
});

test('missing or malformed storage reads as no preferences', async () => {
  assert.deepEqual(await readLauncherPrefs(undefined), {});
  assert.deepEqual(await readLauncherPrefs(memoryArea({ launcher: 'broken' })), {});
  assert.equal(hiddenOn({}, ''), false);
});
