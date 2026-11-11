# KGF Sunday Run

Live map for the KGF gym Sunday run. Runners enter a name, share their location and everyone sees everyone on an OpenStreetMap view that refreshes every 5 seconds.

## What it does

- **Live map**: coloured marker per runner, refreshed every 5 seconds. Your own coloured **tracking line** grows as you run. The route button on the map shows everyone's trails (off by default to save data).
- **Start / Finish**: records start time, end time, distance, pace and a GPS track for each run.
- **Leaderboard** (trophy button): ranks runners by **Distance**, **Time** (fastest to cover the target distance, 10 km by default) or **Speed** (best average pace, needs 200 m or more). Pick a previous Sunday from the day list.
- **All tracks on map**: every runner's track in their colour, finishers marked with their finishing place.
- **Database**: every run, result and track is saved in Redis. Nothing expires.
- **Stop sharing**: removes you from the live map but keeps your saved result.

## Stack

Plain HTML/CSS/JS + Vercel serverless functions in `api/` + Upstash Redis. No build step.

| File | Job |
| --- | --- |
| `api/runners.js` | live state for today, saves positions, stats and new track points |
| `api/tracks.js` | returns saved tracks (only the points you do not have yet) |
| `api/day.js` | list of days and the saved results for a day |
| `api/admin.js` | set the target distance, delete a day (needs `ADMIN_KEY`) |
| `api/_lib.js` | shared code (not a route) |

### Redis layout
- `kgf:d:<date>` hash, one record per runner for that day
- `kgf:t:<runId>` list, the GPS track of one run (`[latE5, lngE5, secondsSinceStart, metres]`)
- `kgf:days` set of dates, `kgf:cfg` settings

## Deploy

1. Push the folder to GitHub, import it in Vercel (Framework preset: Other, no build command).
2. Vercel project > Storage > Upstash Redis, connect it to the project.
3. Settings > Environment Variables: add `ADMIN_KEY` (any secret). Optional: `TZ_OFFSET_MIN` (default 330 = India) decides which calendar day a run belongs to.
4. Redeploy. Open `/admin.html` to set the target distance or delete a test day.

## Things to know

- Keep the screen on and the app open while running. A web app cannot track GPS in the background.
- Runners who are ready or running disappear from the live map 5 minutes after their last update. Finished runners stay for 3 hours. Their results stay in the leaderboard and history.
- GPS points are saved about every 12 m. Fixes worse than 35 m accuracy, GPS jumps (over 43 km/h) and tiny jitter are ignored.
- Redis usage is roughly 3 commands per runner every 5 seconds while running. Check the Usage tab in Upstash if the group grows.
