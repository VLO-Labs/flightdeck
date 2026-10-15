# Flightdeck — notes for Claude

- **How it runs:** locally on the Mac as Flightdeck.app (http://flightdeck.localhost:8100 by
  default). The vlolabsdev / `make flightdeck` / SSO-gateway parts of PLAN.md are history.
- **Settings are env based:** every setting is an environment variable, read from `.env` (gitignored;
  `.env.example` documents them) in the server's working directory, with the environment winning.
  `src/server/config.ts` is the single place they're read; the Mac scripts read the same `.env`.
  Never hardcode a machine-specific name, path or port — add a variable with a sensible default.
- **Getting a change live:** commit, then run `scripts/mac/install.sh`. The app runs a copy in
  `~/Library/Application Support/Flightdeck/app`, so editing or pushing this repo doesn't change it.
  The script refuses while a chat turn is running and restarts the app if it was open — say so first
  if the user may be mid-turn.
- **Trying changes:** never on the app's port or data. Use a scratch data folder and port:
  `FLIGHTDECK_DATA=<tmp>/data FLIGHTDECK_PORT=8199 npm start` (after `npx vite build`), and a throwaway
  git repo as the project when a test writes files.
- **Checks:** `npm test` and `npm run typecheck`.
- **Docs:** README (run it, requirements, configuration), PLAN.md (decisions and how each part works;
  record "as built" notes there when a feature lands). The repo is public: write docs for a reader
  who isn't its author.
