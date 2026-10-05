import { devices } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import type { Device } from '@agon/spec';

/** Playwright device descriptors used for persona devices; both run on Chromium. */
export const DEVICE_DESCRIPTORS: Readonly<Record<Exclude<Device, 'desktop'>, string>> = {
  mobile: 'Pixel 7',
  tablet: 'Galaxy Tab S4',
};

const FALLBACK_VIEWPORTS: Readonly<
  Record<Exclude<Device, 'desktop'>, { width: number; height: number }>
> = {
  mobile: { width: 412, height: 839 },
  tablet: { width: 712, height: 1138 },
};

/**
 * Context options for a persona's device. Desktop uses the viewport from the target config; mobile
 * and tablet take the descriptor's viewport, user agent, scale factor and touch emulation instead,
 * because a phone persona must see a phone-sized page whatever the target's default viewport is.
 */
export function deviceContextOptions(
  device: Device,
  viewport: { width: number; height: number },
): BrowserContextOptions {
  if (device === 'desktop') return { viewport, isMobile: false, hasTouch: false };
  const descriptor = devices[DEVICE_DESCRIPTORS[device]];
  if (!descriptor) return { viewport: FALLBACK_VIEWPORTS[device], isMobile: true, hasTouch: true };
  return {
    viewport: descriptor.viewport,
    userAgent: descriptor.userAgent,
    deviceScaleFactor: descriptor.deviceScaleFactor,
    isMobile: descriptor.isMobile,
    hasTouch: descriptor.hasTouch,
  };
}
