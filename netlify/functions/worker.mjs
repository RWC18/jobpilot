// Background function (up to 15 minutes): searches, AI scoring and autopilot cycles.
import { getStore } from '@netlify/blobs';
import { runTask, workerKey } from '../lib/app.mjs';

export default async (req) => {
  if (req.headers.get('x-worker-key') !== workerKey()) return;
  await runTask(await req.json(), { blobs: getStore({ name: 'jobpilot', consistency: 'strong' }) });
};

export const config = { path: '/internal/worker', background: true };
