# Edit video

The Edit Video node (`videoStitch`, called Video Stitch before) joins the videos connected to its
`video-*` sockets into one clip, with sound under them: the music on its
`audio` socket and audio from the library, each a clip on an audio row.
The editor is where that sequence is finished: the clips' order, a trim
for each clip, each clip's own sound, the audio clips and their volume
over time, and the layout (Track, clips end to end, or Stacked, one row per clip,
placed anywhere). What the editor shows is what Render encodes.

## What the editor does

It opens from **Expand** in the node's floating header (beside Run and the
menu) or from **Open editor** on the card, beside Render. It is a
near-full-screen `Dialog`, 24 px from every edge of the window like the
annotation editor (so nothing in it sits in the desktop app's drag region),
with its own darker chrome (the `editor-*` tokens in `globals.css`):

- **Header**: "Edit video", then "N clips · length · W × H · F fps" (the frame
  rate only when the clips agree; in Stacked the length runs to the end of
  the clip that ends last); Undo, Redo, Cancel, Save and Done.
- **Stage**: the sequence previewed at the playhead, letterboxed. In
  Stacked it blends or covers clips where they overlap, by row, and shows
  black in a gap. While you drag a clip, the preview keeps showing the
  clips where they were; it updates when you let go.
- **Transport**: go to start, play, go to end, the timecode, Snap, Sound,
  Crossfade (in Stacked), the zoom slider, Fit and Track | Stacked.
- **Rail**: the selected clip's name and source, in Stacked its Start (where
  it starts on the timeline), Trim (In, Out, Length),
  Audio (Clip audio, Volume), Split at playhead, Reset trim, Reveal source
  node, Remove clip; with an audio clip selected, its Start, Trim,
  Sound and the curve's quick buttons (Fade in, Fade out, Flat). With several clips
  selected the rail shows how many, and what applies to all of them: Clip
  audio (On or Off, with neither pressed while some are muted and some
  not), Split at playhead, Reset trim and Remove. At the foot of the
  rail, whatever is selected, sits **Frame to canvas** (see "Frame to
  canvas"); under it the footer holds Loop sequence (1×, 2×, 3×).
- **Timeline**: a ruler, the Clips lane (filmstrips you drag to reorder and
  trim by their edges, a context menu, a `+` and a dashed slot that add
  videos from the library) and the audio rows (each audio clip's waveform
  and volume curve; a row's volume-curve button makes it taller to edit the
  curve) and, under them, **+ Add audio**. In Stacked the Clips lane is one
  row per clip; the rows scroll between a fixed ruler and the audio rows.
  The timeline's height does not change with the layout or the selection
  (see Audio clips). A clip's box drags in time and up or down to another row in one
  move; its row header drags it up or down only (see Stacked). Click,
  ⌘-click, ⇧-click or drag a box around clips to select several (see
  Several clips).

Edits stay inside the editor, with their own undo history (100 steps), until
**Done**. Done writes the node in one `updateNodeData` call and does not
encode; Render, or a workflow run, does that. **Save** (⌘S) writes the
node the same way and saves the workflow, but keeps the editor open: what
it wrote becomes the editor's starting point, so Cancel then asks only
about edits made since, and the undo history stays. Save is off while
there is nothing new to write. Every save of the workflow while the editor
is open (⌘S, File › Save) takes the open edit with it; a workflow never
saved asks for its name and folder first, above the editor. **Cancel** or
Escape with changes asks first ("Discard changes?", which says what would
be lost); without changes it closes. If the canvas is replaced while the editor is
open (a load, a clear, a tab switch) or the node is deleted, the editor
closes and writes nothing.

**Reveal source node** saves like Done, then moves the canvas to the clip's
source node. It is off for library clips.

## How the timeline is stored

Four optional fields sit on `VideoStitchNodeData` (`src/types/nodes.ts`),
beside the fields the node always had:

```ts
timeline?: StitchTimelineClip[];   // the sequence, in order
audioCurve?: VolumePoint[];        // the music's volume over one loop; empty = flat at 0 dB; read only while audioClips is absent
audioMuted?: boolean;              // the music is off; the clips' own sound still plays; read only while audioClips is absent
sequenceLayout?: StitchSequenceLayout;   // Track or Stacked; absent = Track
audioClips?: StitchAudioClip[];   // the audio clips; absent = the music alone, read from audioCurve and audioMuted

interface StitchSequenceLayout {
  mode: "track" | "stacked";
  overlapSec: number;                           // Stacked: the overlap when lined up, 0..10 s in 0.1 s steps; also where new clips go; kept in Track
  crossfade: boolean;                           // Stacked: the higher row fades over the rows below; off = it covers them, every clip heard
}
interface StitchTimelineClip {
  id: string;                                   // stable within the node
  source: { kind: "edge"; edgeId: string } | { kind: "asset"; assetId: string };
  inSec: number;                                // trim start, in the source's seconds
  outSec: number | null;                        // trim end; null = the source's end
  muted: boolean;                               // the clip's own sound
  volume: number;                               // 0..1, linear, on the clip's own sound
  startSec?: number;                            // Stacked: where the trimmed clip starts, 0..600 s; absent = laid out from Overlap
}
interface StitchAudioClip {
  id: string;
  source: { kind: "music" } | { kind: "asset"; assetId: string };   // the node's audio socket, or a library file
  row: number;                    // audio row, from 0; stored with no empty rows
  startSec: number;               // where its In plays on the timeline, 0..600 s
  inSec: number;                  // trim start, in the file's seconds
  outSec: number | null;          // trim end; null = the file's end
  muted: boolean;
  curve: VolumePoint[];           // t in the file's seconds, gain 0..1
}
interface VolumePoint { t: number; gain: number }   // t: sequence seconds for audioCurve, the clip's source seconds on an audio clip; gain 0..1 (1 = 0 dB)
```

`clipOrder` (edge ids) is still written, equal to the timeline's edge ids in
order, for anything that reads it. `loopCount` is the node's existing field.
No media is stored: frames, posters, durations, waveforms and library
records live in module caches in the browser (`src/lib/stitch/mediaInfo.ts`,
`waveformCache.ts`, `assetInfo.ts`), never in node data or saved workflows.

**A node without `audioClips` keeps the old audio.** Its audio is the
connected music alone, starting at 0:00, read from `audioCurve` and
`audioMuted`. The editor shows it as one clip on the first audio row. Done
writes `audioClips` only when the audio is something else: the music
moved, trimmed or split, a library clip, a second row. When an edit brings
it back to that one untouched music clip, Done removes `audioClips` and
writes the curve and mute to `audioCurve` and `audioMuted` again. Whenever
`audioClips` is written, `audioCurve` and `audioMuted` are written too, for
builds from before audio clips, which ignore `audioClips`: they hold the
curve and mute of an untouched music clip (whole, at 0:00), or say "muted"
when the music was moved, trimmed, split or removed. On a node with
`audioClips` they are never read. An older build plays no library audio.

**A node without `timeline` is "legacy"**: the editor's Done has never run
on it. That includes every workflow saved before the editor and every Edit Video
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
render plays the clips end to end) and keeps it when it saves.

