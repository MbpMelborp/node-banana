# Stitch editor

The Video Stitch node (`videoStitch`) joins the videos connected to its
`video-*` sockets into one clip, with the music on its `audio` socket under
them. The editor is where that sequence is finished: the clips' order, a
trim for each clip, each clip's own sound, and the music's volume over time.
What the editor shows is what Stitch encodes.

## What the editor does

It opens from **Expand** in the node's floating header (beside Run and the
menu) or from **Open editor** on the card, beside Stitch. It is a
near-full-screen `Dialog`, 24 px from every edge of the window like the
annotation editor (so nothing in it sits in the desktop app's drag region),
with its own darker chrome (the `editor-*` tokens in `globals.css`):

- **Header**: "Stitch", then "N clips · length · W × H · F fps" (the frame
  rate only when the clips agree); Undo, Redo, Cancel and Done.
- **Stage**: the sequence previewed at the playhead, letterboxed.
- **Transport**: go to start, play, go to end, the timecode, Snap, Sound,
  the zoom slider and Fit.
- **Rail**: the selected clip's name and source, Trim (In, Out, Length),
  Audio (Clip audio, Volume), Split at playhead, Reset trim, Reveal source
  node, Remove from stitch; with the audio track selected, Track sound and
  the quick curve buttons (Fade in, Fade out, Flat). The footer holds Loop
  sequence (1×, 2×, 3×).
- **Timeline**: a ruler, the Clips lane (filmstrips you drag to reorder and
  trim by their edges, a context menu, a `+` and a dashed slot that add
  videos from the library) and the Audio lane (the music's waveform and its
  volume line, taller while it is selected).

Edits stay inside the editor, with their own undo history (100 steps), until
**Done**. Done writes the node in one `updateNodeData` call and does not
encode; Stitch, or a workflow run, does that. **Cancel** or Escape with
changes asks first ("Discard changes?", which says what would be lost);
without changes it closes. If the canvas is replaced while the editor is
open (a load, a clear, a tab switch) or the node is deleted, the editor
closes and writes nothing.

**Reveal source node** saves like Done, then moves the canvas to the clip's
source node. It is off for library clips.

## How the timeline is stored

Three optional fields sit on `VideoStitchNodeData` (`src/types/nodes.ts`),
beside the fields the node always had:

```ts
timeline?: StitchTimelineClip[];   // the sequence, in order
audioCurve?: VolumePoint[];        // the music's volume over one loop; empty = flat at 0 dB
audioMuted?: boolean;              // the music is off; the clips' own sound still plays

interface StitchTimelineClip {
  id: string;                                   // stable within the node
  source: { kind: "edge"; edgeId: string } | { kind: "asset"; assetId: string };
  inSec: number;                                // trim start, in the source's seconds
  outSec: number | null;                        // trim end; null = the source's end
  muted: boolean;                               // the clip's own sound
  volume: number;                               // 0..1, linear, on the clip's own sound
}
interface VolumePoint { t: number; gain: number }   // t in sequence seconds, gain 0..1 (1 = 0 dB)
```

`clipOrder` (edge ids) is still written, equal to the timeline's edge ids in
order, for anything that reads it. `loopCount` is the node's existing field.
No media is stored: frames, posters, durations, waveforms and library
records live in module caches in the browser (`src/lib/stitch/mediaInfo.ts`,
`waveformCache.ts`, `assetInfo.ts`), never in node data or saved workflows.

**A node without `timeline` is "legacy"**: the editor's Done has never run
on it. That includes every workflow saved before the editor and every Stitch
node created since (`createDefaultNodeData` adds no `timeline`, so the
canvas, the connection menus, the agent and templates all make legacy nodes).
Such a node is read through `migrateStitchTimeline`: one clip per entry of
`clipOrder` that is still connected, then any connected edge `clipOrder` is
missing, each in 0, out at the end, volume 1. Reading never writes. Only Done gives a node a
`timeline`; the card's own reorders keep writing `{ clipOrder }` on a legacy
node, as before. A Done that changed nothing writes nothing, so the node
stays legacy.

**Clips are muted under music on a legacy node.** The stitch has always
replaced the clips' sound with the music when music was connected. To keep
that, the migration sets `muted: true` on every clip when music is
connected, and `muted: false` when it is not. The editor and the card's mute
badges show it. Two readings of "music is connected" exist:

- The card and the editor read it from the graph: a connection into `audio`
  that can deliver music (a generator counts before it has run; an Audio
  Input with a file, or with a source upstream that a run copies into it;
  disabled Switch outputs and dimmed sources do not).
  The badges therefore do not flip while the music's source runs.
- The executor reads it from output (`getConnectedInputs(...).audio[0]`),
  as the stitch always did. In a workflow run the music's source runs first,
  so the two agree. Stitch on its own (the card's button) before a music
  generator has produced anything, or with music that will not decode, has
  no music: a legacy node then plays its clips' own sound although the
  badges show them muted, and a node the editor wrote, whose clips are
  muted, comes out silent.

**Done freezes those flags.** Whatever the editor showed is written. A node
whose clips were muted under music stays silent if the music is later
disconnected, until the clips are unmuted. A video connected later to a
node the editor wrote is added to its timeline when the connection is made:
muted if music is connected then and the node's connected clips (library
clips aside) are all muted, so the mix stays the same; otherwise with its
sound. The flag is fixed from then on, whether or not the card was on
screen.

## Reconciliation

The node's sockets keep driving the sequence:

- A new `video-*` connection appends a clip for it at the end. On a node
  the editor wrote, the store writes that clip in the same update as the
  connection, on every path (connect, reconnect, the agent's edits), so one
  Undo takes both away; a legacy node gets it on read.
- A removed connection removes its clips (every piece of a split clip). The
  store does this in the same update as the removal, on every path (delete,
  reconnect, removing a node, the agent's edits), so one Undo brings back
  the connection with its clips and trims.
- Removing the last clip of a connection disconnects it: the card's ✕, and
  "Remove from stitch" in the editor (on Done). Removing one piece of a split
  clip removes only that piece. On Done, the disconnection and the data
  write are one canvas undo step.
- The card, the editor and the executor all read the node through
  `readStitchDraft` (`src/lib/stitch/draft.ts`): migrate if legacy, then
  match against the live connections. None of them relies on the card having
  run, so a node at low detail, pasted, or restored by Undo reads the same.
- Paste rewrites the timeline's edge ids to the pasted connections, so a
  copied Stitch keeps its trims.
- The editor works on a snapshot taken when it opens. On Done it matches the
  snapshot against the connections once more, so a video connected while it
  was open is added.

Clips that count 0 s keep their place in the order and are drawn as a fixed
slot that says why:

- a source that has not produced a video yet ("not generated yet");
- a source still loading, or one that cannot be read;
- a clip whose In is at or past its source's end, after the source was
  generated again shorter ("trim starts past the end"; Reset trim fixes it);
- a clip the same change leaves shorter than one output frame (1/60 s),
  which no frame can show ("trim is shorter than a frame"; Reset trim fixes
  it too);
- a library clip whose asset is gone ("not in the library").

The encode skips a clip with no video yet, one trimmed past its end or to
under a frame, and a file with no video track, so the editor and the output
agree. A library clip
whose asset is gone, or a file mediabunny cannot open, stops the run instead
(see Library clips and Limits).

Stitch needs at least two clips with a video ("Need at least 2 video clips to
stitch"); the two pieces of a split clip count as two. The check runs before
the files are read, so a clip trimmed past its end or a file with no video
track still counts, and the output can then hold a single clip.

A Router or Switch connection can carry several videos. A legacy node
stitches every video on it, in order, as it always did. Once the editor has
written a timeline, that connection's clip plays its first video only.

## How it is encoded

`stitchVideosAsync` (`src/hooks/useStitchVideos.ts`) takes one input per
clip (`{ blob, inSec, outSec, muted, volume }`), the music with its curve,
and the loop count. `gatherStitchInputs`
(`src/store/execution/stitchInputs.ts`) builds them from the node: connected
videos are fetched as before, library clips through
`/api/assets/<id>/file`. If a library clip's asset is gone, the run stops
with "Clip N's library video is no longer in the library".

**Video.** Only each clip's range is decoded. A clip's length is measured
the same way in the editor and the encoder: the end of the video track's
last frame (`videoTrackDuration` in `src/lib/stitch/sequencePlan.ts`, which
adds one frame interval when the last frame carries no duration). Both of a
clip's tracks start at the same origin: the In, or the video's first
timestamp if that is later. Frames are placed on a 60 fps grid at their own
times, so 24 fps clips come out at 24 frames a second, and each clip starts
exactly where the previous one ends. Size, bitrate, profile and rotation
follow the old rules: the largest coded size, the first clip's rotation, at
least 8 Mbps, H.264.

**Clip sound.** An unmuted clip's own sound plays under its picture at its
volume. It is cut at the clip's Out, and a clip without sound is silence.
Every clip's sound is converted into one master format: the music's rate
when the music plays alone, otherwise the highest rate that plays, at most
stereo (5.1 and quad are downmixed; centre kept, LFE dropped). Resampling is
linear. A clip whose sound fails to decode is silence in its own place.

**Music.** The music plays once, continuously across loops. The curve covers
one loop and shapes it again on each loop, sampled in 128-sample blocks and
ramped inside each block. The music is cut at the encoded length and padded
with silence when it is shorter. `audioMuted` drops it; the clips' sound
still plays.

**Loops.** `loopCount` repeats the sequence: the encoded length is the
sequence length times the loop count. The audio is AAC at 128 kbps (MP3 if
the browser has no AAC encoder), tried in the master format, then 48 kHz and
44.1 kHz stereo. All the audio is written before any video. When clip sound
and music play together the sum is hard-clipped to full scale; one source on
its own passes through as decoded.

### "Stitches as before"

A node the editor never wrote stitches the same clips in the order the card
shows (see Card reorders below), whole, at the same size and codecs, repeated `loopCount` times, with the
same sound rule: the clips' own sound without music, the music alone with
it. It is not bit-identical, by design:

- **Joins are exact.** Each clip's picture used to start 1/60 s after the
  previous clip's last frame, so the picture ran ahead of the sound by
  `t0 + 1/fps − 1/60` s per join. Now each clip starts where the previous one's
  length ends, so every later join comes `t0 + 1/fps − 1/60` s later than
  before, where t0 is the video track's first timestamp (usually 0): 25 ms
  per join at 24 fps, 17 ms at 30 fps, none at 60 fps. It stays with its
  sound. When the stitch's sound is at least as long as its video, the sound
  sets the file's length: about the same as before, or slightly shorter
  where a clip's sound or container ran past its video. A stitch with no
  sound, or with sound shorter than the video (music is now padded with
  silence, and so is clip sound that ends before its video), gets longer by
  that amount per join.
- A clip whose sound has a different rate or channel count from the first is
  converted into the mix. It used to be silent.
- A clip's sound is cut at its video's end instead of running to the end of
  its own sound track, and both tracks line up on the video's first
  timestamp.
- A clip whose sound ends before its video, or has gaps in it, is silent for
  those parts. Before, the clips' sound was laid end to end, so a short or
  gappy sound moved every later clip's sound earlier.
- Frames faster than 60 fps that land on the same slot are dropped instead of
  written twice.
- The music is always cut at the encoded length (it was not when a probe
  failed) and padded with silence when it is shorter.
- The audio codec is retried at 48 kHz and 44.1 kHz stereo, so music at a
  rate the encoder refuses (24 kHz, say) now has sound. The master is at most
  stereo.
- With clip sound playing, the master rate is the highest rate among the
  sources.
- An audio-only file in a video socket no longer adds its sound.
- A clip whose sound fails to decode is silent in its place, instead of
  moving every later clip's sound earlier.
- Each source is probed once.

**Card reorders now count.** Dragging clips into a new order on the card
always changed the filmstrip, but the stitch kept connection order. It now
follows the card, on legacy nodes too.

## The volume curve

The music's line is drawn on a square-root scale: a point's height is
`1 − √gain`, so 0 dB is the top, −∞ the bottom and −12 dB the middle guide.
Between two points the level moves in a straight line on that scale
(`gainAt` in `src/lib/stitch/curve.ts`), so what is drawn is what is heard.
An empty curve is flat at 0 dB. Before the first point the line holds the
first point's level, and after the last point the last one's.

Click the line to add a point; drag a point (up and down, and along);
double-click a point to remove it; ⌥-drag moves the whole line. Fade in and
Fade out set a 1 s ramp at either end (at most half the sequence), and Flat
clears the curve.

Points keep their times when trims make the sequence shorter. Points past
the new end are kept and not drawn, but they still shape the line up to the
end, so a fade out made before a trim no longer reaches silence at the new
end. Press Fade out again after shortening.

## Library clips

`+` in the Clips header, the dashed slot after the last clip, or the empty
lane opens **Add from library**: videos only, with search, a project menu,
Favourites, This workflow and a sort. The picked videos are added after the
last clip, in the order they were picked, as one undo step.

A library clip stores only the asset's id (`source: { kind: "asset" }`); a
saved clip whose id is not an asset id is dropped on read, so no URL is built
from it. Its file loads from `/api/assets/<id>/file` and its label from the
asset's record. The record is read again when the card mounts (a load, a
paste, a tab switch, or the node coming back on screen or out of low detail),
when the editor opens, and when a run finds the file gone; not while the card
stays on the canvas. So a deletion made in the Assets view shows on the card
once the editor opens or a run finds it gone. A record that says its file is
missing has the file read again too, so a length read before the file went
no longer counts. A clip whose asset is gone (or whose file is missing and
does not read) counts 0 s with "not in the library" on the card and in the
editor, and a run fails with the message above until it is removed. Library clips have no
socket, so they never disconnect anything. **This workflow** means assets
recorded under the current workflow's id only, not under an earlier copy of
it.

## Keys

None of these fire while a timecode field has focus. While a handle, clip or
point is being dragged, only Escape (cancels the drag) and K work.

| Key | Action |
|---|---|
| Space | Play or pause |
| I / O | Set the selected clip's In / Out at the playhead (the playhead must be inside it) |
| S | Split the clip under the playhead |
| ⌫ / Delete | Remove the selected clip, or the selected curve point |
| M | Mute or unmute the music track |
| ⌥M | Mute or unmute the selected clip's sound |
| ⌘Z / Ctrl+Z | Undo, in the editor only |
| ⇧⌘Z / Ctrl+Y | Redo |
| J / K / L | Back 1 s / pause / play |
| ← / → / Home / End | Move the selection along the clips (with a clip focused) |
| Context menu key / ⇧F10 | Open the clip menu |
| Escape | Close the menu or the picker; cancel a drag; on the discard sheet, Keep editing; otherwise Cancel |
| ⇧ while dragging an edge | No snapping |
| ⌥ while dragging the curve | Move the whole line |
| ⌘S | Saves the workflow, as everywhere |

Keys the canvas would act on (⌘Z, ⌘V, Shift+letters, ⌘↵ and so on) never
reach it while the editor is open.

**Snapping.** With Snap on, a dragged edge snaps within 8 px to the playhead
and to the neighbouring clip's edge where the drag began, which gives the
clip back its original length. Other clip edges move with the trim (the
clips after it close up or are pushed along) and are not targets.

## Limits

- **The preview is an approximation.** It switches between one `<video>` per
  source, so a join can freeze briefly; clip volume and the curve are applied
  to the elements once a frame; it plays one loop. A video served without
  CORS shows no filmstrip frames. The encode is the truth.
- **Mixed aspect ratios crop.** The encode keeps the old behaviour: the
  largest coded size, each clip scaled to cover it. The preview letterboxes.
- Clip sound is resampled linearly, and a mix of clip sound and music above
  full scale is hard-clipped.
- A file mediabunny cannot open is shown at the `<video>` element's
  duration (an unreadable slot if that is not finite either), but Stitch
  reads files with mediabunny and stops on it. A file mediabunny opens with
  no video track is an unreadable slot and is left out of the encode.
- Stitch needs at least two clips with a video. A clip trimmed past its end
  or a file with no video track still counts, so the output can hold a
  single clip.
- A Done made while a workflow runs cannot be undone on the canvas unless it
  also disconnects a clip's connection: the store takes no undo snapshot of
  node edits during a run, as for every other edit made then.
- The agent sees the node's `clipOrder`, not its timeline.
- Not built: ducking the music under clips with sound, roll edits,
  transitions, speed changes, titles, a second video or music track.
