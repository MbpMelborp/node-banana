// GPU canvas spike (throwaway): the thin adapter over HTML-in-Canvas. The
// spike uses one operation, "paint this element into the bound texture", so
// a rename in Chromium only touches this file.
//
// Chromium 152 (Electron 44), measured in this spike:
//   gl.texElementImage2D(target, internalformat, element | ElementImage)
//   - no level, format or type; internalformat must be sized (RGBA8)
//   - the element must be a child of the WebGL canvas (<canvas layoutsubtree>)
//   - the texture is the element's css size times the canvas's backing scale
//     (canvas.width / its css width), with row 0 at the element's top
// Chromium 155 renames it texElementSubImage2D and the attribute becomes
// content="drawable"; not available in Electron 44, so not wired up yet.

type Gl152 = WebGL2RenderingContext & {
  texElementImage2D(target: GLenum, internalformat: GLenum, element: Element): void;
};

export function htmlInCanvasAvailable(gl: WebGL2RenderingContext): boolean {
  return "texElementImage2D" in gl;
}

/** Marks a canvas so its children are laid out (and can be painted) but not shown. */
export function enableLayoutSubtree(canvas: HTMLCanvasElement) {
  canvas.setAttribute("layoutsubtree", "");
}

/** Paints `element` into the texture bound to TEXTURE_2D, replacing level 0. */
export function paintElement(gl: WebGL2RenderingContext, element: Element) {
  if (!htmlInCanvasAvailable(gl)) throw new Error("HTML-in-Canvas is not available: start Electron with --enable-blink-features=CanvasDrawElement");
  (gl as Gl152).texElementImage2D(gl.TEXTURE_2D, gl.RGBA8, element);
}
