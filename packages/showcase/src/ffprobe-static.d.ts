// ffprobe-static ships JavaScript only; the binary path is exposed as
// the CommonJS default export ({ path: string }).
declare module 'ffprobe-static' {
  const ffprobeStatic: { readonly path: string };
  export default ffprobeStatic;
}
