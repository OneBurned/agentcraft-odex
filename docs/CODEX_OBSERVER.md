# Codex chat observer for TradeRecord

The `observer` backend displays work performed in an existing Codex chat. It does not start
Claude or another Codex session, call model APIs, execute task commands, create worktrees,
merge, push or deploy. Marlow's existing character is labelled **Codex**; the other characters
remain off shift and are not spawned in the observer game. Game task submission, messages, approvals and agent controls are rejected
with instructions to return to the Codex chat.

## Start and stop on this Windows machine

Prerequisites: Node 22+, Git, a Minecraft Java Edition license and JDK 25. The portable JDK is
installed under `.runtime/jdk-25.0.4.1+1` in this checkout (ignored by Git). The wrapper selects it for
AgentCraft only; the system Java installation is unchanged. First launch downloads Gradle,
Minecraft and Fabric into this checkout's development caches.

```powershell
& 'C:\Users\GB\Documents\agentcraft-odex\tools\traderecord.ps1'
# Stop the observer and its game:
& 'C:\Users\GB\Documents\agentcraft-odex\tools\traderecord.ps1' -Stop
```

`-NoGame` starts just the observer. `-NoWait` returns after starting the processes. `-Repo`
overrides the default `C:\Users\GB\Documents\New project` checkout. State is stored in
`.agentcraft-home/traderecord`; logs are in `artifacts/logs`. Local ports: 7878 (Foreman),
7879 (game DevBridge). Closing Minecraft leaves the observer running; use `-Stop` to stop both.
Use one profile per development workflow. Restart after updating the backend source.

## World and game modes

The TradeRecord wrapper reads `world-settings.json` in this checkout via
`AGENTCRAFT_WORLD_CONFIG`. Restart Minecraft after editing it. Without that variable, the
generic launcher retains the legacy flat `AgentCraft HQ` default.

| Setting | Values / effect |
| --- | --- |
| `name` | Save folder, default `TradeRecord World`; use a new name to create another world |
| `type` | `normal` (standard terrain, biomes and structures) or `flat` (legacy meadow) |
| `seed` | String containing a number or text; empty string picks a random seed |
| `gameMode` | Initial `creative`, `survival`, `adventure` or `spectator` |
| `difficulty` | Initial `peaceful`, `easy`, `normal` or `hard` |
| `daylightCycle` | Day/night progression; reapplied on each start |
| `weatherCycle` | Weather progression; reapplied on each start |
| `spawnMobs` | Natural mob spawning; peaceful difficulty still excludes hostile mobs |
| `autoBuild` | `false` by default: fresh worlds wait for player placement; `true` enables automatic studio placement |

Generation, initial mode and initial difficulty apply only to new saves. Changing the seed/type
does not regenerate an existing world. The original `AgentCraft HQ` save remains intact; set
`name` to `AgentCraft HQ` to reopen it. Keep inventory, no fire spread and no mob griefing remain
enabled for the studio's protection. This is normal terrain with studio-friendly game rules.

When automatic building is enabled, the studio selects a dry site on normal terrain and saves its location in `agentcraft-site.json`.
The whole building, station bindings, NPC paths, cameras and spawn move together. Rebuilds reuse
that location and the saved block plan, retaining player edits. Only the studio site is landscaped.

Use vanilla chat (`T` or `/`) for `/gamemode creative`, `/gamemode survival`,
`/gamemode spectator`, `/difficulty normal`, `/time set day` or `/weather clear`.
Chosen player modes now survive rejoining. The separate AgentCraft console (backtick key, usually
the physical `Ё` key on a Russian keyboard) does **not** forward answers into the Codex chat.
Work states are explicitly published by Codex using the bridge below; they are unrelated to
Minecraft game modes.

### Choose a building and its location

Aim at a block within 64 blocks and use vanilla Minecraft chat:

```text
/agentcraft preview cabin
/agentcraft place cabin
/agentcraft preview studio
/agentcraft place studio
```

`cabin` is a timber workshop for one Codex with a desk, task board, library, terminal, test bench,
review station, meeting seat and lounge. Its house is 21×17 blocks; the cleared site is 27×27.
`studio` is the original large studio with landscaped grounds, with a 93×91 site.

