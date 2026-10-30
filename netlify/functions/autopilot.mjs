// Hourly: starts an autopilot cycle in the background worker when autopilot is on.
import { getStore } from '@netlify/blobs';
import { autopilotTick, workerKey } from '../lib/app.mjs';

export default async () => {
  const blobs = getStore({ name: 'jobpilot', consistency: 'strong' });
  const dispatch = (payload) => fetch(new URL('/internal/worker', process.env.URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-key': workerKey() },
    body: JSON.stringify(payload),
  });
  console.log('autopilot:', await autopilotTick({ blobs, dispatch }));
};

export const config = { schedule: '@hourly' };
