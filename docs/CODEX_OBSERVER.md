# Codex chat observer for TradeRecord

The `observer` backend connects an existing Codex chat to Minecraft. Codex remains the developer
in that chat. Version 0.4.0 adds a command desk with a user-approved task queue and an optional
Claude Code reviewer, represented by Wren. Other cast members remain hidden. Starting the bridge
alone does not start work: drafts require approval and the queue requires an explicit Start.
No automatic merge, push or deployment is implemented. Native tool permissions still belong to
the Codex app; the game's decision queue accepts only questions created by the studio workflow.

## 0.4.0 command desk

### Klava review workspace and GitHub (prepared, bridge restart pending)

Dialogs and automated reviews can now share an explicitly configured personal workspace.
The Minecraft mod remains 0.4.7; only the bridge needs updating. The local workspace is
`C:\Users\GB\Documents\Klava-reviewer`. Its `CLAUDE.md` defines personality/review rules,
`PROJECTS.md` explains both existing products, and `MEMORY.md` stores durable notes. These files
are reloaded before each conversation or review and sent through stdin, avoiding Windows
command-line limits. They are independent of the bounded chat history and common studio notes.
The `remember` tool appends only to personal `MEMORY.md`; instructions require an explicit user
request to remember. It cannot edit the role, access configuration, project files or queue.

`<profile>/claude-workspace.json` contains `{ "directory": "<absolute workspace path>" }`.
Without this pointer, the existing tools-disabled behavior remains. A malformed configured
workspace fails visibly rather than silently using broader access. The workspace's `access.json`
lists approved local paths and GitHub repository names. Setup (preserves existing instructions
and refuses conflicting access settings):

```powershell
node tools/setup-klava.mjs --workspace 'C:\Users\GB\Documents\Klava-reviewer' --traderecord 'C:\Users\GB\Documents\New project' --profile-dir 'C:\Users\GB\Documents\agentcraft-odex\.agentcraft-home\traderecord'
```

The configured projects are `traderecord` → `OneBurned/TITracker` and `agentcraft` →
`OneBurned/agentcraft-odex`. A dedicated stdio MCP server offers source listing/reading/search,
local Git status/log/per-file diff, and fixed GitHub GET operations for code, commits, PRs and
issues. Local reads include uncommitted changes to files already tracked/staged in Git; ignored
and untracked files, typical credentials/runtime data, binary/oversized files, traversal and
symlink escapes are rejected. Large results are explicitly bounded/paged. GitHub uses the
existing `gh` keyring login on this machine. No token is copied into the prompt or workspace,
and no GitHub collaborator, repository permission, comment, merge or push is created. The two
repository restriction is enforced by the tool server, not by reducing the user's OAuth scope.

Built-in Claude tools, hooks and skills remain disabled; strict MCP configuration allows only
this server. The model has no shell, generic filesystem or arbitrary HTTP tool. The operator
controls workspace files; model tools cannot change `access.json` or the profile pointer.
Local context and GitHub can differ; review instructions require identifying the actual source
and commit. Existing before/after checks still reject automatic verdicts when the reviewed
repository changes. This is a local Claude Code workspace, not a synchronized claude.ai Project
or a shared transcript with the Codex app.

Validation: 584 bridge tests passed, followed by 21 focused tests including review-context loading; typecheck,
stdio MCP integration, path/access rejection and persistent memory tests passed. A real Claude
dialog read both local READMEs, correctly reported both local HEADs, and confirmed access to
the private TradeRecord and public AgentCraft repositories. Direct GitHub README and PR-list
reads also passed for both projects. Package: `dist/AgentCraft-Codex-0.4.7-klava-release` and
`dist/AgentCraft-Codex-0.4.7-Klava-Windows.zip`; isolated packaged studio restart and memory
checks passed. The running bridge has not yet been restarted for this extension.
No new Minecraft mod installation is needed.

#### Separate interactive Claude Code terminal

The same local workspace can be opened independently using `Start-Klava.cmd` in
`C:\Users\GB\Documents\Klava-reviewer`; `Continue-Klava.cmd` continues its last terminal chat.
`tools/setup-klava.mjs` creates both launchers while preserving existing Markdown instructions
and memory. They invoke `tools/open-klava.ps1` / `tools/klava-terminal.mjs`, locate the installed
Claude CLI, and use the same strictly configured MCP tools with built-in tools/hooks/skills disabled.
The session is named «Клава — TradeRecord и AgentCraft». Unlike game requests, terminal chats
use normal Claude session persistence. Terminal and Minecraft transcripts are separate; workspace
instructions and `MEMORY.md` are shared. Restarting the game bridge is not required to open this terminal.
This creates a local Claude Code workspace, not an ordinary cloud Project in the Claude chat UI.