**`startSec` places a clip in Stacked.** It is where the trimmed clip
starts on the timeline, in sequence seconds. A clip without it is laid out
from Overlap (see Stacked). Track ignores it and keeps it, so a switch to
Track and back finds every clip where it was. Edits in Track never change
it: an In trim made there shifts the clip's frames under its Stacked start,
and a split made there gives the right piece the start where its frames
already were. It is read like the other fields (`sanitizeTimeline`): kept
when it is a finite number, clamped to 0–600 s (10 minutes, which bounds
the encoder's audio buffers) and not rounded; anything else is dropped.
Done writes it with the rest of the timeline, in the same single
`updateNodeData`. It travels with its clip: the card's reorder and ✕,
paste and the agent's edits keep it. A build from before clips could be
placed drops it on its next card write.

**Clips are muted under music on a legacy node.** The node has always
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
  as the node always did. In a workflow run the music's source runs first,
  so the two agree. Render on its own (the card's button) before a music
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
  "Remove clip" in the editor (on Done). Removing one piece of a split
  clip removes only that piece. On Done, the disconnection and the data
  write are one canvas undo step.
- The card, the editor and the executor all read the node through
  `readStitchDraft` (`src/lib/stitch/draft.ts`): migrate if legacy, then
  match against the live connections. None of them relies on the card having
  run, so a node at low detail, pasted, or restored by Undo reads the same.
- Paste rewrites the timeline's edge ids to the pasted connections, so a
  copied Edit Video node keeps its trims.
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
sits in time, and the slot drags like a box. In a lined-up stack the clips
before and after it overlap as if it were not there. In a placed stack its
slot sits at its own start and it takes no time: a slot placed past the
end does not make the sequence longer.

The encode skips a clip with no video yet, one trimmed past its end or to
under a frame, and a file with no video track, so the editor and the output
agree. A library clip
whose asset is gone, or a file mediabunny cannot open, stops the run instead
(see Library clips and Limits).

The node's Render needs at least two clips with a video ("Need at least 2 video clips to
render"); an edit in the Edit video view renders from one; the two pieces of a split clip count as two. The check runs before
the files are read, so a clip trimmed past its end or a file with no video
track still counts, and the output can then hold a single clip.

A Router or Switch connection can carry several videos. A legacy node
renders every video on it, in order, as it always did. Once the editor has
written a timeline, that connection's clip plays its first video only.

## Stacked

**Track | Stacked**, at the transport's right end after Fit, sets how the
sequence is laid out. Track, the default, is the single Clips row: each
clip starts where the one before it ends. Stacked gives each clip its own
row, like a layer in After Effects, and a clip can start at any time. It is
a setting of the node, not a view: a switch is one step in the editor's
undo history, Done writes it, and Render encodes it. Switching back to
Track keeps Overlap, Crossfade and every clip's place for the next switch;
Track itself never overlaps. The switch is inert while the editor has no
clips, and any switch (Undo and Redo included) pauses the preview. Cancel's
discard sheet names what would be lost ("The switch to Stacked and the
overlap will be lost.", "A trim and a moved clip will be lost.", or "lining
up the clips" after Line up). The switch changes the timeline's height, and
the timeline grows up from the bottom of the editor, so with three or more
clips the transport, and the toggle in it, moves up or down when the layout
switches.

**Lined up and placed.** A Stacked node starts **lined up**: no clip has a
start of its own, and each starts a set time (Overlap) before the clip
above it ends, like After Effects' sequence layers (see Each join's
overlap). Once a clip is placed by hand the node is **placed**. The edit
that places it first writes every clip's current start (`startSec`), in
the same undo step, so the clips it does not edit stay where they are. From
then on an edit moves only the clip it edits.

- Always placing, in Stacked: dragging a clip's box (in time, to another
  row, or both), a nudge, a typed Start, [ and ], every trim (a drag,
  I, O, a typed In or Out, Reset trim), a paste, a duplicate, and a drag
  or nudge of several clips.
- Placing only in a stack that is already placed: a row move by the row
  header, ⌥↑ / ⌥↓ or the clip menu, a split, a removal and a cut. In a
  lined-up stack these work as before: a row move or a removal
  re-sequences the clips, and a split is refused inside an overlap.
- Never placing: adding from the library, Crossfade, the layout switch,
  loops, clip sound and the curve. Edits in Track, and the card's reorder
  and ✕, keep every stored start.

**Line up**, in the corner left of `+`, puts every clip back where Overlap
lays it out, as one undo step: it drops every stored start, moves a fade
out that ends at the end along with the end, and keeps the playhead on the
same frame of the same clip. It is on once some clip has been placed, with
the title "Line up: each clip starts 1.0 s before the one above ends" (at
Overlap 0, "Line up: each clip starts where the one above ends"). While the
clips are lined up it is off ("The clips are lined up").

**A clip without a start** in a placed stack (one added from the library,
or by a new connection) starts Overlap before the latest end among the
rows above it, with the same limits as Line up (see Each join's overlap),
so several new clips chain. It has no start of its own until the next edit
that places, which writes the one it shows.

In Stacked the transport shows **Crossfade** beside Sound, on by default.

**Overlap** is 1.0 s by default and has no control in the editor. It sets
how far each clip overlaps the one above in a lined-up stack, where a new
clip goes in a placed one, how Line up spaces the clips, and the overlap
snap target. A node keeps the Overlap it was saved with.

**Each join's overlap** (`joinOverlaps` in `src/lib/stitch/stack.ts`, shared
by the editor, the card and the encoder) lays out a lined-up stack.
Overlap is the most a join gets. Each join is cut down to half of the clip
on either side, and to no more than the piece of video that touches it,
then rounded down to whole 1/60 s frames; under one frame, the join is a
cut. So in a lined-up stack no more than two clips ever play at once, and
the clips still end in the order they start.

- An empty clip (one that counts 0 s) is skipped: the clips on either side
  of it overlap as if it were not there.
- Two pieces of the same video side by side (a split, or the same library
  video twice in a row) meet with a cut. For the half-clip rule they count
  as one clip, so a split never changes an overlap or moves a clip.

**The lane.** Each row is 52 px, with the clip's box at its own start on the
ruler. The boxes are compact: the row header names the clip and its source
(with a muted speaker when the clip is muted), and the box shows its length
at the right. A box's accessible name says where it starts ("Clip 3, starts
0:07.20"), and so does an empty clip's slot. A box narrower than 96 px has
no hover mute button, and its muted badge is only a mark, so a press on it
still drags the box (⌥M and the clip menu unmute). In a lined-up stack, with
Crossfade on, a wedge marks the head a clip fades in on and the tail it
fades out on; with it off, the head the clip above hides is darkened
("Hidden under Clip N. Its sound plays."). A placed stack marks each clip's
share of the picture over its own span: nothing where it is the whole
picture, a wedge where it fades in or out, a darkened area above a line
where several fades meet, and a dark band wherever a higher row hides it
("Hidden under Clip 3.", or with Crossfade off "Hidden under Clip 3. Its
sound plays."). A gap of a frame or more is a black band across the rows
with dashed sides, labelled "Gap 1.0 s" when the band is wide enough for the label (64 px
for "Gap 1.0 s", 7 px more for each further character), and
a 3 px black strip along the bottom of the ruler, which stays in view while
the rows scroll. Up to three and a half rows show, so the timeline grows to
303 px tall for four clips or more, in Track as well, so that switching
layouts moves nothing (see "The timeline's height" in Audio clips), taking
the room from the stage. More rows scroll up and down under the fixed
ruler, above the audio rows. While the preview plays,
the row under the playhead is kept in view, and so is a clip selected by a
key, a split or an undo. A wheel over the row headers scrolls the rows as
one over the lanes does, and a right press on a header opens its clip's
menu. The `+` that adds from the library moves to the corner beside the
ruler, with Line up left of it, and the dashed slot that adds sits in the
last row, after the latest end.

**Moving a clip.** Drag a clip's box, or an empty clip's slot, anywhere:
sideways moves it in time, up or down moves it to another row, and one
drag can do both. A press that travels 4 px or less only selects the
clip, and playback goes on. Past that the clip lifts, the preview pauses,
and the box follows the pointer on both axes. It lands in the row under its
centre, which changes only once the centre is more than half a row and 4 px
from the middle of the row it lands in now: at 52 px a row, a sideways drag
keeps its row until it strays more than 30 px up or down. A line across the
rows and the headers marks the row it will land in; the box floats with the
pointer, and the rows between move by one when you let go. A chip beside
the box says where the clip will play and how far it moved
("0:14.20–0:17.40 · +3.20 s"). Near their sides the lanes scroll by
themselves, and near their top or bottom the rows do, once the pointer has
moved toward that edge since the press: a box pressed near an edge and
dragged along the other axis scrolls nothing. Release writes the
new start and the new row together, as one undo step; Escape puts the clip
and the scroll back. A box drag always places: in a lined-up stack too,
the box lands where it was drawn and every other clip keeps its start.
While it runs, every box is marked as release will leave it (which clip
covers which, the fades and the gaps), and a hidden band names the
covering clip as the row headers do until release. The stage keeps showing
the clips where they were until you let go, and a ⌘ wheel does not zoom
while a clip is pressed or dragged. The start snaps (see Snapping).

**Moving a row.** The row header drags its clip up or down only. In a
lined-up stack the clips re-sequence as before: the lifted box is drawn at
the start it will have in its new place. In a placed stack
every clip keeps its start, the lifted box keeps its place in time, and
the boxes are marked with the layering the new order will give. ⌥↑ / ⌥↓
and the clip menu's Move up a row and Move down a row move the selected
clip one row the same way.

**Placing by key and by number.** ⌥← / ⌥→ moves the selected clip one
output frame (1/60 s) earlier or later, and with ⇧ ten frames; a held
key's repeats are one undo step. [ starts the selected clip at the
playhead, and ] ends it there (off when the clip is longer than the time
before the playhead). The clip menu has them too, as Start at playhead and
End at playhead. The rail's **Start**, above Trim, is where the selected
clip starts on the timeline (In and Out are times in the source). Type a
time and press Enter or leave the well, or step it with ↑ and ↓ (0.1 s, ⇧
1 s), as one undo step until the well is left. A clip starts between 0:00
and 10:00 (600 s); nothing starts before 0:00. A start typed or keyed that
takes the selected clip wholly out of view scrolls the lanes so that its
box sits 64 px inside their left side. A move made in the timeline never
does: not a drag's release (a box's body, a row header or a trim handle:
the box lands where it was drawn), and not a
typed Start that a press in the timeline commits (the lanes stay under the
pointer). In Stacked the rail's key hints add
[, ] and ⌥ ("With ← → nudge a frame, with ↑ ↓ change row"), and ⇧ reads
"Hold to move or trim without snapping".

