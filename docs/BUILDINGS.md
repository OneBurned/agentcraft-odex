# Imported buildings

Minecraft chat (`T`) supports `/agentcraft preview <id>` and `/agentcraft place <id>`.
Tab lists built-in `studio`, `cabin` and `.schem` files in the selected profile's
`config/agentcraft/buildings`. Use lowercase file names containing letters, digits,
hyphens or underscores, for example `modern-base.schem` → `modern-base`.
WorldEdit is not required. These are local assets, not downloaded automatically by the mod.

## Prepared private asset pack (0.4.12)

| ID | Building | Width × depth × height | Source |
| --- | --- | --- | --- |
| `island` | Post-apocalyptic flying island | 61 × 53 × 75 | [Avokadyshka](https://www.planetminecraft.com/project/post-apocalyptic-flying-island/) |
| `lakehouse` | Northern Lakehouse | 43 × 35 × 26 | [DownTheBlockHomes](https://www.planetminecraft.com/project/northern-lakehouse/) |
| `modern-base` | Modern Base | 24 × 31 × 23 | User-supplied `modern-base.schem`; author not included in metadata |

The private package contains the original files and `SOURCES.txt`, outside the mod JAR.
The downloaded builds are not committed to this repository or relicensed under its MIT license.
The source files stay in `artifacts/building-import/buildings` for local packaging and verification.

## Placement

1. Aim at a block up to 64 blocks away and run `/agentcraft preview modern-base` (or another ID).
2. The chosen block is the centre block of the **lowest layer**. Even widths use the higher of
   the two central local coordinates. The outline lasts 15 seconds and reports width/depth/height.
3. Run `/agentcraft place modern-base` while aiming at the same block, from the same side.
   Move outside the preview volume first if the player intersects it. Rotation follows the
   player's side of the target in quarter turns relative to the original schematic.

For the floating island, make a temporary block at the desired height: the entire island starts
at that height and extends upward 75 blocks. It is not placed with its inhabited floor at ground level.
The bottom and the full outline are explicit; there is no guessed terrain height or foundation offset.

Placement replaces the full rectangular volume, **including air in the schematic**. First inspect
the outline. Registered buildings cannot overlap. Height/world-border checks and single-player
overworld restrictions apply to both built-in and imported buildings. Commands require cheats.

Imported buildings preserve the current agent layout, personal workplace assignments and world
spawn. Place AgentCraft equipment yourself and assign locations with the Configurator.
Built-in `studio`/`cabin` retain their existing behaviour: they activate their supplied workstations
and move the player/world spawn to the entrance.

## Import details and limits

- Gzipped Sponge schematic v2/v3: blocks, block entities, entities, four horizontal rotations.
- Biomes are not imported. Legacy `.schematic`, vanilla `.nbt` and `.litematic` are not supported.
- Maximum 16 MiB compressed, 128 MiB NBT accounting, dimensions 256×384×256, 1,000,000 cells,
  65,536 palette entries and 4,096 entities. Future Minecraft data versions are rejected.
- Convert to vanilla structure NBT, apply Minecraft's data fixer, then validate every block/property
  before modifying the world. Unknown blocks are errors instead of silent air replacements.
- A legacy `minecraft:grass` spelling found in Modern Base is normalized to `short_grass` even
  though its export declares the newer 1.21 data version. Other renames use Minecraft's fixer.
- WorldEdit source origin/offset metadata localizes hanging anchors and exact entity positions.
  Lakehouse contains 23 entities, including frames, paintings, armour stands and one wolf.
- The native structure placer rotates block states and entities, restores block-entity contents,
  and preserves schematic block shapes/waterlogging. Biome/terrain filling is not inferred.
- Command blocks and command-block minecarts are rejected. Schematics cannot register agent tasks.
- A bounded in-memory template cache is invalidated by file size/modification time and world close.

## Verification and packaging

From `mod`, run `gradlew.bat build -PtestBuildings=<absolute asset directory>`.
The optional asset test loads all three real files, migrates their palettes, checks entity/block-entity
preservation and verifies all four rotations around the selected centre. Vanilla data version 4885
removes obsolete bed block-entity records; bed blocks remain in the structure.
Without the private files, the asset test is skipped; parser regression tests still run.

Package with `node tools/build-portable.mjs <fresh output directory> <asset directory>`.
`Install-Mod.ps1` copies included schemes into the chosen game profile, verifies hashes and backs up
changed existing files under `agentcraft-backups`. Existing additional schemes/settings remain.
Installation still requires the user's separate approval and Minecraft closed. In-game appearance
and real placement remain to be verified after installation; the tests do not launch Minecraft.