The launcher reloads all three Markdown files on every launch, passes them via a temporary
`--append-system-prompt-file`, and disables system prompt snapshots so resumed sessions use the
current instructions. It deletes its generated context file on ordinary exit. No prompt is sent
automatically in interactive mode. On first launch Claude may ask the user to trust this workspace.
The `-Check` option performs a non-persistent headless startup check: the installed Claude CLI
successfully identified its role and both projects from the supplied files. It does not change code
or memory. Both launchers keep GitHub credentials in the existing local login.

### 0.4.7 personal controls and direct dialogs (installed)

The agent card's Message button now opens its inline field. Enter/Send addresses that agent's
stable ID and keeps the draft until delivery is acknowledged. Sent text (`Вы:`) and replies are
saved in that agent's journal. Console mentions accept current character names plus `@Codex`
and `@Claude`; plain text and `@all` retain the existing Codex destination. The hint shows the
actual recipient. `/pause`, `/resume`, `/stop` accept one optional agent mention.

Without the optional review workspace above, Claude conversation uses a separate `ClaudeDialog`
CLI process with tools, MCP, hooks and CLI session persistence disabled. It receives the last bounded conversation history, recent pool
cards, review summaries and shared notes, and cannot read/edit project files or create tasks.
Its prompt is passed over stdin; only public reply text is logged, never raw account diagnostics.
History (last 30 entries) and a pending reply are persisted in the existing studio profile.
Busy or paused conversations reject additional sends explicitly. Review and conversation never
run simultaneously for Claude. Codex messages continue into the existing bound desktop chat.

Personal controls resolve the selected owner before touching a running task. Idle Resume clears
only that agent's pause; it does not start the queue. Pausing an owned coding/review task records
the specific suspended card and pauses queue dispatch. Resume dispatches only that card (with a
new report correlation for coding), leaving the queue paused. A Claude pause/stop cannot interrupt
Codex, or vice versa. Global queue controls remain in the command desk; planning an empty pool no
longer creates a phantom Claude pause. `Agent.controls` advertises availability to both new cards;
old clients can still send controls, with ownership checked by the bridge.

Pause waits for the real Claude process exit before acknowledging and retains the pending question;
Resume recomputes the answer with saved context. Stop clears the pending answer but keeps history.
Late output from an interrupted run is ignored. Restart preserves interrupted dialog as paused and
never automatically resends. Ordinary Codex turn controls retain native desktop interruption and
saved-context continuation. A different bound chat cannot resume an old suspended queue card.

Validation: bridge typecheck, full 574-test suite, then 52 focused tests for the final availability
guard; the mod build and 33 Java tests passed. A real installed Claude CLI answered the isolated
dialog smoke request «Связь с Claude работает.» No actual user task was interrupted for testing.
In-game card/input verification is pending. The package is `dist/AgentCraft-Codex-0.4.7-ready`
with its matching Windows ZIP. Installed after separate approval on 2026-10-06 from `156649f`,
with Minecraft closed. The bridge exited gracefully and restarted on port 7878; the live snapshot
confirmed the existing chat binding, unchanged agent profiles, and per-agent controls. Claude is
idle with messaging enabled, without the previous phantom pause. Minecraft was not launched.
The installed mod SHA-256 is `1B6E35A3BF295AA429C64148CA3CCAB0A9709B439DBFAF0A21DCCAEBFDDC2A32`.
Settings and binding hashes are unchanged. Backup: `artifacts/backups/install-0.4.7-20261006-145743-215`;
replaced mods: `.minecraft/agentcraft-backups/20261006-145743-346`.
Local verification record: `artifacts/install-0.4.7.json`. In-game verification remains pending.

### 0.4.6 separate planning desk (installed)

The new **Стол планирования / Planning Desk** block (`agentcraft:planning_desk`) opens a
planning-only view of the existing `StudioScreen`. It shares the same `studio.action` calls,
cards, draft creation/editing, expected results, dependencies, priorities, discussion and
approval buttons with the command desk. There is no second queue or block-local task storage.
The command desk keeps all its tabs. The planning desk shows the plan directly, with Refresh
and the existing Questions button; execution is still started from the command desk's Queue.

The block is included in the AgentCraft creative tab and can be given with
`/give @s agentcraft:planning_desk`. Right-click without the Configurator and without sneaking
to open it. Its four-facing model is a walnut table with a paper floor plan, notes and a pencil,
using existing textures and a table-shaped collision volume. Placing it does not change personal
meeting anchors. Opening it gathers characters at their already assigned planning places;
opening alone does not pause execution. **Обсудить план** retains the existing queue pause and
console-prefill behavior. Task forms/details return to this same planning-only screen.

