import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameRegistry } from '../src/frames';

test('restore/status can recover every injected frame after worker restart', async () => {
  const data: Record<string, unknown> = {};
  const storage = {
    async get(key: string) { return { [key]: data[key] }; },
    async set(value: Record<string, unknown>) { Object.assign(data, value); },
    async remove(key: string) { delete data[key]; },
  };
  const initialWorker = new FrameRegistry(storage);
  await initialWorker.remember(12, [0, 4, 7, 4]);
  const restartedWorker = new FrameRegistry(storage);
  assert.deepEqual(await restartedWorker.get(12), [0, 4, 7]);
  await restartedWorker.forget(12);
  assert.deepEqual(await new FrameRegistry(storage).get(12), [0]);
});
