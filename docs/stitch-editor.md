# Stitch editor

The Video Stitch node (`videoStitch`) joins the videos connected to its
`video-*` sockets into one clip, with the music on its `audio` socket under
them. The editor is where that sequence is finished: the clips' order, a
trim for each clip, each clip's own sound, the music's volume over time,
and the layout (Track, clips end to end, or Stacked, each clip overlapping
the one before). What the editor shows is what Stitch encodes.

## What the editor does

It opens from **Expand** in the node's floating header (beside Run and the
menu) or from **Open editor** on the card, beside Stitch. It is a
near-full-screen `Dialog`, 24 px from every edge of the window like the
annotation editor (so nothing in it sits in the desktop app's drag region),
with its own darker chrome (the `editor-*` tokens in `globals.css`):

- **Header**: "Stitch", then "N clips · length · W × H · F fps" (the frame
  rate only when the clips agree; in Stacked the length is less the
  overlaps); Track | Stacked, Undo, Redo, Cancel and Done.
- **Stage**: the sequence previewed at the playhead, letterboxed. In
  Stacked, where two clips overlap, it shows them blended (Crossfade on) or
  the earlier one (off).
- **Transport**: go to start, play, go to end, the timecode, Snap, Sound,
  the zoom slider and Fit.
- **Rail**: the selected clip's name and source, Trim (In, Out, Length),
  Audio (Clip audio, Volume), Split at playhead, Reset trim, Reveal source
  node, Remove from stitch; with the audio track selected, Track sound and
  the quick curve buttons (Fade in, Fade out, Flat). The footer holds Loop
  sequence (1×, 2×, 3×); in Stacked, a line saying what Overlap and
  Crossfade do, then Overlap and Crossfade, sit above it.
- **Timeline**: a ruler, the Clips lane (filmstrips you drag to reorder and
  trim by their edges, a context menu, a `+` and a dashed slot that add
  videos from the library) and the Audio lane (the music's waveform and its
  volume line, taller while it is selected). In Stacked the Clips lane is
  one row per clip; the rows scroll between a fixed ruler and a fixed audio
  row, and a clip or its row header is dragged up or down to reorder (see
  Stacked).

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

Four optional fields sit on `VideoStitchNodeData` (`src/types/nodes.ts`),
beside the fields the node always had:

```ts
timeline?: StitchTimelineClip[];   // the sequence, in order
audioCurve?: VolumePoint[];        // the music's volume over one loop; empty = flat at 0 dB
audioMuted?: boolean;              // the music is off; the clips' own sound still plays
sequenceLayout?: StitchSequenceLayout;   // Track or Stacked; absent = Track

interface StitchSequenceLayout {
  mode: "track" | "stacked";
  overlapSec: number;                           // Stacked: the most each join overlaps, 0..10 s in 0.1 s steps; kept in Track
  crossfade: boolean;                           // Stacked: dissolve and crossfade each overlap; off = the earlier clip stays in front
}
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

**`sequenceLayout` is read leniently** (`readSequenceLayout` in
`src/lib/stitch/draft.ts`). Absent, or not an object, it reads as Track
with a 1.0 s overlap and Crossfade on. The mode is Stacked only when it is
exactly `"stacked"`; the overlap is clamped to 0–10 s and rounded to 0.1 s
(1.0 s when it is not a number); Crossfade is on unless it is `false`. A
legacy node always reads as Track, whatever the field says. Only Done
writes the field, and only when the editor's layout differs from what the
stored value reads as: a trim does not add it to a node that has none, and
a stored value with keys this build does not know survives a Done that left
the layout alone. A build that does not know the field ignores it (its
stitch plays the clips end to end) and keeps it when it saves.

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

In Stacked such a clip has a row of its own, with its slot drawn where it
sits in time. It takes no time and does not separate its neighbours: the
clips before and after it overlap as if it were not there.

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

## Stacked

**Track | Stacked**, in the header before Undo, sets how the sequence is
laid out. Track, the default, is the single Clips row: each clip starts
where the one before it ends. Stacked works like After Effects' sequence
layers: each clip has its own row, still in order, and starts a set time
(Overlap) before the clip above it ends. It is a setting of the node, not a
view: a switch is one step in the editor's undo history, Done writes it,
and Stitch encodes it. Switching back to Track keeps Overlap and Crossfade
for the next switch; Track itself never overlaps. The switch is inert while
the editor has no clips, and any switch (Undo and Redo included) pauses the
preview. Cancel's discard sheet names what would be lost ("The switch to
Stacked and the overlap will be lost."). The switch changes the timeline's
height, and the timeline grows up from the bottom of the editor; the
header's right side keeps its width, so the toggle never moves: to switch
back, the other option is where it was.

In Stacked the rail's footer adds, above Loop sequence, a line saying what
Overlap and Crossfade do, then one row with the two of them. The row sits
on Loop sequence, so it stays put when the line grows or shrinks: the rail
above gives or takes the room. In a window too short for the whole line,
it shows the text lines that fit, and its full text on hover.

- **Overlap**: 0 to 10 s in 0.1 s steps, 1.0 s by default. ↑ and ↓ in the
  well change it by 0.1 s (⇧ by 1 s), as one undo step until the well is
  left; a value typed before the arrow is taken first, so the step starts
  from it. "1.5", "1,5", "2s" and "0:01.5" can be typed.
- **Crossfade**: on by default.
- The line above them says what they do to this sequence: "Each join blends
  over 1.0 s." (Crossfade on), "Each clip starts 1.0 s early, under the
  clip above. Both are heard." (off), or "Clips play end to end, as in
  Track." (no join overlaps). Then, when they apply: a join that gets less
  ("The join into Clip 3 is 0.70 s: an overlap is at most half a clip.",
  "… is a cut: …", or "2 joins are shorter: …"), "Pieces of the same video
  meet with a cut." and, with more than one loop, "The loop restarts with a
  cut."

**Each join's overlap** (`joinOverlaps` in `src/lib/stitch/stack.ts`, shared
by the editor, the card and the encoder). Overlap is the most a join gets.
Each join is cut down to half of the clip on either side, and to no more
than the piece of video that touches it, then rounded down to whole 1/60 s
frames; under one frame, the join is a cut. So no more than two clips ever
play at once, and the clips still end in the order they start.

- An empty clip (one that counts 0 s) is skipped: the clips on either side
  of it overlap as if it were not there.
- Two pieces of the same video side by side (a split, or the same library
  video twice in a row) meet with a cut. For the half-clip rule they count
  as one clip, so a split never changes an overlap or moves a clip.

**The lane.** Each row is 52 px, with the clip's box at its own start on
the ruler. The boxes are compact: the row header names the clip and its
source (with a muted speaker when the clip is muted), and the box shows
its length at the right. With Crossfade on, a wedge marks the head a clip
fades in on and the tail it fades out on; with it off, the head the clip
above hides is darkened ("Hidden under Clip N. Its sound plays."). Up to
three and a half rows show, so the timeline grows to 279 px tall for four
clips or more (351 px while the audio track is selected), taking the room
from the stage. More rows scroll up and down under the fixed ruler, above
the fixed audio row. While the preview plays, the row under the playhead is
kept in view, and so is a clip selected by a key, a split or an undo. A
wheel over the row headers scrolls the rows as one over the lanes does, and
a right press on a header opens its clip's menu. The `+` that adds from the
library moves to the corner beside the ruler.

**Moving and trimming.** Drag a clip's box, or its row header, up or down
to reorder. The lifted box is drawn at the start it will have in its new
place, with a line across the rows and the headers where it will land, and
the rows scroll when it nears their top or bottom. Clips do not move
sideways in time: a sideways drag says "Clips stay in order. Overlap sets
where each one starts." and moves nothing. A trim works as in Track (the
clips after it close up or are pushed along). While it is dragged, the
boxes are drawn as release will leave them, so when a clip gets short
enough for the half-clip rule to cut its overlaps, its own start and the
clips after it move during the drag. The frames the trim cuts are drawn
hatched beside the box, on the side they leave from: the head left of it
for an In trim, the tail right of it for an Out trim.

**Split.** S, the rail and the clip menu split the clip under the
playhead, as in Track, but not inside an overlap or within 0.1 s of one.
Inside an overlap the disabled Split's tooltip says "Move the playhead out
of the overlap to split". Outside an overlap a split moves nothing.

Switching layout or changing Overlap keeps the playhead on the same frame
of the same clip (the selected one if the playhead is inside it, else the
earlier one under it), and moves a fade out that ends at the end along with
the end (see The volume curve).

**Crossfade on.** Across each overlap the picture dissolves in a straight
line from the earlier clip to the later one, and their sounds crossfade at
equal power, which keeps two different shots at the same loudness. A muted
or silent clip still fades the other one.

**Crossfade off.** The earlier clip (the row above) stays in front until
its Out, as the upper layer does in After Effects. The later clip starts
under it: its first Overlap seconds are not seen, but its sound already
plays. Both clips are heard through the overlap at their own volumes,
added together.

**Loops.** One loop is the clips' lengths less the overlaps. Each restart
of the loop is a cut, in picture and sound: the last clip has nothing to
fade into.

**The preview.** In Stacked the stage has one `<video>` per clip, later
clips over earlier ones. In an overlap both play: with Crossfade on the
later clip is drawn over the earlier one at the dissolve's opacity, with it
off it is hidden; their volumes follow the crossfade.

**On the card.** The summary's length is the stacked length. When some
join really overlaps, an item between it and the loop says "1.0 s
crossfade" or "1.0 s overlap" (the Overlap setting; a join can get less).
When every join comes out a cut there is none, since the output is
Track's. The card has no layout control, and its own edits (a reorder, ✕)
keep the layout.

## How it is encoded

`stitchVideosAsync` (`src/hooks/useStitchVideos.ts`) takes one input per
clip (`{ blob, inSec, outSec, muted, volume }`, and on a node the editor
wrote the clip's `source` key, so pieces of one video are known), the music
with its curve, and the options: `{ loopCount }`, plus `overlapSec` and
`crossfade` when the node is Stacked with an overlap above 0. A Track node
passes `{ loopCount }` alone, as before. `gatherStitchInputs`
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
exactly where the previous one ends (in Stacked, its overlap before that).
Size, bitrate, profile and rotation follow the old rules: the largest coded
size, the first clip's rotation, at least 8 Mbps, H.264.

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

**Stacked.** A clip's frames outside its overlaps pass straight through,
as in Track. With Crossfade off that is every frame from where the clip
before it ends to its own Out, and nothing is blended. With Crossfade on,
the frames of each overlap are new (`src/lib/stitch/crossfadeFrames.ts`):
each blends the two clips' frames at that point of the dissolve. Each
side shows the frame its own pass-through would show on that output frame,
so no frame is skipped or shown twice where a dissolve meets a clip's own
frames, whatever the trims. When both
frames have the same 8-bit pixel format and the size of the first frame
encoded, they are blended byte by byte in their own planes, so the blend
keeps the colour of the frames on either side. Otherwise (different sizes
or formats, or 10-bit video) they are drawn on a canvas at that size, each
scaled to cover it, with no rotation. The blended frames come at the
earlier clip's own frame times when the two clips report the same frame
rate (within 1 %, from 10 to 60 fps), so a 24 fps sequence stays 24 fps
through its dissolves; otherwise one comes every 1/60 s. Below 10 fps (a
slideshow, a one-frame still) too few frames fall inside an overlap to
blend, so those dissolves also use every 1/60 s. The rate is measured from
the gaps between frames, so a WebM whose last frame was stored without a
duration reads as its real rate. Each clip's sound
starts at the clip's own start, a hidden head included. With Crossfade on
it fades in over its overlap with the clip before and out over its overlap
with the clip after, at equal power and sample for sample with the picture;
with it off it plays in full. A stack whose joins all come out as cuts is
encoded exactly as Track.

**Loops.** `loopCount` repeats the sequence: the encoded length is the
sequence length times the loop count. In Stacked one loop is the clips'
lengths less the overlaps, and each restart is a cut. The audio is AAC at
128 kbps (MP3 if the browser has no AAC encoder), tried in the master
format, then 48 kHz and 44.1 kHz stereo. All the audio is written before
any video. When clip sound and music play together, or two clips' sound
overlaps in Stacked, the sum is hard-clipped to full scale; one source on
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

**Stacked changes none of this.** A node in Track, a stacked node whose
joins all come out as cuts, and a node the editor never wrote encode
exactly as they did before Stacked was added.

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

Switching between Track and Stacked, or changing Overlap, changes the
length without a trim, so a fade out that ends at the end follows it
(`followEndFade`): when the curve's last point is silent and within one
1/60 s frame of the old end, it and the point before it move by the change
in length, in the same undo step. Switching back moves them back, so the
curve returns as it was. Other points keep their times, and a move that
would take the point before the last below 0 or past the point ahead of it
leaves the curve as it is.

## Library clips

`+` in the Clips header (in Stacked, in the corner beside the ruler), the
dashed slot after the last clip, or the empty lane opens **Add from
library**: videos only, with search, a project menu, Favourites, This
workflow and a sort. The picked videos are added after the last clip, in
the order they were picked, as one undo step. The playhead goes to the
first added clip's start. In Stacked each added clip gets a row of its own
and overlaps the clip before it like any other; until the editor has read a
new file, the playhead is placed with the length in the library's record.
The picker's footer still says what the videos go after and their own total
length, which in Stacked is more than the sequence grows by.

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

None of these fire while a timecode field has focus, apart from the Overlap
well's own ↑ and ↓. While a handle, clip or
point is being dragged, only Escape (cancels the drag) and K work.

| Key | Action |
|---|---|
| Space | Play or pause |
| I / O | Set the selected clip's In / Out at the playhead (the playhead must be inside it) |
| S | Split the clip under the playhead (in Stacked, not inside an overlap) |
| ⌫ / Delete | Remove the selected clip, or the selected curve point |
| M | Mute or unmute the music track |
| ⌥M | Mute or unmute the selected clip's sound |
| ⌘Z / Ctrl+Z | Undo, in the editor only |
| ⇧⌘Z / Ctrl+Y | Redo |
| J / K / L | Back 1 s / pause / play |
| ← / → / Home / End | Move the selection along the clips (with a clip focused; in Stacked ↑ / ↓ too) |
| ↑ / ↓ in the Overlap well | 0.1 s more or less (⇧: 1 s), one undo step until the well is left |
| Context menu key / ⇧F10 | Open the clip menu |
| Escape | Close the menu or the picker; cancel a drag; on the discard sheet, Keep editing; otherwise Cancel |
| ⇧ while dragging an edge | No snapping |
| ⌥ while dragging the curve | Move the whole line |
| ⇧ + wheel | Scroll along the timeline (in Stacked with more rows than fit, where a plain wheel scrolls the rows) |
| ⌘S | Saves the workflow, as everywhere |

Keys the canvas would act on (⌘Z, ⌘V, Shift+letters, ⌘↵ and so on) never
reach it while the editor is open.

**Snapping.** With Snap on, a dragged edge snaps within 8 px to the playhead
and to the neighbouring clip's edge where the drag began, which gives the
clip back its original length. Other clip edges move with the trim (the
clips after it close up or are pushed along) and are not targets. In
Stacked, where clips overlap rather than meet, the second target is the
dragged edge's own position where the drag began ("Snapped to the original
length"). There an edge snaps only where the box, drawn as release leaves
it, meets the target. An Out edge whose drawn end would miss the playhead
(the half-clip rule moved the clip's start) is not snapped and follows the
pointer. An In edge snaps only to the original length, never to the
playhead: an In trim keeps the clip's start, which is set by the clip
before it, so its box's left edge stays where it is and cannot meet the
playhead.

## Limits

- **The preview is an approximation.** It switches between one `<video>` per
  source, so a join can freeze briefly; clip volume and the curve are applied
  to the elements once a frame; it plays one loop. A video served without
  CORS shows no filmstrip frames. The encode is the truth.
- In Stacked the preview has one `<video>` per clip, so every clip loads. In
  an overlap two play at once and can drift apart by up to 0.15 s before
  they are seeked back together.
- **Mixed aspect ratios crop.** The encode keeps the old behaviour: the
  largest coded size, each clip scaled to cover it. The preview letterboxes.
- Clip sound is resampled linearly, and a mix of clip sound and music above
  full scale is hard-clipped. So is clip sound in a stacked overlap, which
  adds up: with Crossfade off both clips play at their own volumes, and two
  loud ones can clip for the whole overlap; with it on, two very similar
  sounds can peak 3 dB louder in the middle.
- A stacked dissolve decodes the earlier clip a second time, from its last
  key frame before the overlap. Many generated clips have a single key
  frame, so that is often the whole clip, once per join and loop. Two
  decoders run during a dissolve, and for a moment after it a third.
- Blended frames drawn on the canvas (clips of different sizes or formats,
  or 10-bit video) can differ slightly in colour from the frames on either
  side, and HDR is tone-mapped there.
- In Stacked the timeline grows to 279 px for four or more clips, taking
  room from the stage; on a window about 900 px tall the rail then scrolls
  a little.
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
- The agent sees the node's `clipOrder` and loop count, not its timeline or
  its layout; its edits keep the layout.
- Not built: ducking the music under clips with sound, roll edits,
  transitions other than the crossfade at a stacked overlap, a crossfade at
  the loop's restart, an overlap set per join, dragging a clip sideways in
  time, speed changes, titles, a second video or music track (Stacked's
  rows are still one sequence and one output track).