Validation: build and all 33 existing Java tests passed. Resource checks verified all texture
references, element bounds, four facing variants, item model, both locale names and list/footer
bounds at common GUI heights. No new backend or persistence behavior is introduced. In-game
model and UI verification is pending; Minecraft was not auto-launched. Package:
`dist/AgentCraft-Codex-0.4.6-ready` and the matching Windows ZIP. Version 0.4.6 (`f8fd255`)
was installed with user approval on 2026-10-06. After the user saved and left the world, the
remaining game window was closed normally and process exit confirmed before replacement.
The installed JAR matches the package (SHA-256
`BE5337EB96AFE43AB55FC6B118B1664B83C868F3C4E4ADA1BEEFBA861A3F32F6`). Existing settings were
preserved byte-for-byte and backed up to `artifacts/backups/install-0.4.6-20261006-142532-137`;
previous mods are under `.minecraft/agentcraft-backups/20261006-142532-203`.
The bridge was unchanged and not restarted. Minecraft was not relaunched; in-game verification
of the new block and UI remains pending.

### 0.4.5 turn and dip dance sequence (installed)

Every agent's existing pole dance now pauses at opposite sides of the ring, turns its back to
the pole, performs two slow dips, turns back upright and resumes the circle. No new settings or
saved-data migration are needed. `PoleDance` advances only after exact arrival and standing
facing the pole; its 256-tick sequence holds the route target fixed. Each dip lasts 64 ticks.
The standing-facing override follows a smooth yaw curve without rebuilding paths. Model pose
channels blend the raised arms, rigid-leg tilt and render-only lowering; the nameplate follows
the lowering. This is a stylized vanilla-model dip, without articulated knees.

Each agent owns a separate sequence. Work, questions, planning, pause/offline state or loss of
music/valid pole eligibility discard it, and a changed pole/world starts upright. The next
rest begins with the normal approach instead of resuming halfway through a dip. Real execution
states and the bridge are unchanged.

Validation: mod build and all 33 Java tests passed, including eight choreography checks for
arrival/facing gates, fixed position during the sequence, exactly two backward-facing dips,
continuous turns, displacement/reset, independent agents, ring progression and rigid-leg
floor contact. These checks do not replace visual verification in Minecraft. Version 0.4.5
(`afffcc0`) was installed with user approval on 2026-10-06 after Minecraft closed. The installed
JAR matches `dist/AgentCraft-Codex-0.4.5-ready` (SHA-256
`28DC06B218AED6545577456EAE25F6E1D13141B84415A91482B5A020148A0956`); its matching Windows ZIP
is also prepared. Existing AgentCraft settings were preserved byte-for-byte and backed up to
`artifacts/backups/install-0.4.5-20261006-140558-683`. Previous mods are under
`.minecraft/agentcraft-backups/20261006-140558-753`. The bridge was unchanged and not restarted.
Minecraft was not auto-launched; visual verification of the new animation remains pending.

### 0.4.4 rest places, music and planning (installed)

Opening the Plan tab (including its task forms/details) gathers visible active characters at
their personal `meeting` anchors, with shared meeting positions as fallback. Leaving the tab
restores destinations from real agent state. This is a client presentation override; it does
not pause Codex, Claude, or the queue. Questions take precedence over gathering.

`config/agentcraft-studio.json` now also stores `restPlaces`, scoped by single-player save path
and agent ID. Each agent can have up to 32 normal/dance points (ID, kind flag, anchor). Existing
personal `lounge` anchors are read as a legacy first point until the list is edited. An explicitly
empty list stays empty; old lounge anchors cannot reappear after deletion. Rest assignments append;
marking the same physical location replaces the duplicate, and moving one point preserves others.
The command desk's Places → Rest tab cycles through points and offers add/move/delete. Dance
addition and relocation arm the Configurator and close the screen so the user can aim in-world.

Configurator cycle adds **Отдых: танцы у шеста** after ordinary Rest. Right-click a vertical chain
or fence column of at least three blocks. The bottom must be at feet level with a walkable 3×3
ring and headroom inside the workspace. No new decorative block is required. A jukebox within
five blocks (3D distance from the bottom block) must actually be playing; merely containing a
disc or emitting note-block pulses does not qualify. Loaded jukeboxes are inspected every ten
ticks on the integrated server thread, then immutable music snapshots are read by the client.

Only active, unpaused, connected, idle/done agents at `lounge`, without questions or a planning
gathering, choose rest points. Physical poles and normal rest points are reserved exclusively.
Music/validity changes reconsider immediately; otherwise choices hold for 600 ticks before
rotating among alternatives. Available musical dance points have priority over normal rest.
Pole/ring removal or music ending falls back to another rest point or the shared lounge.
The new DANCE posture alternates reaching arms and rhythmic steps while collision-aware motion
circles the pole. Work/questions interrupt it using existing smooth pose transitions.

