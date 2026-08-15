import { useState, useEffect, useRef, useCallback } from 'react'
import { Modal, Button, Space } from 'antd'
import { UndoOutlined, RotateRightOutlined, RotateLeftOutlined, PlusOutlined, MinusOutlined } from '@ant-design/icons'

interface Props {
  open: boolean; imagePath: string
  onOk: (r: { rotation: number; crop: { x: number; y: number; width: number; height: number } | null }) => void
  onSkip: () => void; onCancel: () => void
}

export function CanvasCrop({ open, imagePath, onOk, onSkip, onCancel }: Props) {
  const [rotation, setRotation] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const [start, setStart] = useState({ x: 0, y: 0 })
  const [cur, setCur] = useState({ x: 0, y: 0 })
  const [crop, setCrop] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const origW = useRef(0); const origH = useRef(0)

  useEffect(() => {
    if (!open) return
    setRotation(0); setCrop(null)
    imgRef.current = null
    // Handle data URLs directly, file paths through IPC
    const loadImage = (src: string) => {
      const img = new Image()
      img.onload = () => {
        origW.current = img.naturalWidth; origH.current = img.naturalHeight
        imgRef.current = img; renderCanvas()
      }
      img.onerror = () => console.warn('CanvasCrop: failed to load image')
      img.src = src
    }
    if (imagePath.startsWith('data:')) {
      loadImage(imagePath)
    } else {
      window.api.readImageDataUrl(imagePath).then(loadImage).catch(() => {})
    }
  }, [open, imagePath])

  const renderCanvas = () => {
    const canvas = canvasRef.current; const img = imgRef.current
    if (!canvas || !img) return
    const ow = origW.current; const oh = origH.current
    // Canvas dimensions: swap if 90/270 rotation
    const rotated = rotation === 90 || rotation === 270
    const cw = rotated ? oh : ow
    const ch = rotated ? ow : oh
    // Scale to fit
    const maxW = Math.min(canvas.parentElement?.clientWidth || 700, cw)
    const maxH = 460
    let dw = cw, dh = ch
    if (dw > maxW) { dh = Math.round(dh * (maxW / dw)); dw = maxW }
    if (dh > maxH) { dw = Math.round(dw * (maxH / dh)); dh = maxH }
    canvas.width = dw; canvas.height = dh
    canvas.style.width = `${dw}px`; canvas.style.height = `${dh}px`
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, dw, dh)
    // Draw rotated: center, rotate, draw original at scaled size
    ctx.save(); ctx.translate(dw / 2, dh / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    const scaleX = dw / cw; const scaleY = dh / ch
    ctx.drawImage(img, -ow * scaleX / 2, -oh * scaleY / 2, ow * scaleX, oh * scaleY)
    ctx.restore()
    // Draw selection overlay
    if (crop) drawOverlay(ctx, crop, dw, dh, cw, ch)
    else if (drawing) drawOverlay(ctx, { x: start.x, y: start.y, width: cur.x - start.x, height: cur.y - start.y }, dw, dh, cw, ch)
  }

  const drawOverlay = (ctx: CanvasRenderingContext2D, r: { x: number; y: number; width: number; height: number }, dw: number, dh: number, cw: number, ch: number) => {
    const sx = r.x / cw * dw; const sy = r.y / ch * dh
    const sw = r.width / cw * dw; const sh = r.height / ch * dh
    const bx = Math.min(sx, sx + sw); const by = Math.min(sy, sy + sh)
    const bw = Math.abs(sw); const bh = Math.abs(sh)
    // dim outside
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(0, 0, dw, by); ctx.fillRect(0, by + bh, dw, dh - by - bh)
    ctx.fillRect(0, by, bx, bh); ctx.fillRect(bx + bw, by, dw - bx - bw, bh)
    // box border - thicker and brighter
    ctx.strokeStyle = '#1677ff'; ctx.lineWidth = 3; ctx.setLineDash([])
    ctx.strokeRect(bx, by, bw, bh)
    // inner highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1
    ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2)
  }

  useEffect(() => { renderCanvas() }, [rotation, crop, drawing, cur])

  // 坐标换算并钳制到图片边界（修复拖到边缘导致选区失效的问题）
  const getCanvasPos = (e: React.MouseEvent | React.PointerEvent) => {
    const c = canvasRef.current!; const r = c.getBoundingClientRect()
    const dw = c.width; const dh = c.height
    // Scale canvas coords to rotated-image-space pixels
    const rotated = rotation === 90 || rotation === 270
    const cw = rotated ? origH.current : origW.current
    const ch = rotated ? origW.current : origH.current
    let x = Math.round((e.clientX - r.left) / dw * cw)
    let y = Math.round((e.clientY - r.top) / dh * ch)
    x = Math.max(0, Math.min(x, cw))
    y = Math.max(0, Math.min(y, ch))
    return { x, y }
  }

  // 指针捕获：拖出画布边缘也能继续框选，只有松开鼠标才结束
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    setDrawing(true); setCrop(null)
    const p = getCanvasPos(e); setStart(p); setCur(p)
  }
  const rafRef = useRef(0)
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing) return
    // Throttle with requestAnimationFrame for smooth rendering
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      setCur(getCanvasPos(e))
      rafRef.current = 0
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawing) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    setDrawing(false)
    const sx = Math.min(start.x, cur.x); const sy = Math.min(start.y, cur.y)
    const sw = Math.abs(cur.x - start.x); const sh = Math.abs(cur.y - start.y)
    if (sw > 5 && sh > 5) setCrop({ x: sx, y: sy, width: sw, height: sh })
  }

  return (
    <Modal title="编辑图片" open={open} onCancel={onCancel} width={780}
      footer={<Space><Button icon={<UndoOutlined />} onClick={() => { setCrop(null); setRotation(0) }}>全部重置</Button><Button onClick={onSkip}>跳过编辑</Button><Button onClick={onCancel}>取消</Button><Button type="primary" onClick={() => onOk({ rotation, crop })}>确认</Button></Space>}
    >
      <Space style={{ marginBottom: 8 }} wrap>
        <Button size="small" icon={<RotateLeftOutlined />} onClick={() => setRotation((p) => (p + 270) % 360)}>左90°</Button>
        <Button size="small" icon={<RotateRightOutlined />} onClick={() => setRotation((p) => (p + 90) % 360)}>右90°</Button>
        <Button size="small" icon={<MinusOutlined />} onClick={() => setRotation((p) => (p - 1 + 360) % 360)} />
        <span style={{ color: '#1677ff', fontWeight: 500, minWidth: 52, textAlign: 'center' }}>{rotation}°</span>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setRotation((p) => (p + 1) % 360)} />
        <span style={{ color: crop ? '#1677ff' : '#999', fontSize: 12, fontWeight: crop || drawing ? 600 : 400 }}>
          {crop
            ? `✅ 已选区域 ${crop.width}×${crop.height}px（点击确认保存）`
            : drawing
              ? `📏 正在框选 ${Math.abs(cur.x - start.x)}×${Math.abs(cur.y - start.y)}px`
              : '🖱️ 在图片上拖拽框选图形区域（可拖到边缘）'}
        </span>
      </Space>
      <div style={{ background: '#181818', borderRadius: 8, display: 'flex', justifyContent: 'center' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
        />
      </div>
    </Modal>
  )
}