Moves keep the zoom. In Fit, a move that makes the sequence longer or
shorter, or moves an empty clip's slot (Fit leaves room for it), keeps the
lane's px/s, so the clip lands where it was drawn; press Fit to fit the new
length. Trims still re-fit. A box dragged earlier that makes the sequence
shorter leaves the lanes as wide as they were drawn until they are scrolled
back, so lanes scrolled to their end do not jump on release.

**Trimming.** In Stacked a trim keeps the clip's frames where they are in
time. An In change moves the clip's start by the same amount, and an Out
change keeps the start. Nothing else moves. A clip never starts before
0:00: an In that would reach further back stops there. I sets the In at
the playhead, so the clip then starts at the playhead. Reset trim moves the
start back by the old In, to 0:00 at most (then its frames move later).
While an edge is dragged, the boxes and their marks are drawn as release
will leave them. The frames the trim cuts are drawn hatched beside the
box, on the side they leave from: the head left of it for an In trim, the
tail right of it for an Out trim.

**Split.** S, the rail and the clip menu split the clip under the
playhead, as in Track. In a lined-up stack they do not split inside an
overlap or within 0.1 s of one: there the disabled Split's tooltip says
"Move the playhead out of the overlap to split". Outside an overlap a
split moves nothing. In a placed stack, with Crossfade on or off, a split
places the clips, then cuts the selected clip if the playhead is inside
it, else the clip in front at the playhead (the top row). It is refused
only in a gap and within 0.1 s of that clip's ends. The right piece starts
at the playhead, in the row just under the left piece. The two pieces
count as one clip (see Pieces of one video), so a split changes nothing in
the picture or the sound, inside an overlap too.

Switching layout, changing Overlap and Line up keep the playhead on the
same frame of the same clip (the selected one if the playhead is inside
it, else the clip in front under it; in a gap the playhead stays where it
is), and move a fade out that ends at the end along with the end (see The
volume curve).

**Rows are layers.** The higher row is in front, with Crossfade on and
off. Moving a clip to another row changes the picture. Rows are also
Track's order. In a lined-up stack the higher row is always the earlier
clip, so the rules below give the same picture and sound as before clips
could be placed.

**Crossfade on.** Where clips overlap, the higher row's clip fades in
across the overlap at its start when it starts over clips on lower rows,
and fades out across the overlap at its end when they play on after it.
The picture dissolves in a straight line. A fade lasts at most as long as
the picture below has played when the clip starts (a fade in), or plays on
after it ends (a fade out). This keeps the picture from jumping when one
clip's edge passes another's, except when two pieces of a split clip are
moved apart or lower clips come within a frame of each other, where a fade
can change at once. It also means that where an overlap is longer than
half the clip below, the dissolve is shorter than the overlap. A clip that
lies inside the picture below fades in and out; when the two fades
together are longer than the clip, both are shortened in proportion, so a
5 s clip over a 60 s one fades in over 2.5 s and out over 2.5 s and shows
alone only at its middle. A clip wholly under a longer clip on a higher row
is hidden. The clips on lower rows count together as the picture below: a
clip over two lower clips with a gap between them fades in over the first,
shows alone over the gap, and fades out over the second. In a lined-up
stack this is the dissolve each join always had: the earlier clip, in the
higher row, fades out over the later one across their overlap.

The sound follows the picture at equal power, which keeps two different
shots at the same loudness: a clip is heard as much as it is seen. So a
hidden clip is silent, even when the clip that covers it is muted or has
no sound, and a muted insert over a long clip dips that clip's sound: a
muted 5 s clip over a 60 s interview silences the interview at the
insert's middle. A muted or silent clip still fades the other one.

**Crossfade off.** The top row that plays covers the rows below, as the
upper layer does in After Effects: a higher clip stays in front until its
Out, and a clip under it is not seen there, though its sound plays. Every
clip that plays is heard at its own volume, added together. In a lined-up
stack the higher row is the earlier clip: the later clip starts under it,
and its first Overlap seconds are not seen.

**Pieces of one video.** Pieces of one video whose frames continue count
as one clip, so a split never changes the picture: the same video, in the
next row down (empty clips between are skipped), starting within half a
frame (1/120 s) of where the piece before it ends, with the frames that
follow on. Moved further apart (one ⌥→ is a whole frame), they count as
two clips, and the fades around them can change at once.

