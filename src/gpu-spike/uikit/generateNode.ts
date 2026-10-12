// GPU canvas spike (throwaway): question 3's uikit copy of the Generate node,
// built to the live node's measured boxes (300 wide: a 4 px padded media card,
// an 8 px gap, a 30 px controls card 12 px in from each side, and the floating
// header 22 px above). Borders are the live node's 60% #404040 over the card.
// Units are flow units: the root's pixelSize is 1.
import { Container, Image, Svg, Text } from "@pmndrs/uikit";
import type { Object3D, Texture } from "three";

/** Adds uikit children (its classes' add() and clone() types don't line up with three's Object3D). */
export function add(parent: { add(...children: never[]): unknown }, ...children: unknown[]) {
  parent.add(...(children as never[]));
  return parent as unknown as Object3D;
}

const STAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#737373" d="M12 2c.6 4.6 2.4 8.4 10 10-7.6 1.6-9.4 5.4-10 10-.6-4.6-2.4-8.4-10-10 7.6-1.6 9.4-5.4 10-10z"/></svg>`;
// uikit's Svg fills paths and ignores strokes, so the chevron is drawn as a filled V.
const CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#a3a3a3" d="M5 8.4 6.4 7 12 12.6 17.6 7 19 8.4l-7 7z"/></svg>`;

export interface GenerateNodeData { title: string; aspectRatio: string; resolution: string; image: Texture | string | undefined }

/** A socket: a ring on the card's edge, as a bordered panel (panels batch into one draw; Svgs don't). */
function socket(left: number, top: number, color: string) {
  return new Container({ positionType: "absolute", positionLeft: left - 4.5, positionTop: top - 4.5, width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5, borderColor: color, backgroundColor: "#262626" });
}

/**
 * One Generate node, positioned at (x, y) in its parent; header included,
 * above y. Without `icons` the node has no Svgs: each Svg is its own draw call.
 */
export function generateNode(x: number, y: number, data: GenerateNodeData, { fontFamily, icons = true }: { fontFamily?: string; icons?: boolean } = {}) {
  const node = new Container({ positionType: "absolute", positionLeft: x, positionTop: y - 22, width: 300, flexDirection: "column", alignItems: "center", fontFamily });
  // The floating header: icon, uppercase title, chevron.
  const header = new Container({ width: 300, height: 22, flexDirection: "row", alignItems: "center", paddingLeft: 12, gap: 6 });
  if (icons) add(header, new Svg({ content: STAR, width: 16, height: 16 }));
  add(header, new Text({ text: data.title.toUpperCase(), fontSize: 12, lineHeight: "16px", fontWeight: "semi-bold", letterSpacing: 0.3, color: "#a3a3a3" }));
  if (icons) add(header, new Svg({ content: CHEVRON, width: 14, height: 14 }));
  add(node, header);
  // The media card.
  const card = new Container({ width: 300, padding: 4, backgroundColor: "#262626", borderWidth: 1, borderColor: "#363636", borderRadius: 12 });
  add(card, new Image({ src: data.image, width: 290, borderRadius: 8, objectFit: "cover", keepAspectRatio: true }));
  // Sockets: image and prompt in, image out.
  add(card, socket(0, 25, "#10b981"), socket(0, 55, "#3b82f6"), socket(300, 25, "#10b981"));
  add(node, card);
  // The gap, then the controls card: icon, model, "16:9 · 1K", chevron.
  const controls = new Container({ marginTop: 8, width: 276, height: 30, borderWidth: 1, borderColor: "#363636", borderRadius: 10, backgroundColor: "#262626",
    flexDirection: "row", alignItems: "center", paddingX: 8, gap: 6 });
  if (icons) add(controls, new Svg({ content: STAR, width: 16, height: 16 }));
  add(controls, new Text({ text: data.title, fontSize: 10, lineHeight: "14px", color: "#e5e5e5", flexGrow: 1, flexShrink: 1, wordBreak: "keep-all" }));
  add(controls, new Text({ text: `${data.aspectRatio} · ${data.resolution}`, fontSize: 10, lineHeight: "14px", color: "#737373" }));
  if (icons) add(controls, new Svg({ content: CHEVRON, width: 12, height: 12, marginX: 2 }));
  add(node, controls);
  return node;
}
