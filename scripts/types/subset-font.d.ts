declare module 'subset-font' {
  interface SubsetFontOptions {
    readonly targetFormat?: 'truetype' | 'woff2';
    /** Keep every glyph reachable from the whole cmap; the text must then be null. */
    readonly keepAllGlyphs?: boolean;
    /** OpenType layout feature tags to keep; every feature when omitted. */
    readonly keepFeatures?: readonly string[];
    /** Name table IDs to keep beside the ones the subsetter keeps by default (1-6). */
    readonly preserveNameIds?: readonly number[];
  }

  type SubsetFont = (
    source: Uint8Array,
    text: string | null,
    options?: SubsetFontOptions,
  ) => Promise<Buffer>;

  const subsetFont: SubsetFont;
  export default subsetFont;
}
