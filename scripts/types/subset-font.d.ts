declare module 'subset-font' {
  interface SubsetFontOptions {
    readonly targetFormat?: 'truetype';
  }

  type SubsetFont = (
    source: Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ) => Promise<Buffer>;

  const subsetFont: SubsetFont;
  export default subsetFont;
}
