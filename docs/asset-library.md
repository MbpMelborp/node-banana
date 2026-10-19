# Asset library

Every image, video, audio clip and 3D model a workflow produces is saved to
disk as it is made, whether or not the workflow has a project folder, and
shows up in the **Assets** view. Projects still exist. An asset records the
workflow it came from, so creating a project adds that workflow's earlier
assets to it without moving any files.

The library root is the **Node Banana folder**. It holds the projects saved
by name (`<root>/<Project>/`), `Generations/` for workflows that have no
project yet, `Edits/` for the Edit video view's edit files
(`<name>.nbedit`, see [edit-video.md](edit-video.md)), and the hidden
`.nodebanana/`. Neither `Generations` nor `Edits` is ever a project's name.

## Where files go

| | macOS | Windows | Linux |
|---|---|---|---|
| Node Banana folder (default) | `~/Documents/Node Banana` | `Documents\Node Banana`, or `%USERPROFILE%\Node Banana` when Documents is inside OneDrive | `$(xdg-user-dir DOCUMENTS)/Node Banana` |
| Thumbnails (rebuildable) | `~/Library/Caches/Node Banana` | `%LOCALAPPDATA%\Node Banana\Cache` | `$XDG_CACHE_HOME/node-banana` |
| Location choice | `~/.node-banana/library.json` | same | same |
| Project registry | `~/.node-banana/projects.json` | same | same |

The library root is resolved on the server, so the desktop app and
`npm run dev` agree. Resolution order:

1. `NODE_BANANA_ASSET_LIBRARY` (tests, scripted Electron runs).
2. The saved choice in `~/.node-banana/library.json`.
3. `NODE_BANANA_DEFAULT_LIBRARY`, which Electron main computes with the
   OneDrive rule.
4. The platform default.

Under `NODE_BANANA_ASSET_LIBRARY` the location choice and the project
registry live in `<root>/.nodebanana/` (`config.json`, `projects.json`)
instead, so an isolated run never touches `~/.node-banana`.

The first successful use saves the default root to `library.json`. If the
default folder can't be written (for example Controlled Folder Access, or
permissions), the library falls back to `~/Node Banana` and says why. On a
hosted, read-only server the library is unavailable, and recording falls back
to the old project-only save.

```
<root>/
  Generations/YYYY-MM-DD/HHMMSS_<prompt>_<sha8>.<ext>   assets of workflows with no project
  Edits/<name>.nbedit                                  edit projects (no media: asset ids only)
  .nodebanana/                                         hidden metadata
    library.json                                       marker
    assets/<assetId>.json                              one sidecar per asset
    runs/<runId>.json.gz                               workflow snapshots of a run
    media/<sha256>.<ext>                               snapshot inputs no asset holds (uploads)
    media/<sha256>.ref                                 checked pointer to a kept project file a snapshot uses
    posters/<sha256>.webp                              video posters made in the browser
    workflows.json                                     workflow id → name, project folder
    journal.ndjson                                     change log (other processes, tombstones)
    writers/, lock, move.json                          in-flight writes per server; a running move
    project-move.json                                  the project a projects move is copying (from, dest, phase)
```

A workflow with a project keeps writing into `<project>/generations/` under
the legacy `<prompt>_<md5>.<ext>` name, and the library indexes those files
where they are. Files are never moved by classification. The same bytes
produced twice are stored once per destination folder, and each production
still gets its own record.

## Recording

`src/lib/assets/client/recorder.ts` is the only path by which the browser
saves an asset. `initAssetLibrary()` runs once from `page.tsx`. Executors
receive `ctx.recordAsset` only while the library is available, and fall back
to `/api/save-generation` for project workflows otherwise.

- The id is minted in the browser, so it goes into the carousel entry together
  with the output. Nothing is written back to node data later.
- data: and blob: media are turned into Blobs when the call is made, and
  http(s) URLs are downloaded by the server. Uploads are two-step
  (`POST /api/assets` → ticket, then `PUT /api/assets/uploads/[id]` with the
  raw bytes), and the server streams them to disk while hashing.
- Recordings have their own queue (concurrency 2). They never count as
  `pendingMediaSaves`, so tabs stay usable. Only project-mode recordings,
  which still rename carousel ids, are tracked.
