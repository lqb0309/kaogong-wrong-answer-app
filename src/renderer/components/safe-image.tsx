import { useEffect, useState } from 'react'
import { Image, type ImageProps } from 'antd'
import { resolveDisplayImage } from '../image-source'

const placeholder = (text: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#f5f5f5"/><text x="80" y="62" font-size="12" text-anchor="middle" fill="#999">${text}</text></svg>`
)
const loadingImage = placeholder('图片加载中')
const failedImage = placeholder('图片无法读取')

/** Shared previews work in Electron, development HTTP and Tauri without file: CSP access. */
export function SafeImage({ src = '', preview, fallback, ...props }: ImageProps) {
  const [loaded, setLoaded] = useState({ source: '', value: '', failed: false })
  useEffect(() => {
    let active = true
    resolveDisplayImage(src, source => window.api.readImageDataUrl(source))
      .then(value => { if (active) setLoaded({ source: src, value, failed: false }) })
      .catch(() => { if (active) setLoaded({ source: src, value: '', failed: true }) })
    return () => { active = false }
  }, [src])
  const current = loaded.source === src ? loaded : null
  const value = /^https?:\/\/|^data:image\//i.test(src) ? src : current?.value
  return <Image {...props} src={value || (current?.failed ? failedImage : loadingImage)}
    fallback={fallback || failedImage} preview={value ? preview : false} />
}
