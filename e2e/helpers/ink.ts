/**
 * Real-pixel ink measurement for alignment checks.
 *
 * Layout boxes do not say where a glyph or an icon actually paints: digits
 * sit above their line box's centre and an icon's ink is smaller than its
 * box. These helpers read the painted pixels instead.
 */
import type { Locator, Page } from '@playwright/test';

/** Where an element paints, in CSS px from the measured area's top-left corner. */
export interface InkBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly centerX: number;
  readonly centerY: number;
}

interface DevicePixelBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly imageWidth: number;
}

/**
 * Moves a relatively positioned element so its box starts on whole device
 * pixels. Text snaps to the pixel grid and vector icons do not, so a
 * fractional position alone can put their ink half a pixel apart.
 */
export async function snapToDevicePixels(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    const style = (element as HTMLElement).style;
    style.top = '';
    style.left = '';
    const ratio = window.devicePixelRatio;
    const box = element.getBoundingClientRect();
    const down = (Math.ceil(box.top * ratio - 0.001) - box.top * ratio) / ratio;
    const right = (Math.ceil(box.left * ratio - 0.001) - box.left * ratio) / ratio;
    if (getComputedStyle(element).position === 'static') style.position = 'relative';
    style.top = `${down}px`;
    style.left = `${right}px`;
  });
}

/**
 * Reads where `target` paints inside `area`: the pixels that change when only
 * `target` is hidden. Edges count pixels whose change is at least half the
 * strongest change, so anti-aliased fringes do not widen the box.
 */
export async function readInkBox(page: Page, area: Locator, target: Locator): Promise<InkBox> {
  const box = await area.boundingBox();
  if (!box) throw new Error('Ink area has no geometry');
  const clip = {
    x: Math.floor(box.x),
    y: Math.floor(box.y),
    width: Math.ceil(box.x + box.width) - Math.floor(box.x),
    height: Math.ceil(box.y + box.height) - Math.floor(box.y),
  };
  const shown = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const visibility = await target.evaluate((element) => {
    const style = (element as HTMLElement).style;
    const previous = style.visibility;
    style.visibility = 'hidden';
    return previous;
  });
  const hidden = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  await target.evaluate((element, previous) => {
    (element as HTMLElement).style.visibility = previous;
  }, visibility);

  const ink = await page.evaluate(
    async ({ shownPng, hiddenPng }): Promise<DevicePixelBox | null> => {
      const decode = async (base64: string): Promise<ImageData> => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D context for ink decoding');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [before, after] = await Promise.all([decode(shownPng), decode(hiddenPng)]);
      const { width, height } = before;
      const change = new Float32Array(width * height);
      let strongest = 0;
      for (let index = 0; index < width * height; index += 1) {
        const offset = index * 4;
        const value = Math.max(
          Math.abs(before.data[offset]! - after.data[offset]!),
          Math.abs(before.data[offset + 1]! - after.data[offset + 1]!),
          Math.abs(before.data[offset + 2]! - after.data[offset + 2]!),
        );
        change[index] = value;
        strongest = Math.max(strongest, value);
      }
      if (strongest === 0) return null;
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (change[y * width + x]! < strongest / 2) continue;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
        }
      }
      return { top, bottom, left, right, imageWidth: width };
    },
    { shownPng: shown.toString('base64'), hiddenPng: hidden.toString('base64') },
  );
  if (!ink) throw new Error('The target paints nothing inside the area');

  const scale = ink.imageWidth / clip.width;
  const offsetX = clip.x - box.x;
  const offsetY = clip.y - box.y;
  const top = ink.top / scale + offsetY;
  const bottom = ink.bottom / scale + offsetY;
  const left = ink.left / scale + offsetX;
  const right = ink.right / scale + offsetX;
  return { top, bottom, left, right, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}