- Generated assets come from nanoBanana, generateVideo, generateAudio,
  generate3d and comfyApp (every media output). Edited assets come from
  removeBackground, imageResize, gifEncoder, videoStitch, videoTrim,
  easeCurve, videoFrameGrab, splitGrid cells, the annotation editor (Done
  with at least one shape), canvas split-to-nodes, Frame to canvas (an
  image, producer `imageInput`, operation `frameGrab`) and renders from
  the Edit video view (producer `nodeType: "editProject"`; the edit's id
  and name stand in for the workflow, with no workflow snapshot). An edited output
  identical to the previous one is not recorded again.
- A run that is one of a batch ("Run 10×") carries `batch` (`id`, `index`,
  `count`) in its run context, and every asset it records keeps it in its
  sidecar. The server drops a tag that does not hold up.

## Files nothing can read

A file whose bytes are not a readable image, video or audio file is kept,
file and record, but never shown. Its record says `unreadable`, and no
scope, arrival poll, facet, library count or "select all" includes it. Its
id still answers (`getAsset`, `exists`), since a carousel may hold it.
Being unreadable never changes, moves or deletes the file.

The test is careful, so a valid file is never hidden (`readable.ts`):

- **Image**: the first bytes name no format, and sharp reads no size either.
- **Video or audio**: the first bytes name no container, and mediabunny
  recognises none either.
- **3D**: never.

"Name a format" is wider than what the library keeps or mediabunny opens:
QuickTime and MP4 files that open with `moov`, `mdat`, `wide` or `free`
instead of `ftyp`, any RIFF or IFF form (AVI, RF64), ASF, FLV, MPEG program
streams, BMP, TIFF, JPEG 2000, an SVG after a long comment or in UTF-16, and
any of these after zero padding all count, since a player may still open
them.

When the answer can't be sure (the file can't be read right now, a probe
timed out, sharp won't load, or an existing record's file is no longer the
size the record says), nothing is marked. A mark is never undone.

It is checked when a recording arrives (the file and record are still
written), during "Import existing projects" (such files are skipped, and the
message says how many), once per start for the records that may be affected
(images with no size, video and audio with no duration; in the background, a
few at a time), and when sharp can't decode an image's file for a thumbnail.

Such files came from older save routes. They decoded a whole data URL,
header included, when its media type was empty. `src/utils/dataUrl.ts` now
decodes only the payload, and the routes name a file by what its bytes are.

## Opening the original workflow

Each run brackets its recordings (`beginRun` / `endRun`). The run's starting
graph is encoded the first time the run records an asset. The graph at the
end of the run is encoded too, unless the canvas was replaced mid-run. Media
in a snapshot becomes `{ $nbMedia: sha256 }` refs, and the browser uploads
only the bytes the server lacks.

"Open workflow" hydrates the snapshot and puts the asset back into the node
that made it. The copy opens as a new, unsaved tab named
`<name> (27 Sep 14:32)`, with a fresh id and no folder, so it can never
overwrite a project. For a project's asset, "Open project" opens the project
itself, and "Open as it was when made" opens the snapshot.

## Deleting

**Trash** is the in-app bin: restorable, and emptied after 30 days.

**Delete permanently** only applies to items in the Trash, and to records
whose file is already gone ("Remove from library"). The server refuses it for
anything else. It removes the record. What happens to the file depends on
where it is:

- A library file goes to the OS Trash (Recycle Bin), unless another record or
  a stored snapshot still uses the bytes. Snapshot-referenced bytes move to
  `.nodebanana/media` instead.
- Files inside project folders stay unless you opt in, because the project's
  workflow file points at them. A snapshot that still uses one keeps a checked
  `.ref` pointer to it, not a copy.

A run's snapshot is deleted with its last asset, so emptying the Trash frees
the space. If some asset record can't be read at that moment (a cloud
placeholder, a locked file), the delete keeps the files and notes them in
`.nodebanana/pending-release/`, and the next delete or clean-up releases them
once every record reads again. The 30-day auto-empty uses the OS Trash too. The one exception is
web mode on older macOS, where only the Finder route exists and would prompt
for permission; there it deletes the files outright.