Version 0.4.4 (`2209e22`) includes the 0.4.3 Configurator selection and was installed with user
approval on 2026-10-06 while Minecraft was closed. The installed JAR matches the verified package
(SHA-256 `1D7E15289B3FF83646A26EB3C59BCCDA5490956145761872EC3AD6CC16096292`). Existing
AgentCraft settings were preserved byte-for-byte and copied to
`artifacts/backups/install-0.4.4-20261006-135008-489`; previous mods are under
`.minecraft/agentcraft-backups/20261006-135008-588`. The bridge is unchanged and was not restarted.
Minecraft was not auto-launched. In-game animation, music response and UI appearance still
require an in-game check.
Validation: mod build and all 25 Java tests passed. Ten new checks cover music availability
changes, physical reservations across different agent IDs, interruption/release, stable choice
and rotation, eligibility, preserving/moving/deduplicating rest points and JSON round-trip.
`dist/AgentCraft-Codex-0.4.4-ready` and its Windows ZIP contain the verified 0.4.4 JAR, new classes
and all six added skins. These checks do not replace an in-game animation/UI test.

### 0.4.3 configurator agent selection (included in installed 0.4.4)

Right-click a visible agent with the Configurator to select that agent by stable ID, including
renamed characters such as Клава. The tool's tooltip and action messages identify the selected
agent and station role. Right-click a floor/chair to save that agent's personal place; sneak-use
on a block or in air cycles roles. Sneak-right-click an agent clears selection and restores the
original shared-workspace workflow. Selection resets on world/dimension changes; saved places
remain scoped to the single-player world. This does not enable agents or start/stop real work.

Personal assignments use the same `StudioPreferences.markAt` storage as the command desk's
**Места** tab, with bounds validation and rollback on save failure. Floor height and stair-facing
geometry are shared with the original `ManualWorkspace` placement. The primary workspace must
already exist; assigning personal spots requires creative mode in the overworld. Existing
workspace commands still edit the shared layout. Client item/block callbacks consume personal
clicks before packet transmission so they cannot also move the shared Codex workspace.

The 0.4.3 changes were installed as part of 0.4.4; no separate 0.4.3 installation was needed.
Validation: build and 15 Java tests passed, including seven personal-assignment checks for
agent/role isolation, moving a place, JSON round-trip, boundaries and invalid inputs. The
installed Fabric callback implementation was inspected to confirm that `FAIL` suppresses
item/block packets. Package: `dist/AgentCraft-Codex-0.4.3-ready` (matching Windows ZIP), with
JAR hash verified against the build. Clicks and tooltips still need an in-game check after
installation; Minecraft was not auto-launched for verification.

### 0.4.2 additional appearances (installed)

Six user-supplied PNGs are bundled unchanged as cosmetic skins: `girl_swimsuit`
(**Девушка в купальнике**), `gta_sa_girl` (**Проститутка из GTA SA**), `skuf` (**Скуф**),
`ded_vasyan` (**Дед Васян**), `girl_no_armor` (**Девушка без брони**) and
`boy_no_armor` (**Парень с чёлкой**). The GTA SA and Vasya skins use the legacy 64×32 format;
at runtime the mod invokes Minecraft's own legacy skin converter for limb mirroring and
transparency. The other four use 64×64. Custom PNG import remains 64×64.
The command desk uses Russian/English display names. Each can be
applied to either agent; they do not add executors or change roles. The bridge advertises and validates these extra skins separately
from the six-agent cast. Version 0.4.2 (`8305407`) was installed with user approval on
2026-10-06 while Minecraft was closed. The updated bridge was restarted, its connection to
this Codex chat confirmed, and all six skin IDs verified in the live studio response.
Client settings were preserved byte-for-byte. Previous mods are backed up under
`.minecraft/agentcraft-backups/20261006-125839-685`; the bridge profile and client settings
were copied to `artifacts/backups/install-0.4.2-20261006-125819-271`.

Validation: mod build and eight Java tests passed; bridge typecheck and 20 studio tests
passed. An isolated profile check accepted all six skins for both agents without dispatching
work. All six PNGs in `dist/AgentCraft-Codex-0.4.2-six-skins-ready` match the supplied files
byte-for-byte; both locale labels and the legacy converter invoker are packaged. The matching
archive is `dist/AgentCraft-Codex-0.4.2-six-skins-Windows.zip`. In-game appearance still needs
verification in Minecraft; the game was not launched during preparation or installation.

### 0.4.1 preview crash fix (installed)

