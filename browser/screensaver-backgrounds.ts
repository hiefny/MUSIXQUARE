export interface BackgroundImageVariant {
  file: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  bytes: number;
}
export interface BackgroundImageSet {
  grainOpacity: number;
  variants: BackgroundImageVariant[];
}
/** Pre-rendered clock backdrop, one immutable image per viewport family. */
export const CLOCK_BACKGROUND: BackgroundImageSet = {
  grainOpacity: 0.62,
  variants: [
    {
      file: '/assets/screensaver/backgrounds/clock/portrait-71cc2063.webp',
      width: 390,
      height: 844,
      viewportWidth: 390,
      viewportHeight: 844,
      bytes: 10910,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/portrait-large-262d3ec2.webp',
      width: 888,
      height: 1920,
      viewportWidth: 888,
      viewportHeight: 1920,
      bytes: 35630,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/landscape-a76c08b3.webp',
      width: 844,
      height: 390,
      viewportWidth: 844,
      viewportHeight: 390,
      bytes: 12766,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/classic-0f20be57.webp',
      width: 1024,
      height: 768,
      viewportWidth: 1024,
      viewportHeight: 768,
      bytes: 23116,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/wide-0bfd91a0.webp',
      width: 1920,
      height: 1080,
      viewportWidth: 1920,
      viewportHeight: 1080,
      bytes: 48568,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/square-b928a4f9.webp',
      width: 1080,
      height: 1080,
      viewportWidth: 1080,
      viewportHeight: 1080,
      bytes: 29930,
    },
    {
      file: '/assets/screensaver/backgrounds/clock/tiny-5934eec5.webp',
      width: 160,
      height: 160,
      viewportWidth: 160,
      viewportHeight: 160,
      bytes: 1722,
    },
  ],
};
