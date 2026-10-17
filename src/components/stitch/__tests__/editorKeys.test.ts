import { afterEach, describe, expect, it } from "vitest";
import { editorKeyAction, isCanvasKey, isTypingTarget, NO_REPEAT, type KeyLike } from "../editorKeys";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: mods.code ?? "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
});

describe("editorKeyAction", () => {
  it.each([
    [key(" "), "togglePlay"],
    [key("i"), "setIn"],
    [key("o"), "setOut"],
    [key("s"), "split"],
    [key("m"), "toggleMusicMute"],
    [key("Backspace"), "remove"],
    [key("Delete"), "remove"],
    [key("Escape"), "escape"],
    [key("j"), "back"],
    [key("k"), "pause"],
    [key("l"), "play"],
    [key("z", { metaKey: true }), "undo"],
    [key("z", { ctrlKey: true }), "undo"],
    [key("Z", { metaKey: true, shiftKey: true }), "redo"],
    [key("y", { ctrlKey: true }), "redo"],
    // ⌥M on a Mac types "µ"; the physical key decides
    [key("µ", { altKey: true, code: "KeyM" }), "toggleClipMute"],
  ] as const)("%o → %s", (event, action) => {
    expect(editorKeyAction(event)).toBe(action);
  });

  it("leaves other keys alone", () => {
    expect(editorKeyAction(key("x"))).toBeNull();
    expect(editorKeyAction(key("S", { shiftKey: true }))).toBeNull();
    expect(editorKeyAction(key("s", { metaKey: true }))).toBeNull();
    expect(editorKeyAction(key("Enter"))).toBeNull();
    expect(editorKeyAction(key("ArrowLeft"))).toBeNull();
    expect(editorKeyAction(key("Tab"))).toBeNull();
  });

  it.each([
    [key("ArrowLeft", { altKey: true }), "nudgeEarlier"],
    [key("ArrowRight", { altKey: true }), "nudgeLater"],
    // ⇧ is the big step, read by the caller
    [key("ArrowLeft", { altKey: true, shiftKey: true }), "nudgeEarlier"],
    [key("ArrowRight", { altKey: true, shiftKey: true }), "nudgeLater"],
    [key("ArrowUp", { altKey: true }), "rowUp"],
    [key("ArrowDown", { altKey: true }), "rowDown"],
    [key("["), "startAtPlayhead"],
    [key("]"), "endAtPlayhead"],
    // A German Mac types [ and ] with ⌥5 and ⌥6; German Windows with AltGr (Ctrl+Alt) 8 and 9
    [key("[", { altKey: true, code: "Digit5" }), "startAtPlayhead"],
    [key("]", { ctrlKey: true, altKey: true, code: "Digit9" }), "endAtPlayhead"],
  ] as const)("the selected clip's placing keys: %o → %s", (event, action) => {
    expect(editorKeyAction(event)).toBe(action);
  });

  it("leaves [ and ] with ⌘ or a plain Ctrl to the browser, and ⇧⌥↑ ⇧⌥↓ alone", () => {
    expect(editorKeyAction(key("[", { metaKey: true }))).toBeNull();
    expect(editorKeyAction(key("]", { ctrlKey: true }))).toBeNull();
    expect(editorKeyAction(key("ArrowUp", { altKey: true, shiftKey: true }))).toBeNull();
    expect(editorKeyAction(key("ArrowDown", { altKey: true, shiftKey: true }))).toBeNull();
    // ⌥M still mutes the clip
    expect(editorKeyAction(key("µ", { altKey: true, code: "KeyM" }))).toBe("toggleClipMute");
  });

  it("lets the nudges repeat and nothing else that places a clip", () => {
    for (const action of ["rowUp", "rowDown", "startAtPlayhead", "endAtPlayhead"] as const) {
      expect(NO_REPEAT.has(action)).toBe(true);
    }
    expect(NO_REPEAT.has("nudgeEarlier")).toBe(false);
    expect(NO_REPEAT.has("nudgeLater")).toBe(false);
  });
});

describe("isCanvasKey", () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it("covers what WorkflowCanvas acts on behind a dialog", () => {
    expect(isCanvasKey(key("?", { shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("Enter", { altKey: true }))).toBe(true);
    expect(isCanvasKey(key("Enter", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("c", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { ctrlKey: true }))).toBe(true);
    expect(isCanvasKey(key("z", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("Z", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("G", { shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("v"))).toBe(true);
    expect(isCanvasKey(key("g"))).toBe(true);
    expect(isCanvasKey(key("a"))).toBe(true);
    expect(isCanvasKey(key("c"))).toBe(true);
  });

  it("counts ⌘C with text selected (the shield never prevents the native copy, and the canvas would copy nodes)", () => {
    const p = document.createElement("p");
    p.textContent = "0:04.60";
    document.body.appendChild(p);
    window.getSelection()?.selectAllChildren(p);
    expect(isCanvasKey(key("c", { metaKey: true }))).toBe(true);
    p.remove();
  });

  it("matches the canvas's own modifier rules, not a stricter subset", () => {
    // Arrange (two or more nodes selected) reads only the key
    expect(isCanvasKey(key("g", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("g", { ctrlKey: true }))).toBe(true);
    expect(isCanvasKey(key("G", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { altKey: true }))).toBe(true);
    expect(isCanvasKey(key("g", { altKey: true }))).toBe(true);
    // Undo, paste and copy do not check Alt (Ctrl+Alt is AltGr on Windows)
    expect(isCanvasKey(key("z", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("c", { ctrlKey: true, altKey: true }))).toBe(true);
    // Shift+letter adds a node whatever Alt is (Windows and Linux keep the letter)
    expect(isCanvasKey(key("G", { shiftKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("P", { shiftKey: true, altKey: true }))).toBe(true);
  });

  it("leaves native keys alone", () => {
    expect(isCanvasKey(key("Tab"))).toBe(false);
    expect(isCanvasKey(key("ArrowRight"))).toBe(false);
    expect(isCanvasKey(key("Enter"))).toBe(false);
    expect(isCanvasKey(key("s", { metaKey: true }))).toBe(false);
    expect(isCanvasKey(key("x"))).toBe(false);
  });
});

describe("isTypingTarget", () => {
  const input = (type: string) => {
    const el = document.createElement("input");
    el.type = type;
    return el;
  };

  it("counts text fields", () => {
    expect(isTypingTarget(input("text"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("does not count a slider, a checkbox or a button", () => {
    expect(isTypingTarget(input("range"))).toBe(false);
    expect(isTypingTarget(input("checkbox"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
