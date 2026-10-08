AgentCraft — portable Windows package

INSTALL AND START
1. Install Minecraft Java 26.3, Fabric Loader 0.19.5+ and Java 25.
   You need Git and your own Codex desktop/native CLI or Claude Code installation.
   No logins or tokens are included. Never paste credentials into AgentCraft settings.
2. Extract the complete package, including PACKAGE-READY.json and release-manifest.json.
   Save your world, close Minecraft and stop the bridge. Setup never launches the game.
3. Run Setup.cmd, choose English and Install / update. Select a separate EMPTY destination,
   your Fabric profile's game directory and the selected Fabric version JSON from
   versions/<version>/<version>.json in your launcher directory. Third-party launchers
   need equivalent Fabric metadata with inheritsFrom 26.3. Setup checks this metadata;
   select the corresponding launch profile yourself. Drive roots, overlapping folders,
   symbolic links and junctions are refused.
4. Add local Git repository roots with an existing commit and checked-out branch.
   GitHub owner/repo is optional. Remote reads use your own gh auth login and permissions;
   Setup does not grant access, clone repositories or change their remotes.
5. Add agents or leave the team empty and configure it from the game.
   Choose each name, Codex desktop / Codex CLI / Claude Code, and roles.
   Codex supports planner/developer/reviewer; Claude supports developer/reviewer.
   Arbitrary-team Claude planning tools are not connected yet. New agents are disabled.
   Multiple agents of one provider need distinct conversations.
6. Bind existing conversations now or through Command desk → Team later.
   Codex desktop needs a dedicated threadId and the application's pipePath.
   From the authorized Codex chat you can also run Connect-Codex.ps1 -Agent <ID>
   after starting the bridge. The same conversation cannot belong to two agents.
   Codex CLI needs a local project, native codex.exe, unique connection UUID (generated
   by Setup), and read-only or workspace-write for development. Sign in to CLI yourself.
   Claude needs its own workspace with access.json, instructions and conversation.json.
   Setup can prepare one in workspaces/<ID>. Sign in to Claude yourself, run that folder's
   Start-Session.cmd, send a message, then close the session. Bind its workspace path and
   sessionId from the command desk. Native conversation history is never manufactured.
7. Check an agent from Setup while the bridge is stopped, or from the in-game desk.
   Checks never invoke a model or edit a project. Desktop reads the selected chat;
   CLI checks its version/commands/login; Claude checks its native session and CLI login.
   Configure Claude developer SDK authentication separately using your provider's tools.
   Auth configuration alone does not prove API access. Setup accepts no API keys.
8. Run Start-Bridge.cmd FROM THE INSTALLATION DIRECTORY, then your Minecraft/Fabric profile.
   The bridge listens only on 127.0.0.1:7878. Find the AgentCraft command desk in the creative
   inventory. Check connections and enable agents there. Appearance, PNG imports, persona,
   phrases, places, archive and restoration are available from the team editor.
   Approve a plan before starting execution. Stop-Bridge.cmd stops this bridge.
   Install-Mod.cmd is a compatibility entry point to the same wizard.

UPDATE, ROLLBACK AND RECOVERY
Extract the NEW release separately and run its Setup.cmd. Do not manually unpack over a
used installation. Choose the existing directory containing installation.json and the same
game directory. The running installed runtime cannot replace itself.
Updates retain projects, team.json, personas, memory, connections, places, skins and settings.
Worlds are not changed. Only manifest-owned release files and mods identified by the IDs
agentcraft/fabric-api are replaced, even when their JARs were renamed. Other mods remain.
An explicitly included schematic pack is installed with replaced-file backups; standard
releases contain no personal schematics.
Before replacing files, .installer-backups/<operation> receives the original bytes, a checksum
journal, a snapshot of data and AgentCraft game settings. External provider directories,
native transcripts, logins and tokens are not copied. Workspaces and worlds remain in place;
installation backups do not replace their own backups.
Roll back, run from a separately extracted package, restores previous program/mod files.
Current user data, including notes added since update, is retained. This is binary rollback,
not automatic data-schema migration. If the old version cannot read newer data, stop and
review the saved profile snapshot before restoring it. A first install has no prior version.
Manually customized release files are not overwritten; preserve and compare them first.
Copy failures trigger automatic restoration. A power interruption or failed restoration leaves
.installer-active.json, which prevents the bridge from starting. Close the game/bridge and
choose Recover interrupted setup. Do not delete this guard manually. Checksum conflicts
preserve files for operator review.
Folders without installation.json are unmanaged: choose a fresh empty destination. Migration
of an older pair of agents is a separate operation described below.
Never distribute a used installation, data, workspaces or backups.

