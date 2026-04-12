# Fresh File Explorer

Tribe paint many things on cave walls. Thousands of paintings. Most old. Covered in dust. Nobody remember who paint mammoth on back wall — maybe Elder Grug, maybe his elder before him.

But every sun-cycle, tribe only change few paintings. Hard to find which ones. Big Cave show ALL walls. Painting Change Log show too few. 

This tool show only **Fresh Files**. Ones tribe touch recently. Not too many, not too few — like good portion of roast elk.

# Links

[Tribe Trading Post](https://marketplace.visualstudio.com/items?itemName=frehu.fresh-file-explorer) | [Other Tribe Trading Post](https://open-vsx.org/extension/frehu/fresh-file-explorer) | [Sacred Source Cave](https://github.com/FreHu/vscode-fresh-file-explorer) | [2026 Readme](README.md)

# Table of Contents

- [Features](#features)
  - [Fresh File Explorer](#fresh-painting-explorer-1)
    - [Buried Painting Support](#buried-painting-support)
    - [Fire-Glow Coloring](#fire-glow-coloring)
    - [Bone-Pinned Wall](#bone-pinned-wall)
    - [Runner Status Signals](#runner-status-signals)
    - [Filtering](#filtering)
    - [Grouping Modes](#grouping-modes)
    - [Quick Pick](#quick-pick)
    - [Right-Click Actions](#right-click-actions)
    - [Many-Cave Support](#many-cave-support)
  - [Search Tools](#search-tools)
    - [Painting Change Search](#painting-change-search)
    - [Line and Symbol History](#line-and-symbol-history)
    - [Painting History](#painting-history)
    - [Search in Fresh Files](#search-in-fresh-paintings)
    - [Search in Found Paintings](#search-in-found-paintings)
    - [Search Wall Actions](#search-wall-actions)
- [Use Cases](#use-cases)
- [Cave Settings](#cave-settings)
- [Cave Defense](#cave-defense)
- [Contributing](#contributing)

# Features 

## Fresh File Explorer

Switch between viewing un-carved changes or paintings touched within configurable moons. 

Big Cave wall explorer show too many paintings. Painting Change Log show too few. This view sit between — like good cave, not too deep, not too shallow.

![loading](img/time-window-switch.gif)
  
### Buried Painting Support

When tribe member smear mud over painting, it not truly gone. Painting still appear on cave map, right where it was. Ready to be dug up.

- **Dig Up**: Tap buried painting. See read-only copy scratched on cave floor
- **Bring Back**: Restore painting to original wall `(git restore)`. Like mud never happen
  
![resurrect](img/resurrect.png)


### Fire-Glow Coloring

Paintings get colors based on when last touched. Bright like fresh ember = painted recently. Dim like old ash = painted many moons ago.

Toggle on Fresh Files view. Also paint Big Cave wall explorer with glow. Pretty. Help eyes find fresh work fast.

![heatmap](img/heatmap.png)

> Note: Fire-glow only know about paintings within selected moon-count. Anything older get cold-ash color. "Painted before anyone can remember."

### Bone-Pinned Wall

Special wall section where you pin paintings with bone. For paintings you want keep close no matter what rest of cave map show. Pin with drag-and-drop or right-tap in wall explorer.

![pinned section](img/pinned.png)

- Pin old painting you need watch over, like territory map or tribe rules
- Pin that one important flat rock sitting by cave entrance for 6 winters. Not need be from your cave
- Pin buried painting
- Pin search scratchings (must save as painting first)
- Scratch short notes. Use as task wall. Reorder. Mark done with charcoal X. Very organized tribe member
- Pin secret cave-entrance codes as notes. Wisest tribe elders do this

Pins stored per cave.

### Runner Status Signals

![sync status](./img/sync-status.png)

Info carved at top of cave map:

- When your paintings **behind/ahead** of **other tribe's cave** (need send/receive runner)
- When your paintings **behind/ahead** of **main cave wall** (need combine paintings)

Both signals can turn off individually.

### Filtering
- **Filter by Painter**: Hide paintings from specific tribe members
- **Filter by Carving Session**: Hide paintings from specific carving sessions
- **Path Filter**: Restrict painting history to specific cave chambers using [path markings](https://css-tricks.com/git-pathspecs-and-how-to-use-them/) (right-tap on cave chamber)
- **Focus on Chamber**: Show only paintings from one cave chamber (right-tap any chamber)
- **Clear All Filters**: Remove all hide-skins. See everything again
- Painter and carving session filters temporary — reset when change moon-count
  
![filter-commit](img/filter-commit.png)

> **Note:** Tool track only _most recent_ carving session per painting. If painting touched by both hidden painter and visible painter in same moon-count, painting hidden entirely (most recent session is what matters). This deliberate — for deeper history, consider Many-Eyed Rock Tool or learning more than 5 cave tracking commands.


### Grouping Modes

Organize paintings in ways beyond standard cave chamber layout:

![grouping modes](img/grouping-modes.png)

- **Cave Chambers** — Traditional. Paintings organized by which chamber they on

- **All In One Pile** — No chambers. All paintings thrown on floor

`freshFileExplorer.flatList.labelStyle` choose whether marking show full cave path or just painting name

- **By Painter** — Paintings grouped by who last touch them

- **By Carving Session** — One group per session

Also two groupings for advanced blame rituals:

- **Moon Phase** (`git blame moon`)

Uneven painting activity during full moon indicate werewolves among tribe. This important safety knowledge. Report to tribal council.

- **Sky Wanderer Retrograde** (`git blame universe`)

Track which sky wanderers going backwards when paintings made. Includes Pluto. Pluto still sky wanderer. Tribe has spoken.

> Note: This sky-watching (hard wisdom), not bone-throwing (garbage). If want know whether painting conflicts come from tribe member born when sun was in certain star-picture, look elsewhere. We not do that here.


**Relevant cave settings:**
`freshFileExplorer.defaultGroupingMode`
`freshFileExplorer.defaultSortOrder`

### Quick Pick

![quick-open](img/ff-quick-open.png)

Use **"Fresh Files: Quick Pick"** to get fast-pick of Fresh Files. Scratch name to filter. Select to open. Like Big Cave `Ctrl+P` but only show Fresh Files, with extra actions.

**Powers:**
- Respect current moon-count, painter and carving session filters
- Special filter options to narrow pile
- Special search option to look inside paintings
- Can filter first, then search — narrow down, then look closer
  - Example: filter "pending scraped" first
  - Second pick show only those
  - Now search only look inside those paintings

> Note: Quick Pick not show buried paintings. Those stay on cave map only.

### Right-Click Actions

- Open / Open to Side — show painting or show side-by-side comparison. If painting already on a workstation, go there instead
- Reveal in Big Cave Explorer / Painting Change Log
- Rename (`F2`) — rename paintings and chambers. Default use `git mv` so rename tracked properly, like moving painting to new wall but remembering where it was. See `freshFileExplorer.autoStageRename`
- Scrape Off Changes (for pending paintings)
- Bring Back (for buried paintings)

### Many-Cave Support

Work with:

- Chambers containing many caves in tunnels below
- Many-entrance caves
- Work-caves (separate cave while main cave preserved)
- Tunnel-caves inside bigger caves (experimental, might have quirks — like first attempt at wheel)
  
![submodules](./img/submodules.png)

---

## Search Tools

Tool add several ways to search through cave.

| Mode | Question it answer | Where it look |
|---|---|---|
| **Search in Fresh Files** | Where `x` in current work? | Inside paintings on walls, only fresh ones |
| **Search in Found Paintings** | Want find `y` in paintings that have `x` | Inside paintings, chained from last search |
| **Painting History** | What full history of this painting? | Painting log, follow wall moves |
| **Painting Change Search** | When was `x` ever scratched or scraped? | All carving sessions across all time `(pickaxe)` |
| **Line / Symbol History** | What history of this one drawing? | Painting log for specific scratches or named symbol `(log -L)` |

![History options](./img/history-options.png)

### Painting Change Search (pickaxe)

Answer question: "When was this mark ever scratched onto wall or scraped off?"

Access through painting right-tap menu ("Search Changes for Selection").

Results appear grouped by painting and carving session. Tap match to go there.

### Line and Symbol History
![l-history](img/l-history.png)
Access via right-tap in painting station → **"Line/Symbol History"**.

Based on what you point at, show every carving session that touched those lines or symbol. Follow wall moves. Wrapper of `git log -L`.

- **Point at one line** — treated as symbol name (use marking under finger)
- **Select many lines** — treated as line range

**A / B comparison:** Mark any two carving sessions as A and B. Tap **Compare** to hold those two versions side by side.

### Painting History

![file history](/img/file-history.png)

Available via: 
- Right-tap in Fresh File Explorer cave map
- Right-tap in painting station


### Search in Fresh Files

Search-torch in Fresh Files toolbar open Big Cave search with all visible paintings pre-filled. Search only within paintings you working on. Respect filters and moon-count. Search painting *contents* on wall. To search cave map itself, use `CTRL+ALT+F`.

Can also trigger from [Quick Pick](#quick-grab).

![search](img/ff-search.png)

- Respect painter and carving session filters
- Skip buried paintings (not on wall to search)
- Configure whether search open in view or as separate painting station (*default*)


#### Far-Seeing Rock Quick Pick
- Quick Pick `(CTRL+Q, F)` can switch to open in Far-Seeing Rock tool [(guichina.code-telescope)](https://marketplace.visualstudio.com/items?itemName=guichina.code-telescope). Better search but fully optional (this caveman not make Far-Seeing Rock, not install for you).

Need Far-Seeing Rock installed and `freshFileExplorer.codeTelescopeIntegration` enabled.


### Search in Found Paintings

**Problem:** "Want find `b` in all paintings that contain `a`."

**Solution:** Search for `a`. Then use action to open new search scoped to found paintings. Then search for `b`. Chain as many times as want. Like tracking animal through multiple cave chambers.

![search in found files](img/search-in-found-files.png)

> Action available only in search painting stations, not search view. But can easily open search view as painting station.

**Cave settings:**
- `freshFileExplorer.openSearchInEditor`: Open searches in separate painting station instead of search view
- `freshFileExplorer.searchPatternMaxLength`: Maximum marking length per batch. Set lower if hit cave wall length limits. Default (4000 marks) very cautious, can likely set much bigger on larger cave systems

> Many paintings or very long cave paths can hit wall-length limits (fast-search-beast thing). Painting list get split into batches, open as separate painting stations.

### Search Wall Actions
![search editor actions](img/search-editor.png)
New action buttons on search painting station:
- Search in found paintings — new search scoped to what you found
- Open all found paintings — open all as background painting stations
- Copy paths — copy cave paths from results

# Use Cases

## "Just enter big new cave. Many painting. Where start?"

Join new tribe. Cave has thousands of paintings. Most not touched in 75 winters. But wall explorer show everything. Brain hurt. Eyes hurt. Everything hurt.

| Approach                | How it work                                                                      | Pain                                                     |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Bare Cave Walls**     | Walk through all chambers by hand, maybe check Change Log for recent sessions        | Big pain — require much walking, no map |
| **Many-Eyed Rock**             | Use "Sessions" view, walk to paintings from there       | Medium pain — session-focused, extra steps     |
| [Fresh File Explorer](#features) | Open Fresh Files. See all paintings touched in last 30 suns as cave map | Small pain — immediate overview, familiar layout |

---

## "Swear painting was on this wall. Where go?"

Remember painting existed. Not there now. Moved to other wall? Covered in mud? Misremember which chamber? Been drinking fermented berry juice again? Someone else fault _this time_, but questioning own mind.

| Approach                | How it work                                                         | Pain                                        |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| **Bare Cave Walls**     | Search for painting, find nothing, assume own memory wrong           | Big pain — no hint burial happened           |
| **Many-Eyed Rock**             | Need think "maybe buried" and search session history | Big pain — require right way of thinking          |
| [Fresh File Explorer](#buried-painting-support) | Buried paintings appear right where they were                     | No pain — still there, just marked as buried |

---

## "Accidentally bury paintings. Want them back."

**Problem:** Smear mud over paintings. Now need them. They in cave history but wish easier to get back.

| Approach                | How it work                                                     | Pain                                                  |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| **Bare Cave Walls**     | `git log --diff-filter=D`, then `git checkout <hash>^ -- <path>` | Big pain — require elder shaman knowledge                             |
| **Many-Eyed Rock**             | Find burial session, view painting from that time, copy marks    | Medium pain — many steps                                    |
| [Fresh File Explorer](#buried-painting-support) | Buried paintings right there. Right-tap → "Bring Back"               | Small pain — one tap. Work on many paintings at once |

---

## "Made carving session. Now forget what working on."

Finish carving session. Now "pending changes" empty. Lost mental map of which paintings you touching. This actually discourage making frequent small sessions because want keep overview. Bad cycle. Like forgetting where you put spear after each hunt.

| Approach                | How it work                                                                                 | Pain                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Bare Cave Walls**     | Pending changes vanish after session. Must remember or check log                       | Big pain — punish good carving habits                                                                           |
| **Many-Eyed Rock**             | Can view recent sessions, but must walk to different part of cave                                         | Medium pain — info there but different wall, only so many walls fit in view |
| [Fresh File Explorer](#time-window-selection) | Set moon-count to "Last 7 suns" — carved paintings still appear on map | Small pain — carve freely, overview stay                                                                          |

## "Someone repaint entire cave same color. All paintings look fresh."

**Problem:** Big change happen (all paintings outlined in same berry juice, or cave-wide smoothing of walls). Now every painting look "fresh." Thousands of them. None useful. Actual work buried under berry juice flood.

| Approach                | How it work                                                                                           | Pain                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Bare Cave Walls**     | No way to filter by painter                                                                    | Big pain — must shout at echo chamber                |
| **Many-Eyed Rock**             | Can filter by painter in various views                                                                  | Medium pain — need know which wall to check         |
| [Fresh File Explorer](#filtering) | Filter out berry-juice painter, or (was _you_, yes?) filter out that carving session | Small pain — visual pick, instant result |

---


## "Nice tool but was looking for task wall"

**Problem:** Not enough task walls in world. Tribe need more ways to track tasks.

| Approach  | How it work  | Pain  |
| --------------- | ----------------- | ---------------- |
| **Bare Cave Walls**     | Not task wall | Big pain — must invent own task wall from scratch |
| **Many-Eyed Rock**             | Probably not task wall | Medium pain — maybe has one, hard to tell with 25 views  |
| [Fresh File Explorer](#bone-pinned-wall) | *Also* task wall | Small pain — right there on bone-pinned wall |
---

## "Nice tool but can group paintings by moon phase?"

[Yes.](#grouping-modes) Might be *only* tool in all known caves that do this. You welcome.

# Cave Settings

Look under `freshfileexplorer.` to see all adjustable rocks. Many knobs. Twist as needed.

# Speed of Cave

Unlike wall explorer (just need look at walls), Fresh File Explorer must read part of cave painting history. Done in one pass through cave on startup, then remembered. Startup speed basically `O(wait for cave history)`. Must re-read when switch cave tunnels or receive paintings from other tribe.

![incremental load](./img/incremental-load.gif)

Not looking 5 winters back in big cave help speed much. But you *can* look 5 winters back. We not judge how deep you want to dig.

# Cave Defense

Got questions about whether cave tools in general can be trusted. Fair concern. Any tool you bring into cave could secretly be carved by enemy tribe.

What this caveman can promise:

- Fresh File Explorer have no spy birds. Send no runners to other caves. Not ask sky spirits for advice. Tool live simple life
- All carvings right here for you to inspect. Zero tool dependencies. Just this tool and cave tracking
- Worried about this caveman getting captured and enemy tribe pushing bad update through? Turn off automatic tool updates. Lose new features and new bugs, but keep carvings you once chose to trust
- Trading post access tokens not stored in this cave. Sacred spirit automation handle publishing to both trading posts. This caveman not publish to other trading posts

Potentially dangerous features: none really. But for completeness:
- Destroying operations: [scrape off pending changes](./src/commands/discardChangesCommand.ts) and [throw away paintings](./src/commands/basicCommands.ts) (moved to trash pile). Both work on paintings you yourself select, and give warning bark first
- Rename use `git mv` by default, or plain wall-move if `freshFileExplorer.autoStageRename` turned off. Never paint over existing paintings
- Can create new paintings if you choose (via create or bring back), but never paint over existing ones
- Viewing buried paintings (`dig up`) save copy as scratch on cave floor in temp area. Only for paintings you try to look at. If want something truly gone, scrape it from floor too
- Commands with tribe-member-controlled markings (like painting names from cave tracking output) use safe invocation to prevent enemy injection into echo chamber

Warnings:

- Not install random tools from trading post just because look shiny. They can do anything inside your cave. Except this one. This one good
- Tribe member who not already know this unlikely to read these wall carvings. But here we are

# Contributing

Find bad painting or have idea for faster mammoth? Open complaint at Sacred Source Cave.

Bug reports much more useful if problem happen in public cave that anyone can visit.


# Comparison with Many-Eyed Rock

Fresh File Explorer **not** Many-Eyed Rock replacement. More focused tool for finding paintings you need right now. Not make carving sessions, manage cave tunnels, stash piles, marking stones...

**Use Fresh File Explorer when**
- You want one view of cave

**Use Many-Eyed Rock when**
- You want 25 views of cave

![gitlens views](img/gitlens-views.png)

One of those 25 views actually very similar to Fresh File Explorer. More comparison [here](./COMPARISON_WITH_GITLENS.md).

# Tribe Praise

> This is **above average** for Big Cave tool.
>
> _(trained echo-spirit instructed to pretend to be Linus of Torvalds tribe)_
