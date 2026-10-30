// All /api/* routes and the CV download.
import { getStore } from '@netlify/blobs';
import { handle, workerKey } from '../lib/app.mjs';

export default async (req) => {
  const blobs = getStore({ name: 'jobpilot', consistency: 'strong' });
  const dispatch = async (payload) => {
    const res = await fetch(new URL('/internal/worker', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-key': workerKey() },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 202) throw new Error(`Could not start the background task (${res.status})`);
  };
  return handle(req, { blobs, dispatch });
};

export const config = { path: ['/api/*', '/cv'] };
