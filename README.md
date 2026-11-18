# grocery-mcp

MCP server that helps plan meals and shop on Glovo in Tbilisi, with Dazoge price comparison.

## Setup
1. `bun install && bunx playwright install chromium`
2. `bun run login` — a browser window opens; sign in to Glovo with Google once. The session is stored in `data/browser-profile/` (git-ignored).
3. `cp data/preferences.example.md data/preferences.md` and fill in your diet, stores and rhythm. The copy is git-ignored; the agent reads it before planning meals.
4. Claude Code picks up `.mcp.json` from this folder automatically.

The `glovo_session_status` tool launches a headless browser and can take up to ~30 s when the session is stale, because it tries one token refresh.

## Discovery (one-time, needed before Plan 2)
`bun run discover` and follow `docs/glovo-discovery.md`.

## Tests
`bun test` — never touches live Glovo. Dazoge calls use recorded fixtures.

## Environment
- `GROCERY_DRY_RUN=1` stops any future checkout one step before payment.
- `GROCERY_DATA_DIR`, `GROCERY_DB_PATH` override storage locations.