MIGRATE AN EXISTING PAIR
Pause the queue, finish/stop active tasks, close Minecraft and stop the old bridge.
Return the shared Claude conversation from terminal/Code. Leave Codex open and idle.
From this package folder run:
  runtime/node.exe migrate-team.mjs apply --profile-dir "D:/AgentCraft/data/observer" --game-dir "D:/Minecraft/Fabric" --codex-binding "D:/AgentCraft/codex-chat.json" --backup-dir "D:/AgentCraft-backups/before-team"
Replace all paths with your own absolute paths. Select a NEW backup folder outside the
profile, game and Claude workspace. A busy/unknown conversation or active task blocks migration.
No model task is started. Symlinks/junctions and customized extra agents require separate handling.
The tool backs up the full profile, Claude workspace, Codex binding and AgentCraft game
settings/skins/world metadata. It keeps the original two IDs, history, pending replies,
paused cards, personas and furniture assignments; unused default NPCs are not added.
Provider-owned native conversation history and login stay in place and are not copied.
The migrated pair retains its original queue, initially paused. Changes to composition/roles
require explicit queue.enable; names, appearance and visibility remain editable even with unfinished
cards, open questions or a running dialog. Disabling waits for the active queue task or Claude reply
to stop. Existing codex/claude aliases and all-to-Codex routing are retained. Fresh teams are unaffected.
Repeating a successful apply does not change files. To restore, stop work/game/bridge and
return Claude again; run the same command with restore instead of apply and the SAME paths.
Current managed data is backed up under before-restore-<UUID> before restoring original bytes.
New files in managed profile/workspace/skin folders are removed there, but kept in that backup.
Restore compatible old bridge/mod binaries separately if reverting to an older release.
If interrupted, use restore before starting the bridge; its maintenance guard blocks partial data.
The normal conversation Return command also releases a dead game owner's lock, after verifying
both recorded processes have exited. PID guards remain conservative on access errors/reused IDs.
Never kill a process based only on a saved PID. With work stopped, verify image/path/start time;
only if it is confirmed unrelated, copy and rename the stale foreman.json/portable.json or adjacent
<profile>.migration-lock.json with a .stale suffix, then retry restore. Do not change state/team files.
If ownership cannot be verified, keep the guard until you can inspect the process.
This is not a full Minecraft world or account backup. Never distribute used data or backups.

SETTINGS AND TEMPLATES
The command desk edits names, appearance, personality and phrases. The launcher
copies personas.example.json only when a new profile has no personas.json.
Set the Claude Code executable in the selected agent connection editor.
Do not select the graphical application's executable instead of Claude Code.
workspace-template contains neutral instructions, not a configured Claude connection.
Fill PROJECTS.md with your own projects; NOTES.example.md is an empty notes starter
that can be copied as MEMORY.md when separately configuring a workspace.
Copying templates does not grant access or enable shared conversations/planning.

IMPORT YOUR PNG SKIN
Command desk → Appearance → select the agent → Load PNG.
Enter the full path to a real 64×64 PNG, at most 512 KiB.
Apply the appearance, selecting wide/slim arms and the outer skin layer as needed.
The file is copied to the game's config/agentcraft-skins folder as SHA-256.png;
the original file is no longer needed. Selection is saved in config/agentcraft-studio.json.
Custom imports require 64×64. Some bundled 64×32 skins have a separate legacy conversion;
this does not enable legacy custom imports. Six additional skins are labelled Skin 1–6.
Before public distribution, the user must confirm redistribution rights; see SOURCES.txt.

BUILDINGS
The standard package includes no personal building schematics. Put your own .schem
files in the game's config/agentcraft/buildings folder. Use /agentcraft preview <name>,
step outside the preview bounds, then /agentcraft place <name>. Preview remembers the
centre. Placement replaces the whole volume, including schematic air. Back up the world first.

CHECKS AND LIMITATIONS
The builder audits package contents, including nested JARs, before marking it ready.
Personal paths, projects, conversations, memory and accounts are excluded from distribution.
Third-party license notices, including their authors' public contact details, are preserved.
Build and PNG import checks do not establish visual correctness in a running game.
A disconnected bridge does not confirm task completion. Provider permissions and
capabilities depend on the provider's own application.

ROLE QUEUE
Select a project, developer and reviewer when planning, or explicitly skip review.
Enable automatic agent assignment separately in settings. Approve before starting.
Queue pause prevents new dispatches; agent card controls affect its real execution.
Interrupted work requires reconciliation after restart, never automatic replay.
See ROLE_QUEUE.md for commands and provider permission boundaries.
