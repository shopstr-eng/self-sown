declare module "sharp" {
  interface SharpOptions {
    limitInputPixels?: number | boolean;
  }

  interface ResizeOptions {
    width?: number;
    height?: number;
    fit?: "contain" | "cover" | "fill" | "inside" | "outside";
    withoutEnlargement?: boolean;
  }

  interface Sharp {
    rotate(): Sharp;
    resize(options: ResizeOptions): Sharp;
    png(): Sharp;
    webp(options?: { quality?: number }): Sharp;
    jpeg(options?: { quality?: number; mozjpeg?: boolean }): Sharp;
    flatten(options?: { background?: string }): Sharp;
    metadata(): Promise<{
      format?: string;
      width?: number;
      height?: number;
      hasAlpha?: boolean;
    }>;
    toBuffer(): Promise<Buffer>;
  }

  function sharp(
    input?:
      | string
      | Buffer
      | Uint8Array
      | {
          create: {
            width: number;
            height: number;
            channels: 1 | 2 | 3 | 4;
            background: unknown;
            noise?: unknown;
          };
        },
    options?: SharpOptions
  ): Sharp;

  export default sharp;
}