The user's `crash-2026-10-06_12.33.14-client.txt` shows `Entity.getId()` throwing from
`ItemModelResolver.updateForLiving` while `StudioScreen` renders a character preview.
World NPCs received an ID in `AgentManager.spawn`, but screen-only previews bypassed it.
ID allocation now happens in `ClientAgentEntity` construction, shared across world NPCs and
previews, with negative IDs. The manager no longer assigns a second ID. This fixes the same
initialization defect for both Codex and Claude without inserting previews into the world.
Saved skins and the bridge are unchanged. Version 0.4.1 (`6d7d85c`) was installed with user
approval on 2026-10-06 while Minecraft was closed. The installed JAR matches the tested package;
AgentCraft client settings are unchanged. Previous mods are in
`.minecraft/agentcraft-backups/20261006-123929-804`. Rendering still needs verification when
the user manually starts their Fabric profile and opens the appearance tab.
Validation: Gradle build and all eight model tests passed. Inspection of the compiled constructor
confirms `setId` precedes `AgentLife` initialization and return; the world manager no longer assigns
an ID independently. Minecraft was not launched for the check or after installation.

### Using the command desk

Place **Пульт AgentCraft / Command Desk** from the creative AgentCraft tab, or use
`/give @s agentcraft:command_desk`. Right-click it without the Configurator. Its tabs are:

- **Команда**: enable/disable Codex and Claude, rename them, hide their NPC independently of execution.
- **Внешность**: bundled skins (including six extra 0.4.2 appearances), custom 64×64 PNG (up to 512 KiB), wide/slim arms, outer layer,
  name/role/activity labels and name colour. Mouse-following preview; Apply or restore defaults.
- **План**: discuss the pool through the existing console, create/edit draft cards, expected result,
  dependencies and priority. Discussion pauses the queue first. Text is sent only after Enter.
- **Очередь**: approve individual drafts, Start/Continue, Pause, Stop, Planning, review and decisions.
  The list refreshes every three seconds. Clicking a studio card on the wall opens the same details.
- **Места**: per-agent desk, reading, tests, terminal, review, planning, rest and communication spots.
  Stand on the spot and save it. Positions must be inside the workspace marked by the Configurator.
- **Память**: shared notes and the existing library/catalog. Review reports include the checked commit.
- **Настройки**: automatic/manual/disabled review, detected or explicit Claude Code executable,
  browser login/check, connected project and Codex link state. Empty executable path means autodetect.

The task wall has Plan → Queued → Working → Review → Done and Needs decision columns. Cancelled
cards are hidden. The HUD tracks the pool goal. Adding a task does not start coding. Default review
is automatic, with Claude initially disabled until the user adds it and signs in.

The queue dispatches one approved task at a time into the bound desktop chat. Dependencies must be
done; higher priority wins. It waits until the chat is idle before another dispatch or review.
Descriptions are limited to 3000 characters, expected results to 1500. Unknown delivery is never
automatically retried. Changing the bound chat pauses the queue and invalidates an active report.
After checking the old chat, an explicit Continue adopts the current binding.

Completion requires a correlated `studio.action/report` with the current run UUID, `ci: pass`,
actual-check description and a clean Git HEAD. A completed chat response or observer progress event
cannot itself complete a pool card. Codex's task prompt supplies the absolute report helper path and
port. Keep the JSON report outside the repository so the checkout stays clean. Example helper:
`node tools/studio.mjs report --file <report.json> --port 7878`. `create --file <task.json>` creates
drafts with title, description, expected, deps and priority; approving and starting remain user actions.

Claude receives the committed changes for each attempt, requirements, claimed checks and shared
notes through stdin. It runs with no tools, no MCP servers, hooks disabled, no persisted session,
and outside the project directory. This is a diff review, not an independent test execution or a
whole-repository audit. Missing context should produce a question. HEAD and clean status are checked
before and after review, so an obsolete verdict is rejected. Separate attempt ranges exclude commits
made by independent tasks between attempts. First findings return to Codex; after two non-passing
reviews the user decides. Findings go to shared Markdown memory and the Claude journal.

Pause/Stop interrupts the active Codex turn or kills the launched Claude review process. Existing
edits remain in files. Pause puts coding back in the queue; Stop requires an explicit retry or decision.
Planning also interrupts current work. Resume sends a new correlated attempt, not the old run's report.
Disconnected/failed Codex interruption is an error, not a confirmed stop. Restart restores the queue
paused, and interrupted coding requires inspection. Independent approved tasks can continue while a
question waits, provided the working tree is clean. An unresolved dependency never starts. Agents
approach the player within the reachable workspace; questions remain available through J/the podium
and pult even when the player is outside it. Native Codex permission dialogs stay in the desktop app.

