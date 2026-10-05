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

## Manual workspace and installed mod (0.2.0)

The ordinary Fabric mod supports any single-player overworld. In creative mode, take the
Configurator, Monitor, Task Board, Console and optional Status Lamp from the AgentCraft tab.
Build furniture with ordinary blocks. Right-click a clear floor or stair chair with the
Configurator to place Codex's desk anchor. Shift + right-click cycles the selected role;
right-click sets that role's position. The desk must be assigned first. Optional roles are
`library`, `testbench`, `terminal`, `mergestation`, `meeting`, `lounge` and `user`.
Unassigned roles fall back to the desk. Floor anchors use the player's cardinal direction;
stair anchors face away from the stair back.

Alternatively aim within eight blocks and run `/agentcraft workspace <role>`. Remove an
optional role with `/agentcraft workspace remove <role>`. All zones must be within 32 blocks
of the desk on X/Z and 16 on Y. Moving the desk drops optional zones outside those bounds.
Unbound monitors and lamps in loaded chunks within those bounds bind to Codex once per second.
Place boards and consoles normally; boards join adjacent panels facing the same direction.
Keep paths and chair approaches clear. One desk and one visible Codex are supported; NPCs
are hidden outside the overworld. Assignment requires creative mode.

`agentcraft-workspace.json` stores explicit zones in each save; published navigation anchors
also use `agentcraft-anchors.json`. Opening a save restores them without placing any blocks.
Assigning a manual desk replaces the active building's anchors, retaining its blocks. Explicitly
placing a generated HQ deactivates the manual layout. `/agentcraft hq` only rebuilds generated
layouts, so use workspace commands for manual layouts.

Build the mod with JDK 25 and Gradle, then run `node tools/build-portable.mjs <fresh-output-dir>`.
The Windows package contains AgentCraft 0.2.0, Fabric API 0.161.0+26.3, a bundled Node runtime,
an observer-only bridge, status CLI, licenses and Russian instructions. Minecraft Java 26.3,
Fabric Loader 0.19.5+ and Java 25 must already be installed for the chosen launcher profile.
`Install-Mod.cmd` copies the two mods to the selected game directory, backing up replaced
versions outside `mods` and preserving existing client settings. `Start-Bridge.cmd` runs or
reuses a local observer on port 7878. `Stop-Bridge.cmd` requests a graceful save and stop only
from this package's owned process. Package state lives in `data/portable`, logs in `logs`.
It needs no source checkout, npm install, model SDK credentials or TradeRecord repository.

The installed mod opens Minecraft's normal menu. DevBridge and automatic world opening are
off, and audio and pause preferences are retained. `config/agentcraft-client.json` configures
`port`, `foreman`, `dev`, `autoworld`, `mute` and `focus`; restart after changing them. Environment
variables and system properties override that file. The development launcher keeps its earlier
defaults. Generic worlds keep their own game rules and spawn; the configured legacy HQ world
still uses its existing HQ rules. Furniture placement does not import structures or enable
two-way chat. Third-party `.schem`/`.nbt` builds are separate imports and are not bundled.

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
Gradle tests additionally cover manual role cycling, required desk, bounds, relocation and
optional-role fallback. Manual placement QA uses an isolated save with hand-built furniture:
actual Configurator right-click, single NPC, automatic monitor/lamp binding, relocating a
monitor, assigning/removing a reading zone and rejecting assignment in survival mode.
The packaged JAR was also loaded through production Fabric (`fabric.development=false`):
normal title menu, restored manual save/anchors, one NPC, bound monitor and creative tab.
This passed on the installed Oracle JDK 25.0.2. The direct packaged launch crashed inside
Temurin 25.0.4.1's JVM (Windows exception 0xc0000005); that runtime is not validated for the
standalone package. No JVM workaround is applied to user profiles. Windows PowerShell 5.1
successfully installed the package and started/stopped its observer with persisted state.
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