**Under a frame.** A fade or an overlap shorter than one output frame
(1/60 s) is a cut, in picture and sound. A gap that short writes no black
frame: the frame before it holds, except at the very start of the first
loop, where nothing comes before it. The lane does not draw such a gap,
the card does not count it, and the preview holds the frame across it too.
Under a clip in front, such a gap between two
lower clips is bridged: the clip before the gap holds its last frame and
its share of the picture across it, so the clip in front neither flashes
nor changes its fade. That clip's sound has ended, so its share of the
sound is silent for that moment.

Some layouts, top row first, in seconds on the timeline. With Crossfade
off every clip that plays is heard.

| Clips | Crossfade on | Crossfade off |
|---|---|---|
| A 0–5, B 6–11 | A, black from 5 to 6 with the music on, then B | The same |
| A 0–5, B 4–9 | A fades out over B from 4 to 5; the sounds crossfade | A until 5, then B |
| A 0–5, B 1–6 | B plays on only 1 s after A ends, so A covers B from 1 to 4 and fades out from 4 to 5 | A until 5, then B |
| B 3–5 over A 0–10 | B fades in from 3 to 4 and out from 4 to 5 | B covers A from 3 to 5 |
| A 0–10 over B 3–5 | B is hidden and silent | B is hidden |
| B 0–3 over A 0–10 | B starts at full (nothing below has played yet) and fades out from 0 to 3 | B, then A |
| B 2–7 over A 0–5 | B fades in from 2 to 4 (A has played only 2 s) and covers A from 4 to 5, where A is silent | B covers A from 2 |
| A 0–5 over B 2–7 | A covers B from 2 to 3, where B is silent, and fades out from 3 to 5 (B plays on 2 s) | A until 5, then B |
| A 0–6, B 2–8, C 4–10 | A fades out from 2 to 6 and B from 6 to 8; C is hidden from 4 to 6; at 5, A is 25 % of the picture and B 75 % | A, then B from 6, then C from 8 |
| C 4–8, B 2–6, A 0–10 | B fades in from 2 to 3.33 and out until 6; C fades in from 4 to 6.67 and out until 8; at 5, C is 37.5 %, B 23.4 % and A 39.1 % | A, then B from 2, C from 4, and A again from 8 |

**Loops.** One loop runs from 0:00 to the end of the clip that ends last;
in a lined-up stack that is the clips' lengths less the overlaps. Each
restart of the loop is a cut, in picture and sound: the last clip has
nothing to fade into. A gap at the start plays at the start of every loop.

**The preview.** In Stacked the stage has one `<video>` per clip. In a
lined-up stack's overlap both play: with Crossfade on the later clip is
drawn over the earlier one at the dissolve's opacity, with it off it is
hidden; their volumes follow the crossfade. A placed stack shows each clip
at the opacity that gives it its share of the picture and its sound at its
share of the sound, and the stage is black in a gap while the music plays
on. A hidden clip keeps playing unseen, so it is in step when it shows. The
clip that started first among those playing keeps the time; at its Out the
next one does, and across a gap the playhead runs on the frame clock.

**On the card.** The summary's length runs to the end of the clip that
ends last. In a lined-up stack, when some join really overlaps, an item
between it and the loop says "1.0 s crossfade" or "1.0 s overlap" (the
Overlap setting; a join can get less). When every join comes out a cut
there is none, since the output is Track's. A placed stack counts instead:
"1 crossfade" (Crossfade on: each fade in and each fade out of at least a
frame) or "2 overlaps" (off: each pair of clips that overlap by at least a
frame), then "1 gap". The clip count stays whole; when the values are too
long for the card they are cut at their end, with their full text on
hover. The card has no layout control, and its own edits (a reorder, ✕)
keep the layout and every clip's start.

## Audio clips

Under the video, the timeline has audio rows. Each row holds audio clips
that do not overlap. A clip is the music on the node's `audio` socket, or an
audio file from the library.

**The music** is the first clip on the first row when it is connected. If
you remove it, Done disconnects the music, as removing a video's last clip
disconnects it. If you disconnect the music on the canvas, its clips go
with the connection (also while the editor is open, and also when you copy
the node without its music), and a new connection starts as one whole clip
at 0:00. A music clip whose music is not connected is kept, drawn dashed
("No audio connected"), and is silent.

**Adding audio.** **+ Add audio**, under the audio rows, opens **Add audio
from the library**: audio files only, with the same search, project menu,
Favourites, This workflow and sort as for videos. Each picked file goes on a
new row of its own, starting at the playhead. A library clip stores only the
asset's id; a clip whose file is gone is drawn "Not in the library" and
stops a render until it is removed.

**Editing a clip.** Click a clip to select it (⌘-click and ⇧-click add to
the selection; a selection holds either video clips or audio clips; ⌘A
selects every clip of the kind selected; a drag on empty audio-row space
draws a selection box). Drag it sideways to move it in time, and up or down
to another row; one drag can do both. Drop it under the last row, on the
**New row** strip, to make a row for it. A drop where it would overlap a
clip on that row puts it on a new row just below instead (a line shows
where while you drag). A row a move empties stays until you remove a clip
or open the editor again, so nothing jumps after you let go. Drag either
edge to trim it: the sound stays where it is in time, so an In trim moves
the clip's start with it, and an edge stops at the clip next to it on its
row. S splits the selected clips at the playhead; the pieces stay on their
row and sound exactly as before. ⌥← and ⌥→ move the selected clips a frame,
⌥↑ and ⌥↓ a row, [ and ] start or end the clip at the playhead, M mutes
them, ⌫ removes them. ← → ↑ ↓, Home and End move the selection between
audio clips. ⌘C, ⌘X, ⌘V and ⌘D work on audio clips: pasted clips go on new
rows, the first at the playhead; a duplicate starts where the selection
ends, on the same rows when there is room, else on new rows. A music clip
pastes only into the node it came from. The clip menu (right-click) has
Split at playhead, Start and End at playhead, Move up and down a row, Mute,
Copy, Cut, Paste, Duplicate and Remove clip.

**Audio keeps its own time.** Trimming, removing or reordering video clips,
or switching Track and Stacked, leaves every audio clip where it is in time;
only a fade out that ends at the end of the sequence follows the end.

**Moves snap** within 8 px to the playhead, 0:00, the end of the sequence,
every video clip's start and end, every other audio clip's start and end,
and the clip's own start. ⇧ turns snapping off.

**The volume curve.** Each clip has its own curve, drawn over its waveform.
The volume-curve button in a row's header makes the row taller (one row at a
time; selecting a clip never changes a row's height). On a taller row, with
one clip selected: click the line to add a point, drag a point, double-click
a point to remove it (the point before it is then selected, so ⌫ removes
points, not the clip), ⌥-drag to move the whole line. Fade in, Fade out and
Flat are in the rail for any one selected clip. The curve belongs to the
sound: moving the clip takes it along, and trimming shows or hides part of
it, so a fade that is trimmed away needs Fade in or Fade out again. A split
keeps the whole curve on both pieces. Fade out ends where the clip stops
being heard: its Out, or the end of the sequence; on a clip that plays to
the end of its file, Fade out waits until the file's length is read.

**Length.** The sequence still ends at the last video frame. Audio after it
is not heard: that part of a clip is hatched. A clip can start anywhere from
0:00 to 10:00.

