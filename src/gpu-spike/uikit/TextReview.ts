// GPU canvas spike (throwaway): question 3's text review. The same prompts in
// HTML (left) and in uikit (right), one row per script. uikit draws text from
// an MSDF atlas generated from a TTF in the page (its TTFLoader), so each row
// uses a system font for its script (/api/gpu-spike/font/<script>); the mixed
// row shows what one uikit font does with several scripts.
import * as THREE from "three";
import { Container, Text, TTFLoader, reversePainterSortStable, type FontFamilies } from "@pmndrs/uikit";
import type { View } from "../scene/Scene";
import { add } from "./generateNode";

export const REVIEW_ROWS = [
  { label: "English", script: "latin", text: "A weathered lighthouse at dusk, waves breaking over the rocks, mist rolling in." },
  { label: "Chinese", script: "cjk", text: "黄昏时分的旧灯塔，海浪拍打着岩石，薄雾缓缓飘来。" },
  { label: "Japanese", script: "cjk", text: "夕暮れの古い灯台、岩に砕ける波、ゆっくりと流れ込む霧。" },
  { label: "Arabic", script: "arabic", text: "منارة قديمة عند الغسق، والأمواج تتكسر على الصخور، والضباب يزحف ببطء." },
  { label: "Emoji", script: "emoji", text: "Lighthouse 🗼 at dusk 🌅, waves 🌊 and mist 🌫️ 👍🏽" },
  { label: "Mixed", script: "cjk", text: "Prompt: 灯台 at dusk, منارة, 🌅 — 16:9 · 1K" },
] as const;

const ROW_H = 96, TOP = 40, LEFT = 40, COLUMN = 560, FONT_PX = 14;

export interface ReviewFont { script: string; family?: string; file?: string; error?: string; ms: number }

export class TextReview {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 1000);
  private root: Container;
  readonly html: HTMLDivElement;
  readonly fonts: ReviewFont[] = [];
  readonly ready: Promise<void>;

  constructor(host: HTMLElement, private canvas: HTMLCanvasElement) {
    this.camera.position.z = 100;
    this.root = new Container({ pixelSize: 1, anchorX: "left", anchorY: "top", sizeX: 1400, sizeY: 800, width: 1400, height: 800, flexDirection: "column" });
    add(this.scene, this.root);
    // The HTML column, styled as a node's prompt text.
    this.html = document.createElement("div");
    this.html.dataset.gpuSpikeReview = "";
    this.html.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;color:#e5e5e5;";
    host.appendChild(this.html);
    REVIEW_ROWS.forEach((row, k) => {
      const y = TOP + k * ROW_H;
      const label = document.createElement("div");
      label.textContent = row.label;
      label.style.cssText = `position:absolute;left:${LEFT}px;top:${y - 18}px;font:600 11px system-ui;color:#737373;text-transform:uppercase;letter-spacing:.3px;`;
      const text = document.createElement("div");
      text.textContent = row.text;
      text.style.cssText = `position:absolute;left:${LEFT}px;top:${y}px;width:${COLUMN - 60}px;font:400 ${FONT_PX}px/20px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;`;
      this.html.append(label, text);
    });
    this.ready = this.build();
  }

  private async build() {
    // One MSDF font per script, with just the review's characters.
    const families: FontFamilies = {};
    const familyOf = new Map<string, string>();
    for (const script of [...new Set(REVIEW_ROWS.map(row => row.script))]) {
      const started = performance.now();
      const charset = [...new Set(REVIEW_ROWS.filter(row => row.script === script || row.label === "Mixed").flatMap(row => [...row.text]).concat([..." abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;·—-"]))].join("");
      try {
        const response = await fetch(`/api/gpu-spike/font/${script}`);
        if (!response.ok) throw new Error(await response.text());
        const file = response.headers.get("X-Font-Path") ?? "";
        const url = URL.createObjectURL(await response.blob());
        const result = await new TTFLoader().loadAsync([{ url, charset, fontSize: 48, textureSize: [2048, 2048] }]);
        const [family] = Object.keys(result);
        families[`review-${script}`] = result[family];
        familyOf.set(script, `review-${script}`);
        this.fonts.push({ script, family, file, ms: Math.round(performance.now() - started) });
      } catch (error) {
        this.fonts.push({ script, error: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - started) });
      }
    }
    this.root.setProperties({ fontFamilies: families });
    REVIEW_ROWS.forEach((row, k) => {
      const y = TOP + k * ROW_H;
      const fontFamily = familyOf.get(row.script);
      const note = this.fonts.find(f => f.script === row.script);
      add(this.root, new Text({ text: `${row.label} · uikit · ${note?.file || note?.error || "Inter"}`.toUpperCase(), positionType: "absolute", positionLeft: COLUMN + LEFT, positionTop: y - 18,
        fontSize: 11, fontWeight: "semi-bold", color: "#737373", letterSpacing: 0.3 }));
      add(this.root, new Text({ text: row.text, fontFamily, positionType: "absolute", positionLeft: COLUMN + LEFT, positionTop: y, width: COLUMN - 60, fontSize: FONT_PX, lineHeight: "20px", color: "#e5e5e5" }));
    });
  }

  draw(renderer: THREE.WebGLRenderer, _view: View, deltaMs: number) {
    this.root.update(deltaMs);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.camera.left = 0; this.camera.right = w; this.camera.top = 0; this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    renderer.localClippingEnabled = true;
    renderer.setTransparentSort(reversePainterSortStable);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.root.dispose();
    this.html.remove();
  }
}