## Projects

The app knows a project from three places, merged by `listKnownProjects`
(`known.ts`) for `GET /api/assets/projects`, newest first:

- the Node Banana folder itself: any folder in it with a Node Banana
  workflow file (a `.json` with `version`, `nodes` and `edges`, read from its
  ends only) or a `generations/` folder, except `Generations/` and
  `.nodebanana/` (same bounds as the project search below, 5 seconds);
- the **project registry**, `projects.json`: `{ v, projects: [{ dir, name,
  addedAt, lastOpenedAt, indexedStamp }], offer: { dismissed }, adoption:
  { done } }`, listed while the folder still holds a workflow file
  (`registry.ts`: atomic writes, tolerant reads, folders absolute and unique
  by case-folded path);
- the project folders the workflows table names.

Each page load reports what its own localStorage remembers
(`POST /api/assets/projects/report`: the `node-banana-workflow-configs`
folders and the old `node-banana-workflows-directory`) into the registry;
the two builds keep separate localStorage. **Adoption** happens once: while
the root is still the default, a workflows folder that exists becomes the
Node Banana folder — switched to when nothing is saved in the library yet,
else the library moves there. Adoption is also marked done when the library
already holds assets and the page had no workflows folder.

**Auto-index.** After the library is ready, when the root changes and when
the registry gains folders, every known project whose `generations/` stamp
(mtime and entry count) differs from its `indexedStamp` is imported in place
by one quiet import job (never shown in the library status), and the stamps
are stored. It never runs alongside another job or a move; it looks again
30 seconds later. A job the user starts stops a quiet one first
(`JobRunner.startOverQuiet`), so the hidden job never refuses them.

**Bringing projects in** (`POST /api/assets/projects/bring-in`) takes the
projects found under a picked folder and a mode: `use` makes that folder the
Node Banana folder (moving the library there when it holds anything, else
switching), `move` starts the projects move, `leave` lists them where they
are for the auto-index. The search behind it (`/import/scan`) reports each
project's size and `recommendUse`: every visible entry at the folder's top
is a project, holds one or is a loose workflow file.

**The projects move** (job type `projects`, `projectMove.ts`) moves each
outermost folder in turn to `<root>/<name>`, numbered past a taken name
(case-insensitively, `Generations` and `Edits` reserved). It copies without following
links, checks every file's size, copies again what changed meanwhile, then
points the library at the copy — records of its files (`relocateExternal`,
under each record's lock), workflow rows, `media/*.ref` snapshot references
and the registry — and only then deletes the source. A source that can't be
removed is reported in `job.moved` with `leftovers`, not as a failure.
Cancelling stops between files and removes the copy in progress; projects
already moved stay moved.

Only a folder that is nothing but a project moves: never a drive root, the
home folder or its standard folders (Desktop, Documents, Downloads, …), nor
one whose top holds anything besides workflow files, `generations/`,
`inputs/`, `outputs/`, `.images/` and projects of its own. The offer counts
only such folders and lists them in `elsewhere.dirs`. If the library can't
follow the copy, the records and registry are put back and the copy goes.
`.nodebanana/project-move.json` names the project in progress: a copy still
`copying` is never listed or indexed and is removed at the next start while
its source exists. The last pass before the source goes compares by size
and mtime with the source as last copied, and copies keep their times.
Each `job.moved` entry repoints the page (`movedProjects.ts`): the open
canvas and parked tabs, `node-banana-workflow-configs` and in-flight runs.

"Move everything there" sends the old folder's projects with the library
move (`SetLibraryRootRequest.projects`); the server moves them into the new
folder after the library, in the same job.

**The offer.** `GET /api/assets/projects` also sums the known projects
outside the Node Banana folder (`elsewhere`: outermost count, size, groups by
parent folder) for "N projects live in other folders", until
`POST /api/assets/projects/offer { dismissed: true }`.

**Saving a project by name** needs no new save route: the client composes
`<root>/<folder>`, and `GET /api/assets/projects/folder-name?name=` answers
the folder (made safe for every filesystem, numbered past a taken one) and
whether the plain name was taken.

## Moving the library

Settings → Storage → Change… offers two choices:

- **Move my library there.** This is a background job. It copies
  `Generations/`, the edit files in `Edits/` and `.nodebanana/`, verifies each file's size and hash,
  switches the root, then deletes only the copied files from the old folder.
  Projects stay where they are. Writes pause while the move runs, in this
  server and in any other one using the same library. A folder that already
  holds a library, or edit files in its `Edits/`, is refused.
- **Use that folder.** This switches to the new folder; the old library stays
  on disk.

A move that stops part-way is detected at the next start and its partial copy
undone.

## Importing existing projects

`POST /api/assets/import` indexes the files in each project's
`generations/` folder where they are; the auto-index runs it for known
projects. `POST /api/assets/import/scan` (`projects.ts`) finds every project
under a folder you pick, however deeply nested, for bringing projects in. A project is a folder whose
`generations/` holds at least one media file; it is named from its newest
workflow file, else its folder. The search goes up to eight levels down,
never follows links, and skips hidden folders, `node_modules`, `__pycache__`,
system folders and paths over 1,024 characters (the import refuses both),
the library's own `Generations/`, `.nodebanana/` and thumbnail cache (also
when either is reached through a link), and a project's `generations/`,
`inputs/`, `outputs/` and `.images/` (its other subfolders are still
searched, since projects nest). It
stops after 20,000 folders, 500 projects or 15 seconds (even when a folder
never answers) and says so, and says how many folders it couldn't read.

