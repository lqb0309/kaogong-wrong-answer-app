import { useEffect, useState } from 'react'
import { Button, Image } from 'antd'
import { FileImageOutlined } from './study-icons'

/** Local files are read through preload; file:// cannot be loaded by an HTTP renderer. */
export function ImportThumbnail({ imageUrl, localPath, text, title }: {
  imageUrl: string; localPath: string; text: string; title: string
}) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setSrc(''); setFailed(false)
    const resolve = async () => {
      const sources = [...new Set([localPath, imageUrl].filter(Boolean))]
      for (const source of sources) {
        try {
          const value = /^https?:|^data:/i.test(source) ? source : await window.api.readImageDataUrl(source)
          if (value) { if (!cancelled) setSrc(value); return }
        } catch { /* Try the original URL when a local cache is unavailable. */ }
      }
      if (!cancelled) setFailed(sources.length > 0)
    }
    void resolve()
    return () => { cancelled = true }
  }, [imageUrl, localPath, attempt])

  return <div className="import-thumbnail">
    {src && !failed ? <Image src={src} alt={title} width="100%" height="100%" style={{ objectFit: 'contain' }}
      preview={{ mask: '点击放大' }} onError={() => setFailed(true)} />
      : text ? <div className="import-text-preview" title={text}>{text}</div>
      : <div className="import-image-placeholder"><FileImageOutlined />
        <span>{failed ? '图片暂时无法读取' : imageUrl || localPath ? '图片读取中…' : '暂无题目内容'}</span>
        {failed && <Button size="small" type="link" onClick={() => setAttempt(value => value + 1)}>重试图片</Button>}
      </div>}
  </div>
}
