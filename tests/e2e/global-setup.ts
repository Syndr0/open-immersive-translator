import { request } from '@playwright/test';

/** The e2e data folder persists between runs; a saved service from an interrupted run must not leak into this one. */
export default async function globalSetup() {
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:8788' });
  await api.delete('/api/settings/provider');
  await api.dispose();
}