**Loops.** While the audio is only the connected music, whole and starting
at 0:00 (its curve and mute may be changed), the music plays on across
loops as before, and its curve repeats each loop. Once the audio is anything
else, every audio clip repeats with each loop, the music included: with
Loop 2× on a 10 s sequence, a 20 s song plays its first 10 s twice instead
of playing through once. Each restart is a cut. The rail says so under Loop
sequence while it applies.

**Clip sound** stays with each video clip (Clip audio and Volume in the
rail), as before.

**The timeline's height** depends on the number of video clips, the number
of audio rows and which row is taller, never on the layout or the
selection: switching Track and Stacked, undoing that, or clicking a clip
moves nothing above or inside the timeline. Its video part is sized for
whichever layout needs more room, so in Track with three or more clips an
empty band sits above the audio rows. Two audio rows show at once; more
scroll with the wheel over them (over Stacked's rows, only those scroll).
In a short window Stacked's rows give way first, then the audio rows, down
to one; the stage keeps at least 300 px.

## Several clips

**Selecting.** A click on a clip selects it alone. ⌘-click (Ctrl-click on
Windows) adds a clip to the selection or takes it out. ⇧-click selects
every clip from the last clip you clicked to this one: in Track in their
order, in Stacked by row (the same thing, since rows are the order). A
⌘-click or ⇧-click that lands on a clip's trim handle selects too; drag
from a handle to trim. A drag on empty space in the lane draws a box and
selects the clips it touches (in Track every clip it crosses sideways, in
Stacked every box it touches); with ⇧ or ⌘ held when you press, they are
added to the selection. In Track the clips fill most of their row, so
press just above or below them (or past the last one when zoomed in) to
start a box; it covers the whole row and grows sideways. A click on empty
space clears the selection. ⌘A selects every
clip. A selection change is not an undo step. On a Mac, Ctrl-click opens
the clip menu and keeps the selection when the clip is in it. The arrow
keys on the lane and a plain press on a trim handle work on one clip: they
select it alone. I, O, [ and ] do nothing while several clips are
selected.

**With several selected.** Drag any of them and they all move. In Stacked
they move by the same time and the same number of rows, keeping their
spacing; only the clip you hold snaps, and the others keep their place
relative to it. The group stops when its first clip reaches 0:00 or its
last reaches 10:00, and at the top and bottom rows. In Track they move as
one block to where you drop them, in their order; the block moves only once
the insertion bar has shown, so a small wobble never gathers clips that
were apart. ⌫ removes them all; ⌥M mutes them all, or unmutes them all when
every one is muted; ⌥← and ⌥→ nudge them all (in Stacked); ⌥↑ and ⌥↓ move
them all a row; S splits every selected clip the playhead is inside. Each
is one undo step. Trims, Start, In and Out stay one clip's: the rail hides
them, and their keys do nothing.

**Copy and paste.** ⌘C copies the selected clips: each one's video, trim,
sound and volume, and where it starts relative to the first. ⌘X does the
same and removes them, as one undo step. ⌘V pastes. In Track the clips go
after the last selected clip, or at the end. In Stacked they go on new rows
below the lowest selected row (after the last piece, when that row is a
piece of a split, so the split still changes nothing), or at the bottom,
and the first starts at the playhead with the others at the same distances
as before; like any placing edit, this first fixes every clip's start, so
while a clip is still loading it waits ("Waiting for the clips to load")
rather than place the clips from a length not known yet. ⌘D
duplicates the selection without touching what you copied: in Track right
after it, in Stacked on new rows starting where the selection ends. Pasted
and duplicated clips become the selection, and each paste, cut or
duplicate is one undo step. The clip menu has Copy, Cut, Paste and
Duplicate too.

What you copy stays until you copy again or reload the app, so it can be
pasted into another Edit Video node, in this workflow or another. A library
clip pastes anywhere. A clip from a connected video pastes only into the
node it is connected to, in the same workflow and tab, while it is still
connected; any other is left out, and a notice says how many and why.
Cutting every clip of a connected video and then pressing Done or Save
disconnects that video, as Remove clip does, so those clips can no longer
be pasted, not even back into their own node: paste them back before Done.
In a text field (a timecode), ⌘C, ⌘V, ⌘X and ⌘A are the field's own, and
with text selected in the editor ⌘C and ⌘X copy the text. In the editor
none of these keys reach the canvas or the browser (⌘D does not bookmark
the page).

Cancel's discard sheet names them: "Two pasted clips and a cut clip will be
lost."

## How it is encoded

`stitchVideosAsync` (`src/hooks/useStitchVideos.ts`) takes one input per
clip (`{ blob, inSec, outSec, muted, volume }`, and on a node the editor
wrote the clip's `source` key, so pieces of one video are known), the music
with its curve, and the options: `{ loopCount }`, `audioClips` (each unmuted
audio clip with its decoded file, start, In, Out and curve) when the node's
audio is more than the untouched music, plus `overlapSec` and
`crossfade` when the node is a lined-up stack with an overlap above 0, or
`overlapSec`, `crossfade` and `placed: true` when some clip is placed (each
placed clip's input then carries its `startSec`). A Track node passes
`{ loopCount }` alone, as before. `gatherStitchInputs`
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
exactly where the previous one ends (in a lined-up stack, its overlap
before that; in a placed stack, at its own start). Size, bitrate, profile
and rotation follow the old rules: the largest coded size, the first clip's
rotation, at least 8 Mbps, H.264.

**Clip sound.** An unmuted clip's own sound plays under its picture at its
volume. It is cut at the clip's Out, and a clip without sound is silence.
Every clip's sound is converted into one master format: the music's rate
when the music plays alone, otherwise the highest rate that plays, at most
stereo (5.1 and quad are downmixed; centre kept, LFE dropped). Resampling is
linear. A clip whose sound fails to decode is silence in its own place.

**Audio.** On a node without `audioClips`, the music plays once,
continuously across loops (as before; see Loops in Audio clips). The curve
covers one loop and shapes it again on each loop, sampled in 128-sample
blocks and ramped inside each block. The music is cut at the encoded length
and padded with silence when it is shorter. `audioMuted` drops it; the
clips' sound still plays. Otherwise each unmuted audio clip's heard part
(from its In, up to its Out or the end of the loop) is decoded, shaped by
its curve sample by sample (ramped in 128-sample blocks), and added at its
start in every loop. Each clip is laid on its file's own sample grid at the
master rate, and the blocks sit on that grid, so the pieces of a split give
exactly the samples the whole clip gave. Each file is decoded once, with the
same decoder the waveform uses. The master format is the audio file's rate
when one file sounds alone, otherwise the highest rate among everything that
sounds, at most stereo. Whether a node takes this path is decided by what
its audio is, not by whether `audioClips` is stored: an empty `audioClips`
with the music connected encodes as before. The progress line says "Mixing
N audio clips...". A library audio file that is gone stops the run with
"Audio clip “<file name>” is no longer in the library" (or, when its record
was never read, "The audio clip on Audio 2 at 0:03.00 is no longer in the
library").

**Lined-up stacks.** A clip's frames outside its overlaps pass straight
through, as in Track. With Crossfade off that is every frame from where the
clip before it ends to its own Out, and nothing is blended. With Crossfade on,
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

**Placed stacks.** The encoder works out each clip's start with the editor's
own rule (`resolveStarts` in `src/lib/stitch/placement.ts`), using the
lengths it measures, so a clip without a start lands where the editor drew
it. A placed stack whose clips sit where Track or Line up would put them
encodes exactly as Track or as the lined-up stack does (`routePlacement` in
`src/lib/stitch/placedSchedule.ts`). Otherwise one loop is cut, on the 60
fps grid, into stretches at every start, end and fade edge, and each stretch
is black (no clip plays), one clip (the clip in front, at full: its frames
pass straight through, as Track writes them) or a blend of the clips that
show. Each clip gets a decoder for each stretch of slots in which it shows,
per loop, closed after it (`encodePlacedLoop` in
`src/lib/stitch/clipReader.ts`). A decoder opened where a clip shows again
first looks up the frame in effect there (a packet's timestamp, nothing
decoded) and starts a slot before that frame's slot, so it keeps the same
frame Track would on a source that puts two frames on a slot, and it never
reads past Out. A blend lays its clips over each other by
their shares of the picture (`FrameBlender.composite`): byte by byte when
all its frames have the same 8-bit pixel format and the size of the first
frame encoded, otherwise on a canvas as above. It writes a frame on each
slot where one of its clips' frames changes, and at least every third slot
(every slot while a clip runs below 10 fps or reports no rate). A gap writes
one black frame, made in the first video frame's own pixel format and colour
space when that is 8-bit YUV (8-bit I420 in its colour space when it is 10-
or 12-bit), so it does not change the file's colour tags. A loop that opens
on a blend made on the canvas reads that first frame back the same way.
Each clip's sound starts at the clip's start. With Crossfade on it is
shaped, sample by sample, by its share of the sound, so a hidden clip is
silent; with it off it plays in full. Clip sound is silent in a gap, and the
music plays across the whole loop. The progress line says "Processing video
N/M...", "Blending video N into M..." or "Blending N videos...".

**Loops.** `loopCount` repeats the sequence: the encoded length is the
sequence length times the loop count. In Stacked one loop runs to the end
of the clip that ends last, and each restart is a cut. The audio is AAC at
128 kbps (MP3 if the browser has no AAC encoder), tried in the master
format, then 48 kHz and 44.1 kHz stereo. All the audio is written before
any video. When more than one source sounds at once (clip sound, music,
audio clips that overlap in time), the sum is hard-clipped to full scale;
one source on its own passes through as decoded.

### "Renders as before"

A node the editor never wrote renders the same clips in the order the card
shows (see Card reorders below), whole, at the same size and codecs, repeated `loopCount` times, with the
same sound rule: the clips' own sound without music, the music alone with
it. It is not bit-identical, by design:

- **Joins are exact.** Each clip's picture used to start 1/60 s after the
  previous clip's last frame, so the picture ran ahead of the sound by
  `t0 + 1/fps − 1/60` s per join. Now each clip starts where the previous one's
  length ends, so every later join comes `t0 + 1/fps − 1/60` s later than
  before, where t0 is the video track's first timestamp (usually 0): 25 ms
  per join at 24 fps, 17 ms at 30 fps, none at 60 fps. It stays with its
  sound. When the render's sound is at least as long as its video, the sound
  sets the file's length: about the same as before, or slightly shorter
  where a clip's sound or container ran past its video. A render with no
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
always changed the filmstrip, but the render kept connection order. It now
follows the card, on legacy nodes too.

**Stacked changes none of this.** A node in Track, a stacked node whose
joins all come out as cuts, and a node the editor never wrote encode
exactly as they did before Stacked was added. Nor does placing clips: a
node in Track, a stacked node with no positions, and a node the editor
never wrote encode exactly as they did before clips could be placed.

## The volume curve

Each audio clip's line is drawn on a square-root scale: a point's height is
`1 − √gain`, so 0 dB is the top, −∞ the bottom and −12 dB the middle guide.
Between two points the level moves in a straight line on that scale
(`gainAt` in `src/lib/stitch/curve.ts`), so what is drawn is what is heard.
An empty curve is flat at 0 dB. Before the first point the line holds the
first point's level, and after the last point the last one's.

Click the line to add a point; drag a point (up and down, and along);
double-click a point to remove it; ⌥-drag moves the whole line. Fade in and
Fade out set a 1 s ramp at either end of the part of the clip that is heard
(at most half of it), and Flat clears the curve.

Points keep their times when trims make the sequence shorter. Points past
the clip's Out are kept and not drawn, but they still shape the line up to
the Out, so a fade out made before a trim no longer reaches silence at the
new end. Press Fade out again after shortening.

Switching between Track and Stacked, changing Overlap in a lined-up stack,
or Line up changes the length without a trim, so a fade out that ends at the
end, on any audio clip, follows it (`followEndFade`): when the curve's last point is silent and
within one 1/60 s frame of the old end, it and the point before it move by
the change in length, in the same undo step. Switching back moves them back,
so the curve returns as it was. Other points keep their times, and a move
that would take the point before the last below 0 or past the point ahead of
it leaves the curve as it is. Moving or trimming a clip in Stacked does not
move the curve: press Fade out again after a move that changes the end.

## Library clips

`+` in the Clips header (in Stacked, in the corner beside the ruler), the
dashed slot after the last clip, or the empty lane opens **Add from
library**: videos only, with search, a project menu, Favourites, This
workflow and a sort. The picked videos are added after the last clip, in
the order they were picked, as one undo step. The playhead goes to the
first added clip's start. In Stacked each added clip gets a row of its own
at the bottom. In a lined-up stack it overlaps the clip before it like any
other; in a placed stack it starts Overlap before the latest end among the
rows above it, so several added clips chain, and it has no start of its
own until an edit places the clips (see Stacked). Until the editor has
read a new file, the playhead is placed with the length in the library's
record. The picker's footer says what the videos go after ("goes after
Clip 3": the last clip, or in a placed stack the clip that ends last) and
their own total length, which in Stacked is more than the sequence grows
by.

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
it. In the Edit video view the library pane replaces the picker.

## The Edit video view

Bare **E** (or **Edit video** in the tab strip or the menu) shows the Edit
video view over the canvas, as A shows Assets and C the chat. It edits
**edit projects**: timelines of their own, not tied to any node or
workflow, with videos and audio from the asset library of any project.
The Edit Video node and its dialog are unchanged; the two never share a
timeline. E, A or C in the view go to the canvas, Assets or the chat;
Escape never leaves it.

**Edit projects.** Each is one file, `<Node Banana folder>/Edits/<name>.nbedit`
(JSON): a stable id, the name, when it was made and last changed, the
sequence (video clips, audio clips, loop count, Track or Stacked), what
the library said about each asset it uses (name, kind, project, length,
so a clip the library lost can still be named), a summary for the list,
and the renders made from it. Media are referenced by asset id only. A
library move carries the Edits folder with it; switching to another
library folder leaves it behind, as it leaves Generations.

**Home.** With no edit open, the view lists the edits, newest first, with
New edit. A new edit is called "Untitled edit" (then "Untitled edit 2", …).
Each card's ⋯ menu renames, duplicates, shows the file or deletes the edit.
The arrow keys move between the cards.

**Editing.** The open edit shows the library on the left and the same
editor as the dialog: stage, transport, rail and timeline, with the same
keys. Click a video or a sound in the library (or press Enter on it) to
add it at the playhead: in Track after the clip under the playhead (the
new clip is selected with the playhead at its start, so clicks in a row
add in the order clicked), in Stacked on a new bottom row starting at the playhead, or after the last
clip when the stack is lined up and the playhead is at the end. Drag it
onto the timeline to put it exactly there: a bar between clips in Track, a
new row at the row boundary nearest the pointer in Stacked, or an audio
row (a new row under it when the sound would overlap a clip there). Its
start snaps to the playhead and the clips' edges, and ⇧ turns that off.
Escape cancels a drag. While a clip of a Stacked edit is still loading,
adding a video there waits ("Waiting for the clips to load"), so nothing
is placed from a length the editor does not know yet. Videos recorded
while the view is open wait behind "N new · Show" at the top of the
library, so the tiles never move under the pointer. `+` on the timeline
goes to the library's search. The library pane hides with the button in
its corner and stays hidden until shown again. The header names the edit
(click to rename), and its menu offers New, Open, Duplicate, Rename, Show
in Finder and Delete (to the Trash; renders stay in the library). The rail
has no Reveal source node: an edit's clips come from the library.

**Saving.** An edit is a document. With "Save automatically" on (Settings
› Project) it saves 3 s after the last change; ⌘S and File › Save save it
now while the view shows (they save the workflow everywhere else; on the
home screen ⌘S does nothing). The header says Saved, Saving…, Unsaved,
Waiting… (the library is being moved), Save failed, Changed elsewhere or
Not in Edits. Saves run one at a time, so ⌘S during an automatic save
never looks like a conflict. Leaving the view keeps the edit as it was,
undo history and playhead included, and saves it first when Save
automatically is on. With it off, switching to another edit asks whether
to save. Closing the window with unsaved edits asks first. If another
window changed the same edit, saving stops and asks: keep yours, or use
the other version. If the edit's file is gone (deleted or renamed
elsewhere), saving offers **Save as a new edit**. A file copied in Finder
keeps the original's id; the list shows it as a copy, with **Make it a
separate edit**.

**Render.** Encodes the edit with the same engine and options as the node
(one clip is enough), with progress and Stop in the header. The video goes
into the asset library as an edited video under the edit's name, not under
any workflow, and in no project; a toast offers Show in Assets and Add to
canvas. Assets lists an edit's renders together under the edit's current
name (a rename updates the name Assets shows) and offers no Open workflow
for them. Render is off, and says why, while a clip's video is no longer in
the library ("Not in the library · sunset.mp4" in the rail).

**Frame to canvas** from the view adds the image node to the middle of the
open workflow's canvas, and its toast offers Go to canvas.

**Show in Finder.** The home screen's Show in Finder opens the Edits
folder (it is created if it is not there yet); the edit menu's shows the
edit's own file.

## Frame to canvas

**Frame to canvas**, at the foot of the editor's right-hand rail, puts the
picture under the playhead on the canvas as an image node. It is there
whatever is selected.

- It shows the clips the preview shows at the playhead, with the same
  source frames and blend as Render: in Stacked, the same mix of the clips
  that overlap there.
- The image is the sequence's frame size (the largest clip, as the header
  shows), as PNG.
- The new image node goes to the right of the Edit Video node, selected.
  More frames from the same node go in a column under it.
- The frame is kept in the asset library as an edited image ("Frame grab"),
  with the playhead time and the clips it shows. The workflow kept with it
  is the canvas as it was, not the unsaved edit.
- One undo on the canvas removes the node. The editor stays open, and its
  own undo history is not touched.
- While the preview plays, the button pauses it and takes the frame where it
  stopped.
- The button is off when there are no clips, while clips are still loading,
  when no clip has a video yet, and when the playhead is in a gap (black).

The frame is decoded from the clips' files, not copied from the preview, so
it is exact even while the preview is still seeking. A clip whose site does
not let the app read its file, or whose file is gone, cannot be copied: the
message says which clip, and Render cannot use that clip either. A frame
that takes more than 30 seconds to read is given up.

## Keys

None of these fire while a timecode field has focus, apart from the Overlap
and Start wells' own ↑ and ↓. While a handle, clip or
point is being dragged, only Escape (cancels the drag) and K work.

| Key | Action |
|---|---|
| Space | Play or pause |
| I / O | Set the selected clip's or audio clip's In / Out at the playhead (the playhead must be inside it) |
| S | Split the clip under the playhead; with several selected, every selected clip under it (in a lined-up stack, not where two clips play); or the selected audio clips |
| ⌫ / Delete | Remove the selected clips or audio clips, or the selected curve point |
| M | Mute or unmute the selected audio clips; with none selected, the music |
| ⌥M | Mute or unmute the selected video clips' own sound, or the selected audio clips |
| ⌥← / ⌥→ | Stacked: the selected video clips; any layout: the selected audio clips. A frame (1/60 s) earlier / later; ⇧ for 10 frames. A held key's repeats are one undo step |
| ⌥↑ / ⌥↓ | Stacked: move the selected clips up / down a row; or the selected audio clips a row |
| [ / ] | Stacked: start / end the selected clip at the playhead, or the selected audio clip in any layout (also ⌥5 / ⌥6 and AltGr+8 / AltGr+9 where the keyboard types brackets that way) |
| ⌘Z / Ctrl+Z | Undo, in the editor only |
| ⇧⌘Z / Ctrl+Y | Redo |
| J / K / L | Back 1 s / pause / play |
| ← / → / Home / End | Move the selection along the clips (with a clip focused; in Stacked ↑ / ↓ too), or along the audio clips with one focused (↑ / ↓ too) |
| ↑ / ↓ in the Start well | 0.1 s later or earlier (⇧: 1 s), one undo step until the well is left |
| Context menu key / ⇧F10 | Open the clip menu |
| Escape | Close the menu or the picker; cancel a drag; on the discard sheet, Keep editing; otherwise Cancel (in the Edit video view, nothing) |
| ⇧ while dragging a clip or an edge | No snapping (in Stacked, pressing or releasing ⇧ while the pointer rests takes effect at once) |
| ⌥ while dragging the curve | Move the whole line |
| ⇧ + wheel | Scroll along the timeline (in Stacked with more rows than fit, where a plain wheel scrolls the rows) |
| ⌘S | Save: writes the edit to the node and saves the workflow, keeping the editor open; in the Edit video view, saves the edit |
| E (in the Edit video view) | Back to the canvas (A: Assets, C: Chat, ?: the shortcuts) |
| ⌘C / ⌘X / ⌘V | Copy, cut, paste clips or audio clips |
| ⌘D | Duplicate the selected clips or audio clips |
| ⌘A | Select every clip, or every audio clip when audio is selected |
| ⌘-click / ⇧-click | Add or remove a clip / select a range |
| Drag on empty lane space | Select with a box (⇧ or ⌘ adds) |

In Track, ⌥ with an arrow, [ and ] do nothing to video clips (they work on
selected audio clips), and ⌥← never reaches the
browser (on Windows it would go Back). Keys the canvas or the browser
would act on (⌘Z, ⌘C, ⌘V, ⌘X, ⌘A, ⌘D, Shift+letters, ⌘↵ and so on) never
reach them while the editor is open, except in a text field.

**Snapping.** With Snap on, a dragged edge snaps within 8 px. In Track the
targets are the playhead and the neighbouring clip's edge where the drag
began, which gives the clip back its original length. Other clip edges move
with the trim (the clips after it close up or are pushed along) and are not
targets. In Stacked nothing else moves during a trim, so the targets are
the playhead, 0:00 for an In edge ("Snapped to the start"), every other
clip's start and end ("Snapped to Clip 3's end"), and the dragged edge's
own position where the drag began ("Snapped to the original length"). An In
edge moves the clip's start with it, so it can meet the playhead too.

A clip's box dragged in Stacked snaps within 8 px when its start or its end
meets the playhead or any other clip's start or end, on any row. Its start
alone also snaps to 0:00, to where it was (its own start at the press), and,
for each other clip, to one overlap before that clip's end ("a 1.0 s overlap
with Clip 3": the overlap Line up would give the two of them, less when
either is short, none between two clips of the same video). The targets are
taken when the clip lifts, after the preview pauses, so the playhead target
is where the playhead stopped; they keep the clips' names from the press.
The nearest target wins; on a tie, "where it was" goes first, then the
playhead, then the start edge. A target that would start the clip before
0:00 is skipped. The chip names the edge that snapped: "Snapped to Clip 3's
end" for the start edge, "End snapped to Clip 3's start" for the end edge,
"Snapped to where it was". Because of "where it was", a drag straight up or
down usually keeps its time while it strays no more than 8 px sideways,
though a closer target, such as the playhead, can win. An empty clip's slot
snaps its start only.

## Limits

- **Two servers on one library.** The desktop app and a dev server can
  share one Node Banana folder. Each checks an edit's last change before
  it saves, but two saves of the same edit from the two servers at the
  same moment can both pass that check, and the later write wins. Listing
  edits never writes, so browsing from both is safe.
- The Edit video view is laid out for windows 1100 px wide and more. Below
  1100 px its header drops the clip count and size; a stage column under
  760 px (the view at 1280 px with the library shown, or the dialog in a
  window under about 1088 px) drops the zoom slider and keeps −, + and Fit.
- A project made by name before Edit video existed and called "Edits"
  shares its folder with the edit files; both keep working.
- **The preview is an approximation.** It switches between one `<video>` per
  source, so a join can freeze briefly; clip volume and the curve are applied
  to the elements once a frame; it plays one loop. A video served without
  CORS shows no filmstrip frames. The encode is the truth.
- In Stacked the preview has one `<video>` per clip, so every clip loads.
  Where clips overlap they all play at once, hidden ones too, and can drift
  apart by up to 0.15 s before they are seeked back together. In a gap the
  playhead runs on the frame clock.
- The preview plays one `<audio>` per audio clip, set once a frame; it can
  drift up to 0.25 s before it is seeked back.
- Each audio file is decoded whole while a render runs: about 115 MB for 5
  minutes of 48 kHz stereo. For the waveforms the editor decodes at most two
  files at a time and keeps only their peaks.
- A row taller for its volume curve needs its header's button; editing
  points needs it.
- Pasting and duplicating add elements the same way: ⌘A then ⌘D doubles
  them each time. Past 24 clips in Stacked a notice says so; nothing is
  refused, but the preview slows down and a browser plays only so many
  videos at once.
- **Mixed aspect ratios crop.** The encode keeps the old behaviour: the
  largest coded size, each clip scaled to cover it. The preview letterboxes.
- Frame to canvas draws each clip as Render does where Render and the
  preview differ: clips of another shape fill the frame (cropped) where the
  preview letterboxes them, and each clip is drawn upright by its own
  rotation, where Render keeps the first clip's rotation for all. Its source
  frames and blend are Render's too, so at the very start of a lined-up
  dissolve it can show the outgoing clip alone where the preview has begun
  to fade the next one in.
- Clip sound is resampled linearly, and a mix of clip sound and music above
  full scale is hard-clipped. So is clip sound where stacked clips overlap,
  which adds up: with Crossfade off every clip that plays is heard at its
  own volume, so two loud ones can clip for the whole overlap and three or
  more at once distort (lower their volume); with it on, two very similar
  sounds can peak 3 dB louder in the middle.
- With Crossfade on, a fade lasts at most as long as the picture below
  plays before the clip starts or after it ends. Where an overlap is longer
  than half the clip below, the dissolve is shorter than the overlap, and a
  short clip inside a long one shows alone only at its middle.
- A lined-up stack's dissolve decodes the earlier clip a second time, from
  its last key frame before the overlap. Many generated clips have a single
  key frame, so that is often the whole clip, once per join and loop. Two
  decoders run during a dissolve, and for a moment after it a third.
- A placed stack opens a decoder for each stretch in which a clip shows, per
  loop. A clip shown again after a cutaway, or hidden in the middle by a
  higher row and shown again (with Crossfade on or off), decodes its lead
  again, from its last key frame. Every clip that shows at once holds a
  decoder, roughly 50 MB each at 1080p and 175 MB at 4K. Above 4 at once the
  encoder logs a warning ("[VideoStitch] 5 clips blend at once; this takes
  about 250 MB at 1080p"). When a decoder fails while 3 or more clips blend,
  the run stops with "Could not decode 3 clips at once at 0:12. Move some
  apart or turn Crossfade off." (the time is where that blend starts in the
  rendered video). With Crossfade off only the clip in front has its picture
  decoded.
- A placed blend writes a frame whenever one of its clips' frames changes:
  up to 60 a second for clips at different rates, so each frame gets fewer
  bits.
- Blended frames drawn on the canvas (clips of different sizes or formats,
  or 10-bit video) can differ slightly in colour from the frames on either
  side, and HDR is tone-mapped there. Frames whose decoder pads their coded
  height (1080 to 1088) also take the canvas in a blend, scaled to cover it,
  about 0.7 % larger than the frames beside them; lined-up dissolves already
  did this.
- The timeline grows to 303 px for four or more clips, in either layout,
  and by 72 px while an audio row is taller, taking room from the stage
  down to 300 px; on a window about 900 px tall the rail then scrolls, more
  with a clip selected, since Stacked's rail adds Start above Trim and six
  key hints.
- A clip starts at most at 10:00 (600 s); a later start, typed or dragged,
  stops there.
- An edit that places the clips while a clip's source is still loading (a
  nudge, a trim, a drag) counts that clip as 0 s, so the clips after it are
  placed as if it took no time, and they stay there once it loads. Undo of
  that edit puts the stack back. A Stacked add, paste or duplicate waits
  instead.
