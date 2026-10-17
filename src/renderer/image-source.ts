/** WebViews must not load local file URLs directly; use the desktop bridge. */
export function resolveDisplayImage(source: string, readLocal: (source: string) => Promise<string>): Promise<string> {
  if (/^https?:\/\/|^data:image\//i.test(source)) return Promise.resolve(source)
  if (/^file:\/\/|^\/|^[a-z]:[\\/]|^\\\\/i.test(source)) return readLocal(source)
  return Promise.reject(new Error('图片地址无效'))
}