Preview shows the site's outline with particles for 15 seconds, without changing blocks or the
active HQ. Each command uses the current block under the crosshair, so aim at the same block
when placing. The block is the horizontal centre of the building's foundation, with floor blocks
one block above it. The entrance faces the player's side (one of four cardinal directions).
The studio's local centre is `(0, 64, 7)`; the cabin's is `(0, 64, 0)`.

Placing clears/fills the entire outlined site, activates the new work stations and moves the
player to its entrance. Old buildings remain in the world; new sites overlapping a recorded
old site are rejected. `agentcraft-sites.json` records protected site boxes. Only one HQ is active.
The saved transform rotates block states, station bindings, anchors and navigation together.
`/agentcraft hq` rebuilds the active building at its saved location, retaining player edits.

Commands require Minecraft command permissions and the selected overworld. An empty sky target,
out-of-height placement or world-border intersection is rejected. Until a fresh world's first
placement, the observer's NPC is hidden. Existing saves and buildings are not removed by turning
off automatic building. Fresh worlds keep Minecraft's spawn until the first placement.
Importing third-party schematics is not implemented.

## Publish a real status from a chat

```powershell
node 'C:\Users\GB\Documents\agentcraft-odex\tools\codex-progress.mjs' --key 'chat-id/task-name' --title 'TradeRecord: задача' --state reading --activity 'Изучаю код задачи' --optional
```

Use a stable key for the same task, including after a restart, and a new key for a new task.
Required fields: `key`, `title`, `state`, `activity`. Optional: `log`, `summary`, `ci`, `repo-id`,
`port`. The server validates payload lengths and states. The key cannot be moved between repos.

| State | Game display |
| --- | --- |
| thinking | Planning at the meeting area |
| reading | Reading at the library |
| editing | Editing at the desk |
| running | Running a command at the terminal |
| testing | Checking at the test bench |
| waiting_user | Waiting near the player; blocked task |
| blocked / error | Blocked task with the supplied reason |
| review | Review column, character at merge station; actual review happens in Codex |
| done | Completed task; character returns to the lounge |

`--ci running|pass|fail|unknown` is an explicit report, not an automatic test detector. Only report
`pass` after the relevant checks actually pass. Logs are deliberately supplied summaries, never
raw terminal dumps, secrets, broker tokens or private account data. A done task does not imply a
push or deployment. Describe exactly what finished in `summary`.

`--optional` skips an offline observer with a short timeout, so development is not blocked by
the game. It does not queue events or ignore validation/wrong-backend errors. Start the observer
and publish the current status to catch up. The observer is local-only and rejects browser
Origins by default; it trusts local processes, not an authenticated remote audience.

## Limits

- Updates occur when Codex explicitly calls the bridge at meaningful work stages. This is not
  a capture of every tool call, automatic chat-history access, or a background Codex agent.
- After five minutes without an active-work update, the character becomes idle with a stale-status
  message. The task remains at its last reported status; no completion is inferred.
- Restart restores tasks/logs and puts the character idle until the next real report.
- The existing Minecraft studio and controls remain visible. Commands that could imply control
  over the external chat are refused; write the instruction in Codex instead.
- Separate chats share one displayed character; the most recent report determines its activity.
  Their tasks remain separate when they use different keys.
- No managed AgentCraft worktree is created, so the game's Merge/diff workflow does not represent
  these changes. Review code using Codex/Git.

## Validation

Run `npm run check` in `foreman/`, `npm test` in `tools/`, and the Gradle build in `mod/` using JDK 25.
Gradle tests cover world settings and placement transforms (all four rotations, selected block
centres, footprint rotation and legacy translation). Live placement checks use a separate
`AgentCraft Placement QA` save: no initial HQ/NPC with `autoBuild:false`, particle preview,
cabin and studio placement, opposite entrance directions, rotated monitor facing, rejection
of sky/overlapping/too-high targets, zero-change rebuilds, retained player edits and reload.
Observer regression tests cover progress, persistence, failed-check recovery, stale activity,
invalid payloads, and rejection of game controls before state mutation.
Test-output parsing also accepts Node 24's `ℹ tests/pass/fail` lines as well as TAP `#` lines,
including Windows line endings, so the existing repo test runner retains actual test totals.
The Windows launcher preserves ISO timestamp strings when reading run records under PowerShell
7.5+, retaining timezone and precision for safe process identity checks. Run
`tools/test/procs-smoke.ps1` with both `pwsh` and Windows PowerShell to verify this path.
