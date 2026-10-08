AgentCraft — portable Windows package

A2 — TEAM DATA MODEL
A new profile creates an empty team.json. Manage agents with studio.mjs actions
team.get/create/update/disable/archive/restore. New-agent connections, queue execution
and the team setup UI are subsequent stages. Protocol 2 requires matching mod, bridge
and tools. The chat, desk and connection workflow below applies only to existing
legacy profiles, not a new team. Legacy migration is a separate stage.

This is a neutral build of the existing observer mode: Codex performs work in a
connected desktop conversation and Claude can review changes. An arbitrary team
and its setup wizard are separate development stages, not completed features of
this package. No account logins are included.

INSTALL AND START
1. Install Minecraft Java 26.3, Fabric Loader 0.19.5 or newer, and Java 25.
   You need Git and your own signed-in Codex desktop application.
   Reviews require your own installed and signed-in Claude Code.
2. Extract the complete package to a separate folder. Check PACKAGE-READY.json exists.
   Do not put the package inside mods. Save your world and close Minecraft first.
3. Run Install-Mod.cmd and select your Fabric profile's game directory.
   AgentCraft and Fabric API are installed; replaced mods are backed up.
   Existing settings are preserved. Minecraft is not launched automatically.
4. In the chosen Codex desktop conversation, ask it to connect that conversation by
   running Connect-Codex.ps1 from this package in that conversation's environment.
   Double-clicking the script cannot supply the desktop conversation identity.
   The local binding is saved to data/portable/codex-chat.json.
5. Run Start-Bridge.cmd. To select a Git repository, run this instead from PowerShell
   in the package folder:
   .\Start-Bridge.ps1 -Repository <full-path-to-your-repository>
   The bridge listens on 127.0.0.1:7878 only. Stop another bridge if the port is busy.
6. Start your Fabric profile and open an ordinary single-player world.
   Find the command desk, console, monitor and workspace configurator in the creative
   inventory. Check the recipient before sending a console message with Enter.
   Assign places with the configurator. A plan draft does not start execution.
7. Stop-Bridge.cmd stops this package's bridge. Runtime data is in data/portable and
   logs are in logs. Do not redistribute a used package folder as a clean release.

SETTINGS AND TEMPLATES
The command desk edits names, appearance, personality and phrases. The launcher
copies personas.example.json only when a new profile has no personas.json.
Set the Claude Code executable and check your login in the settings tab for reviews.
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