Claude Code detection includes PATH, `~/.local/bin`, `AGENTCRAFT_CLAUDE_EXE`, and Windows Claude
Desktop's versioned `LocalCache/Roaming/Claude/claude-code` directory. The Electron `Claude.exe` is
not a CLI. Signing in to Desktop does not guarantee CLI authentication. On this machine the bundled
Code 2.1.288 was found, but `auth status` reported logged out. Use **Войти / проверить вход** and finish
the browser login before starting a reviewed pool. Neither credentials nor raw auth output are stored
in the game. Login is never initiated merely by opening the pult.

Queue/profile state is in the bridge's existing persistent store (`backend.studio`); shared notes are
in its memory directory. The latest ten shared records contribute up to 2000 characters of context;
the full notes and reports remain accessible in the library. Local appearance is in
`config/agentcraft-studio.json`, PNG copies in `config/agentcraft-skins`. Separate station coordinates
are keyed by the singleplayer save path. These client settings are not distributed to other players.
An existing workspace and the overworld singleplayer setup are still required.

Release 0.4.0 was installed with user approval on 2026-10-06 into
`C:\Users\GB\AppData\Roaming\.minecraft`. Installed JAR SHA-256 matches the tested package.
The source bridge was restarted at commit `ce1c9f6`, keeping `.agentcraft-home/traderecord`, tasks
and memory. The binding to this Codex chat was renewed after the app connection changed.
Client settings are unchanged. Previous mods are in `agentcraft-backups/20261006-122746-842`;
the bridge state and client config are in `agentcraft-backups/20261006-122746-499-0.4.0`.
Minecraft was closed and was not launched by the update. Start the existing Fabric profile manually.
In-game visual checks and a real authenticated Claude review remain pending; build and automated
checks do not substitute for those. Claude Code still requires the separate browser login.

Validation: the full Foreman check passed 556 tests, TypeScript and generated protocol documentation;
an additional immediate-pause regression and subsequent changes passed focused queue/observer/review
checks. Gradle build and all eight existing Java model tests passed. The portable smoke check runs
with its own temporary repository/home/port and an absent chat binding: draft approval, notes,
pause, clean shutdown, restart persistence and the bundled report helper all passed. It does not
send a task to the user's chat. Run it explicitly with
`node tools/test/studio-package.mjs <portable-directory>`.

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
the physical `Ё` key on a Russian keyboard) forwards text when the desktop chat binding is configured.
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
The Windows package contains AgentCraft 0.3.1, Fabric API 0.161.0+26.3, a bundled Node runtime,
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
chat by itself. Third-party `.schem`/`.nbt` builds are separate imports and are not bundled.

## Text from Minecraft to this desktop chat (0.3.0)

After the user explicitly authorizes game messages to the selected chat, run from that chat:

```powershell
# Source checkout, run inside foreman/:
node --import tsx ../tools/connect-codex-chat.ts
# Portable package:
runtime/node.exe connect-codex-chat.mjs
```

The connector reads `CODEX_THREAD_ID` and `CODEX_APP_TOOLS_PIPE_PATH`, confirms the thread with
the installed app's `read_thread` tool and saves `%USERPROFILE%/.agentcraft/codex-chat.json`.
`AGENTCRAFT_CHAT_CONFIG` overrides the path for isolated tests. No thread ids or machine pipe
addresses are committed or included in packages. Only one explicitly selected local chat is
bound; never silently change this selection to another chat. Re-run the connector from the
same chat if restarting/updating Codex changes its pipe. Renaming/removing the binding disables
delivery. The observer notices binding changes without restarting.

`codex-desktop.ts` implements only `read_thread` and `send_message_to_thread` over the installed
app-tools pipe, using its length-prefixed JSON transport. This private, version-sensitive adapter
is distinct from the public [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).
The local CLI's `queue` transport required a separate daemon on this machine, so it was not used
to resume the same desktop chat in a second execution process. The adapter does not spawn
models, change permissions, change model settings, or touch thread databases.

Plain text, `/goal text` and `@Codex text` are forwarded as user messages. `goal.submit` in
observer mode forwards without creating a local autonomous goal; actual progress reports still
create/update display tasks. A successful app acknowledgement means delivered, not executed.
Only public `agentMessage` commentary and completed final answers are copied back; commands,
tool outputs, reasoning and user-message history are excluded. The first read baselines old
messages instead of copying the entire history. A per-profile seen-id file prevents duplicates
on restart. Responses are read every five seconds; long answers are split into bounded feed/log
chunks. Delivery timeout is reported as uncertain with no automatic retry. Confirm in the chat
before resending. Native tool permission requests must be handled in the Codex application.

