# KGF Sunday Run

Live map for the KGF gym Sunday run. Runners enter a name, share their location, and everyone sees everyone on an OpenStreetMap view that refreshes every 5 seconds. Each runner can start and finish their run to record start time, end time and distance.

Plain HTML/CSS/JS front end + one Vercel serverless function (`api/runners.js`) + Upstash Redis (free) for shared state. No build step.

## Deploy (about 10 minutes)

1. **GitHub**: create a repo and push this folder.
2. **Vercel**: Add New > Project > import the repo. Framework preset: *Other*. No build command, no output directory. Deploy.
3. **Database**: in the Vercel project open *Storage* > *Create Database* > pick **Upstash Redis** (free plan) > connect it to the project. This adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables automatically. (If you create Upstash yourself, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` instead.)
4. **Redeploy** once so the function sees the variables.
5. Open the Vercel URL on a phone. Share that link in the group.

## How it works

- `POST /api/runners` saves my position and stats and returns everyone's. The app calls it every 5 seconds, so one request does both jobs.
- `GET /api/runners` is used by people who tap "Just watching".
- Runners not heard from for 6 hours are removed automatically, so each Sunday starts clean.
- Distance is summed from GPS fixes on the phone. Fixes worse than 35 m accuracy, tiny jitter moves and impossible jumps (over 43 km/h) are ignored.
- State is kept in `localStorage`, so a reload or accidental tab close resumes the same run.

## Things to know

- **Keep the screen on and the app open while running.** A web app cannot track GPS once the phone is locked or the browser is in the background (iOS is strict about this). The app asks the phone to keep the screen awake, and a runner who goes dark is faded on the map with "No signal for ...".
- GPS needs HTTPS. Vercel provides it.
- Free-tier use: each runner sends about 12 requests a minute, roughly 2 Redis commands each. A 20-person, 1-hour run is about 30k commands, well under Upstash's free monthly allowance.
- Map tiles come from the public OpenStreetMap server, which is fine for a small group. For heavy use, switch the tile URL in `app.js` to a provider such as MapTiler or Stadia.
- Marker colours are assigned by the server (12 distinct colours, reused beyond 12 runners), so two people never share a colour in a normal group.

## Customise

- Brand colours: top of `styles.css` (`--amber`, `--black`).
- Poll speed: `POLL_MS` in `app.js`.
- Logo and icons: `icons/`.
