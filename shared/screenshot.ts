/**
 * shared/screenshot.ts — pure screenshot-planning logic, shared so it can be
 * unit-tested without Chrome and reused by the extension SW.
 *
 * Turns measured page dimensions (and an optional element rect) into the
 * `Page.captureScreenshot` clip + the logical dimensions/truncation flags the
 * `ScreenshotResult` reports. No chrome.* calls — just arithmetic.
 */

/** Measured page geometry, in CSS pixels. */
export interface PageDims {
  /** Viewport width/height. */
  w: number;
  h: number;
  /** Full content box (document) width/height. */
  fullW: number;
  fullH: number;
  /** window.devicePixelRatio, including page zoom (default 1). */
  dpr?: number;
  /** Chrome tab zoom: CSS pixels to device-independent pixels (default 1). */
  zoom?: number;
  /** Current scroll offset of the top document (default 0,0); a viewport clip starts here. */
  scrollX?: number;
  scrollY?: number;
}

export type ScreenshotFormat = 'png' | 'jpeg';

/** Default encoding: JPEG at this quality is ~5-10x smaller than PNG on a
 *  typical page and still perfectly legible to a vision model. */
export const DEFAULT_SCREENSHOT_FORMAT: ScreenshotFormat = 'jpeg';
export const DEFAULT_JPEG_QUALITY = 70;
/** Output size multiplier relative to CSS pixels. 1 = CSS px (so a Retina
 *  viewport is NOT captured at 2x); 2 = device px on a 2x display. */
export const DEFAULT_SCREENSHOT_SCALE = 1;

/** An element's box in DOCUMENT coordinates (viewport rect + scroll offset), CSS px. */
export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A CDP `Page.captureScreenshot` clip (device-independent px, not CSS px). */
export interface CaptureClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface ScreenshotPlan {
  /** Omitted for a plain viewport capture (capture whatever is visible). */
  clip?: CaptureClip;
  /** Must be true whenever a clip reaches outside the current viewport. */
  captureBeyondViewport: boolean;
  /** Logical (CSS px) dimensions to report back in ScreenshotResult. */
  width: number;
  height: number;
  /** The capture was clamped below the real content/element height. */
  truncated: boolean;
  /** The true height when `truncated` (or for any fullPage/element capture). */
  fullHeight?: number;
}

/**
 * Practical single-capture height ceiling. Skia/CDP cannot encode arbitrarily
 * tall images; beyond this we clamp the clip and flag `truncated`.
 */
export const MAX_CAPTURE_PX = 16384;

/**
 * Plan a capture. Element clip wins over fullPage; fullPage wins over the plain
 * viewport capture. Heights are clamped to MAX_CAPTURE_PX with `truncated` set.
 */
export function planScreenshot(
  dims: PageDims,
  opts: { fullPage?: boolean; element?: ElementRect | null; scale?: number } = {},
): ScreenshotPlan {
  // Page.Viewport uses device-independent pixels, so convert the CSS geometry
  // by the tab zoom. DPR already includes that zoom: dividing the output scale
  // by DPR then yields exactly `opts.scale` output pixels per CSS pixel.
  const dpr = dims.dpr && dims.dpr > 0 ? dims.dpr : 1;
  const zoom = dims.zoom && dims.zoom > 0 ? dims.zoom : 1;
  const scale = (opts.scale && opts.scale > 0 ? opts.scale : DEFAULT_SCREENSHOT_SCALE) / dpr;
  const clip = (x: number, y: number, width: number, height: number): CaptureClip => ({
    x: x * zoom, y: y * zoom, width: width * zoom, height: height * zoom, scale,
  });
  if (opts.element) {
    const realH = Math.max(1, Math.round(opts.element.h));
    const clipH = Math.min(opts.element.h, MAX_CAPTURE_PX);
    return {
      clip: clip(opts.element.x, opts.element.y, opts.element.w, clipH),
      captureBeyondViewport: true,
      width: Math.max(1, Math.round(opts.element.w)),
      height: Math.min(realH, MAX_CAPTURE_PX),
      truncated: realH > MAX_CAPTURE_PX,
      fullHeight: realH,
    };
  }
  if (opts.fullPage) {
    const clipH = Math.min(dims.fullH, MAX_CAPTURE_PX);
    return {
      clip: clip(0, 0, dims.fullW, clipH),
      captureBeyondViewport: true,
      width: dims.fullW,
      height: clipH,
      truncated: dims.fullH > clipH,
      fullHeight: dims.fullH,
    };
  }
  // Plain viewport: a clip is needed to apply an output scale or page zoom.
  // The caller can also force a fresh paint with a viewport clip at 100%.
  return {
    ...(scale !== 1 || zoom !== 1
      ? { clip: clip(dims.scrollX ?? 0, dims.scrollY ?? 0, dims.w, dims.h) }
      : {}),
    captureBeyondViewport: false,
    width: dims.w,
    height: dims.h,
    truncated: false,
  };
}
