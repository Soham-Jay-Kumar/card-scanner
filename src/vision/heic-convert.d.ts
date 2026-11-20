/** heic-convert ships no types. This covers the one call we make. */
declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: ArrayBufferLike | Uint8Array;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer | Uint8Array>;
}