## Access

`/api/assets/*` and the older routes that take a file path answer only Node
Banana's own page on this computer. That is the same loopback stamp as the
agent routes, so run the app with `npm run dev` / `npm start` / Electron.
`NB_LIBRARY_ALLOWED_HOSTS` opts other hosts in, for example a LAN address.

## Key files

| Purpose | Location |
|---|---|
| Contracts (records, queries, snapshots, routes) | `src/lib/assets/types.ts`, `src/lib/assets/query.ts` |
| Server facade the routes call | `src/lib/assets/server/index.ts` |
| Index, journal, queries, deletes | `src/lib/assets/server/library.ts`, `search.ts` |
| Upload/URL ingest, dedupe, downloads (SSRF-guarded) | `src/lib/assets/server/ingest.ts`, `download.ts` |
| Location resolution, platform defaults | `src/lib/assets/server/paths.ts` |
| Thumbnails (sharp), jobs (move, import, cleanup, export) | `src/lib/assets/server/thumbs.ts`, `jobs.ts` |
| Finding the projects under a folder | `src/lib/assets/server/projects.ts` |
| Project registry, known projects, the projects move | `src/lib/assets/server/registry.ts`, `known.ts`, `projectMove.ts` |
| Unreadable files (what can't be opened, the load-time look) | `src/lib/assets/server/readable.ts` |
| data: URLs and magic-byte sniffing (shared with the save routes) | `src/utils/dataUrl.ts`, `src/utils/mediaSniff.ts` |
| Reveal / OS Trash (Electron bridge or OS tools) | `src/lib/assets/server/desktop.ts`, `electron/lib/bridge.cjs` |
| Request guard | `src/lib/assets/server/guard.ts` |
| Routes | `src/app/api/assets/**` |
| Recorder, snapshots, open workflow | `src/lib/assets/client/` |
| Store integration | `src/store/execution/assetRecording.ts`, `workflowStore.ts` (`_currentRun`, `ensureWorkflowId`, `recordUiAsset`) |
| Assets view | `src/store/assetStore.ts`, `src/components/assets/` |
| Settings → Storage | `src/components/settings/LibrarySettingsTab.tsx` |
| The page load's project report | `src/lib/assets/client/projects.ts`, `src/app/page.tsx` |

## Tests

- Server: `npx vitest run src/lib/assets/server`. These are node tests on
  real temp directories, pinned with `NODE_BANANA_ASSET_LIBRARY` or an
  injected path context.
- Routes: `npx vitest run src/app/api/assets`.
- Client, store and UI: `npx vitest run src/lib/assets/client src/store src/components/assets`.
- Electron bridge and default location: `npm run electron:test`. Scripted
  Electron runs (`NODE_BANANA_ELECTRON_USER_DATA`) keep the library inside
  the temp profile.