The desktop `read_thread` adapter currently labels final replies `final_answer`; both this
label and app-server's `final` are accepted, only for completed turns. The 2026-10-06 bridge
hotfix corrects the earlier filter which forwarded commentary but silently skipped final
replies. Unseen replies still present in the recent-turn window are delivered after restart;
existing seen ids continue to prevent duplicates. No Minecraft/JAR update is needed.

The transport inherits the loopback observer's trust of local processes. Do not expose port 7878
to other computers. Stop all but one observer instance for the selected game. App or protocol
errors fail closed and appear in `/chat`; reconnect/update the adapter if the app changes.

The console now has Russian observer-specific help and `/help blocks` (`/blocks`) explaining
every equipment/decorative block. The installer also detects source=target when extracted into
the game directory, avoiding moving its own source JARs into backup; copied JAR hashes are checked.

## Character behavior during chat (bridge update for 0.3.0)

Every five seconds the bridge reads the bound thread's actual lifecycle metadata, independently
of transcript forwarding. An active reply sends Codex to `desk` in `thinking` state, including
when the message was entered in the desktop app. Delivery acknowledgement alone does not move
the character or claim that work started. Fresh explicit progress has priority over generic
chat activity: reading, editing, testing and review keep their assigned stations.

Native `waitingOnApproval` / `waitingOnUserInput` flags send the character to `user`; handling
the request remains in Codex. Normal questions in a final answer require an explicit
`waiting_user` progress report; the bridge does not interpret prose. Such a report, or a blocked
or error report, survives reply completion. A new turn clears the previous turn's activity.

A completed reply shows `Ответ готов` at the desk and returns to `lounge` after ten seconds.
An explicit `done` report uses the same delay. A new reply or progress report cancels the pending
return. Interrupted/failed replies show stopped/error; disconnection never means success.
Completion of a conversation reply does not complete development tasks or change CI results.
The goal bar and task board still represent explicitly reported tasks, not every chat message.
Historical completed turns are not replayed on startup; an already active turn is recognized.

When detailed work progress expires after five minutes, a live active chat keeps Codex thinking
at the desk. Without a current chat status, the old activity expires as before. No automatic
mining, building or fighting was added; the existing movement and posture system displays work.
The mod JAR remains 0.3.0: only the bridge needs updating and restarting, without restarting
Minecraft. The prepared package is `dist/AgentCraft-Codex-0.3.0-chat-behavior-Windows.zip`.

## Real task controls and readable messages (0.3.1)

Before 0.4.7, the card's Message button opened the normal console directly, without the QA screen registry
or synthetic keystrokes, preserving a draft. Card and console messages use 75% text scale.
The card wraps full log entries instead of truncating the first line and supports wheel scrolling
through the retained history. Buttons and input fields retain their normal size.

`agent.action` with `marlow`/`codex` and `pause`, `resume`, `stop` is now allowed in observer mode.
The card buttons and `/pause`, `/resume`, `/stop` control the bound real chat. Pause uses the
desktop's user-stop interrupt path, including pausing an active persistent Goal. Resume sends
an explicit continuation to the same chat using the existing approved relay; it starts a new
turn from saved context, not a suspended process image. Stop first clears queued messages of
that bound chat, then interrupts it. Already completed edits are not rolled back.