- A file mediabunny cannot open is shown at the `<video>` element's
  duration (an unreadable slot if that is not finite either), but Render
  reads files with mediabunny and stops on it. A file mediabunny opens with
  no video track is an unreadable slot and is left out of the encode.
- The node's Render needs at least two clips with a video (the Edit video
  view's needs one). A clip trimmed past its end
  or a file with no video track still counts, so the output can hold a
  single clip.
- A Done made while a workflow runs cannot be undone on the canvas unless it
  also disconnects a clip's connection: the store takes no undo snapshot of
  node edits during a run, as for every other edit made then.
- The agent sees the node's `clipOrder` and loop count, not its timeline,
  its layout, where its clips are placed or its audio clips; its edits keep
  them all.
- Not built: ducking the music under clips with sound, roll edits,
  transitions other than the crossfade where stacked clips overlap, a
  crossfade at the loop's restart, an overlap set per join, fade lengths
  set per clip, selecting or deleting a gap, a slip edit,
  a start before 0:00, a lock to one axis while dragging a clip, speed
  changes, titles, a second video track (Stacked's rows are still one
  sequence and one output track), a second audio socket, audio effects
  other than the volume curve, selecting video and audio clips together, a
  volume slider for audio clips, audio that follows a video clip when the
  video moves, selecting a whole audio row from its header, extending a selection with ⇧ and
  the arrow keys, copying clips to the system clipboard (the copy lives in
  the app until it reloads), snapping every clip of a group drag (only the
  clip you hold snaps).
