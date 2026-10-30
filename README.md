# JobPilot

A local web app with an AI chat agent that finds jobs and applies for you.

- **Sources:** LinkedIn (Easy Apply), Upwork (proposals), and remote job boards: Remotive, RemoteOK, We Work Remotely (applies on the company's own form: Greenhouse, Lever, Ashby, Workable and plain forms)
- **Kinds of work:** Long term (full-time), Short term (contract / temporary), Project pay (fixed price / freelance)
- **AI:** OpenAI scores each job against your profile, writes Upwork proposals and answers application questions. Without an API key it still works with keyword scoring and rule-based form answers.
- **Autopilot:** off, shortlist (finds and ranks; you approve), or auto-apply (within daily limits, with random pauses)

Everything runs on your computer. The server only listens on `localhost`, and your profile, CV, jobs and browser logins stay in the `data/` folder.

## Requirements

- Node.js 20 or newer
- Google Chrome (JobPilot drives a separate Chrome window with its own profile)
- An OpenAI API key (optional, but strongly recommended)

## Quick start

```bash
git clone https://github.com/<you>/jobpilot.git
cd jobpilot
npm install
npm start
```

Open http://localhost:4310. On Windows you can also double-click `run.bat`.

Then, in the app:

1. **Settings → AI:** paste your OpenAI API key. Or copy `config.example.json` to `config.local.json` and put it there.
2. **Settings → Profile:** replace the example profile with yours. The agent answers application questions from it, so keep it accurate.
3. **Settings → CV:** upload your CV (PDF). It is attached to every application.
4. **Settings → Connect LinkedIn / Connect Upwork:** a separate Chrome window opens. Sign in there yourself, once; JobPilot never sees your password. If a site asks you to verify you are human, do it in that window.
5. Press **Search now**, or ask the agent, e.g. "find remote React contracts".

## How it works

| Part | File |
|---|---|
| HTTP API, live updates (SSE), static UI | `src/server.cjs` |
| Chat agent (OpenAI tool calls) | `src/agent.cjs` |
| Search, scoring, apply queue, autopilot | `src/jobs.cjs` |
| LinkedIn: guest search API + Easy Apply | `src/sources/linkedin.cjs` |
| Upwork: search + proposals | `src/sources/upwork.cjs` |
| Remotive, RemoteOK, We Work Remotely | `src/sources/remote.cjs` |
| Company application forms | `src/sources/external.cjs` |
| Generic form filler | `src/apply/formfill.cjs` |
| UI | `web/` |

Applications that need a human (login, captcha, a question the agent cannot answer) go to **Needs you**, with the Chrome tab left open for you to finish. JobPilot never tries to solve or bypass captchas.

### Testing the form filler

`npm run test:apply` fills `tools/test-form.html`, a local practice form, with your profile and CV and prints what was submitted. Nothing leaves your computer, and it uses a throwaway Chrome profile.

## Please use responsibly

- LinkedIn's and Upwork's terms restrict automated activity, and accounts that apply too fast can be limited or banned. **You are responsible for how you use this tool.** Keep the daily limits low, and prefer shortlist mode.
- Each Upwork proposal spends Connects. Set a daily Connects limit in Settings.
- Remotive's API asks to be called at most a few times a day; JobPilot caches its results for 6 hours.
- Only apply to jobs you would actually take, and keep your profile truthful.

## License

MIT