Windows `codex-control.ts` uses the installed app's private `\\.\pipe\codex-ipc` router: initialize,
discover the owner of the bound local thread, target only that owner, and send the versioned
`thread-follower-interrupt-turn` (`user-stop`, v3) / `thread-follower-clear-queued-messages` (v1)
requests. This was inspected against Codex 26.930.4958; it is separate from app-tools and is
version-sensitive. It never launches another app-server, kills Codex processes, moves a thread,
or changes permissions. This maps to the [documented interruption lifecycle](https://learn.chatgpt.com/docs/app-server).

An IPC acknowledgement alone does not produce success: the relay reads back the exact bound
thread and confirms it is no longer active. Offline, unknown, mismatched and timed-out responses
return an error without claiming a pause. Native Goal-pause errors also propagate. Pause/stop
presentation is persisted by thread/turn in the local relay state file; a new real turn clears it.
Overlapping sends/controls are rejected, delayed old polls cannot overwrite a pending control,
and uncertain operations are never automatically retried. Other autonomous agent controls
remain refused. Permissions still require the Codex application.

The combined 0.3.1 archive includes the previously prepared movement fix. Updating this release
requires both the new bridge and JAR, and a Minecraft restart to load the changed screens.
Package: `dist/AgentCraft-Codex-0.3.1-Windows.zip`.

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
| done | Completed task; ten seconds at the desk, then the lounge |

`--ci running|pass|fail|unknown` is an explicit report, not an automatic test detector. Only report
`pass` after the relevant checks actually pass. Logs are deliberately supplied summaries, never
raw terminal dumps, secrets, broker tokens or private account data. A done task does not imply a
push or deployment. Describe exactly what finished in `summary`.

`--optional` skips an offline observer with a short timeout, so development is not blocked by
the game. It does not queue events or ignore validation/wrong-backend errors. Start the observer
and publish the current status to catch up. The observer is local-only and rejects browser
Origins by default; it trusts local processes, not an authenticated remote audience.

## Limits

- Detailed stages come from explicit progress calls; generic chat activity comes from the bound
  thread's lifecycle metadata. No tool-call classification or background coding agent is used.
- After five minutes without an active-work update, the character follows live chat activity or
  becomes idle with a stale-status message. The task remains at its last reported status.
- Restart restores tasks/logs and waits for a fresh report or current chat lifecycle snapshot.
- The existing Minecraft studio remains visible. Pause/resume/stop and text messages reach the
  explicitly bound chat; other autonomous task controls and native approvals remain disabled.
- Separate chats share one displayed character; the most recent report determines its activity.
  Their tasks remain separate when they use different keys.
- No managed AgentCraft worktree is created, so the game's Merge/diff workflow does not represent
  these changes. Review code using Codex/Git.

## Validation

### 0.3.2: lamp holograms and monitor messages

Right-click a status lamp to toggle its hologram. The optional `hologram` block-entity boolean
is saved in the world and synchronized from the server; changing it does not change the binding.
Existing atrium lamps default to on, other lamps to off. Sneaking, using the Configurator and
spectator interaction do not toggle it. Agent-bound lamps show a compact panel (about 1.9 blocks
wide, centred 1.65 blocks above the lamp origin): live agent state, assigned task and activity.
Paused and disconnected states are explicit; the large atrium retains its goal summary.

Agent monitors separate log entries with an 8-pixel gap, a type/time heading and indented body
text with 12-pixel line spacing. Empty paragraphs keep a 6-pixel gap. Prose and results wrap
without the former 4/2-line truncation; the wall still displays the newest tail, with older text
available in the agent card opened by right-clicking the character. Feed-only screens are unchanged.
The JAR update requires a Minecraft restart. No bridge restart is needed for these UI changes.

Validation: Gradle build and existing model tests on Oracle Java 25.0.2. In-game rendering,
click/toggle and world-reload verification remain pending; Minecraft was not launched or
restarted automatically. Version 0.3.2 was installed on 2026-10-06 in
`C:\Users\GB\AppData\Roaming\.minecraft` with Minecraft closed. Installed JAR hash matches the
release; prior mods are under `agentcraft-backups` and the client settings hash is unchanged.
The running bridge is unchanged; the user can now launch their Fabric profile manually.

0.3.1: Gradle build/model tests and the full Foreman check passed (527 tests, TypeScript,
protocol documentation). Control tests cover native IPC framing/owner targeting, bound queue
clearing, Goal-pause failures, persisted pause/resume, real-state confirmation, concurrent
controls, late polls and unavailable desktop transport. Live owner discovery succeeded; a
guarded interrupt request with a deliberately nonexistent expected turn id returned
`ok: true, interruptedTurnId: null`, confirming the actual route without interrupting this
development chat. A live destructive pause/resume/stop cycle and the new screen appearance
remain to be checked after the user restarts Minecraft with 0.3.1; no game was auto-launched.

Chat-behavior bridge update: the full Foreman check passed (516 tests, TypeScript and protocol
docs); after an additional rapid-follow-up/poll-order fix, TypeScript and all 31 focused relay /
observer tests passed. Fake-clock checks cover delayed rest and cancellation, explicit-stage
priority, approval waiting/resumption, disconnection/recovery, old-history baseline and stale
progress. The portable bridge on isolated port 17878 recognized the real active desktop reply
as `thinking/desk` and preserved an explicit `testing/testbench` stage over the next live poll.
The existing game client was not restarted or visually driven; actual walking uses unchanged
mod code and still depends on the world's assigned spots and passable paths.

0.3.0: Gradle build/eight model tests, all 501 Foreman checks and the protocol-doc check passed.
Desktop relay tests cover transcript filtering, initial baseline, final-answer completion,
restart deduplication, destination checks, overlapping sends, offline/uncertain delivery,
shutdown, fragmented pipe frames and timeout. A live `goal.submit` through the packaged bridge
delivered a marked QA message to the existing desktop chat; its public response appeared in the
bridge feed. Windows PowerShell 5.1 verified in-place installation leaves both JARs intact and
normal installation verifies hashes. Minecraft was not launched automatically for 0.3.0;
the new console help's rendering still needs checking in the user's next game session.

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
