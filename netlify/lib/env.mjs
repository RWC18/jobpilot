// Must be imported before any src/ module: they read these when first loaded.
process.env.JOBPILOT_MODE = 'online';
process.env.JOBPILOT_DATA ||= '/tmp/jobpilot';
// Files listed in netlify.toml included_files live under the Lambda task root.
process.env.JOBPILOT_ROOT ||= process.env.LAMBDA_TASK_ROOT || process.cwd();
