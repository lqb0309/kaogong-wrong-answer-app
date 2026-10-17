/** Runs in the unprivileged Fenbi page; keep this function self-contained. */
export function readFenbiReportPage() {
  const clean = (value: string | null | undefined) => (value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const text = (node: Element | null) => clean((node as HTMLElement | null)?.innerText || node?.textContent)
  const imageUrl = (img: HTMLImageElement) => {
    const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || ''
    try { const url = new URL(src, location.href); return src && /^https?:$/.test(url.protocol) ? url.href : '' } catch { return '' }
  }
  const images = (node: Element) => [...new Set(Array.from(node.querySelectorAll('img')).map(img => imageUrl(img)).filter(Boolean))]
  // Preserve paragraph and formula order without importing external HTML/scripts.
  const richText = (root: Element, includeImages = true) => {
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
      if (!(node instanceof Element) || /^(SCRIPT|STYLE|BUTTON|INPUT|TEXTAREA)$/.test(node.tagName)) return ''
      if (node.tagName === 'IMG') {
        if (!includeImages) return ''
        const src = imageUrl(node as HTMLImageElement)
        return src ? `![解析图片](<${src}>)` : ''
      }
      if (node.tagName === 'BR') return '\n'
      const value = Array.from(node.childNodes).map(walk).join('')
      return /^(P|DIV|ARTICLE|LI|SECTION|H[1-6])$/.test(node.tagName) ? value + '\n' : value
    }
    return clean(walk(root))
  }
  const materials = Array.from(document.querySelectorAll('app-materials'))
  const nodes = Array.from(document.querySelectorAll('app-solution-choice'))
  const ordered = [...materials, ...nodes].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  let materialIndex = 0
  const membership = new Map<Element, number>()
  for (const node of ordered) {
    if (node.tagName.toLowerCase() === 'app-materials') materialIndex++
    else membership.set(node, materialIndex)
  }
  const letter = (value: string) => /^[A-H]+$/.test(value.replace(/[\s、,，]/g, '')) ? value.replace(/[\s、,，]/g, '').split('').sort().join('') : ''
  const questions = nodes.map((node, index) => {
    const root = node.querySelector('.question-choice-container') || node.querySelector('app-question-choice')
    const choices = Array.from(root?.querySelectorAll('.choice-radio,.choice-checkbox') || [])
    const options = choices.map(choice => {
      const key = letter(text(choice.querySelector('.input-radio,.input-checkbox')))
      const content = choice.querySelector('.input-text,app-format-html')
      const clone = choice.cloneNode(true) as Element
      clone.querySelectorAll('.input-radio,.input-checkbox,input').forEach(el => el.remove())
      return { key, text: text(content || clone) }
    }).filter(option => option.key)
    const optionImages = Object.fromEntries(choices.map(choice => [letter(text(choice.querySelector('.input-radio,.input-checkbox'))), images(choice)]).filter(([key, urls]) => key && (urls as string[]).length)) as Record<string, string[]>
    const optionSet = new Set(Object.values(optionImages).flat())
    const questionImages = root ? images(root).filter(url => !optionSet.has(url)) : []
    const stemClone = root?.cloneNode(true) as Element | undefined
    stemClone?.querySelectorAll('app-choice-radio,app-choice-checkbox,.choice-radios,.choice-checkboxs').forEach(el => el.remove())
    const overall = node.querySelector('app-solution-overall,.question-overall-container') || node
    const correctAnswer = letter(text(overall.querySelector('.correct-answer')))
    const explicitAnswer = overall.querySelector('.your-answer')
    const selected = choices.filter(choice => !!choice.querySelector('input:checked'))
      .map(choice => letter(text(choice.querySelector('.input-radio,.input-checkbox')))).join('')
    const markedCorrect = choices.filter(choice => !!choice.querySelector('.input-radio.correct,.input-checkbox.correct'))
      .map(choice => letter(text(choice.querySelector('.input-radio,.input-checkbox')))).join('')
    const answerTime = text(overall.querySelector('.answer-time'))
    // Correct answers hide .your-answer in the new UI. Infer only from a
    // selected/explicitly correct option, never from absence or answer time alone.
    const userAnswer = explicitAnswer ? letter(text(explicitAnswer)) : answerTime ? letter(selected || markedCorrect) : ''
    const full = text(node)
    const sections = Array.from(node.querySelectorAll('.result-common-section'))
    const section = (names: string[]) => sections.find(el => names.includes(text(el.querySelector('app-solution-title,.solution-title')).replace(/[：:]$/, '')))
    const sectionText = (names: string[], withImages = false) => {
      const el = section(names)
      if (!el) return ''
      if (!withImages) {
        const heading = text(el.querySelector('app-solution-title,.solution-title'))
        return clean(text(el).replace(heading, '').replace(/^[：:]\s*/, ''))
      }
      const clone = el.cloneNode(true) as Element
      clone.querySelectorAll('app-solution-title,.solution-title,app-solution-video,app-solution-audio').forEach(child => child.remove())
      return richText(clone, withImages)
    }
    const lines = full.split('\n').map(clean).filter(Boolean)
    const legacySection = (names: string[], stops: string[]) => {
      const start = lines.findIndex(line => names.includes(line.replace(/[：:]$/, '')))
      if (start < 0) return ''
      const end = lines.findIndex((line, i) => i > start && stops.includes(line.replace(/[：:]$/, '')))
      return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
    }
    const analysisNode = section(['解析', '答案解析']) || node.querySelector('app-solution-analysis,app-analysis,.solution-analysis,.solution-analyse,.analysis-content,.answer-analysis')
    const analysis = sectionText(['解析', '答案解析'], true) || (analysisNode ? richText(analysisNode) : legacySection(['解析', '答案解析'], ['考点', '来源', '笔记', '收藏']))
    return {
      index: index + 1, materialIndex: membership.get(node) || 0,
      stem: stemClone ? richText(stemClone, false) : '', options, correctAnswer, userAnswer,
      isWrong: correctAnswer && userAnswer ? correctAnswer !== userAnswer : null,
      answerEvidence: explicitAnswer ? (userAnswer ? 'explicit' : 'unanswered') : selected ? 'selected' : markedCorrect ? 'correct-option' : 'missing',
      analysis, analysisImages: analysisNode ? images(analysisNode) : [],
      keypoints: (sectionText(['考点']) || legacySection(['考点'], ['来源', '笔记', '收藏', '解析', '答案解析'])).split('\n').map(clean).filter(Boolean),
      source: sectionText(['来源']) || legacySection(['来源'], ['笔记', '收藏', '解析', '答案解析', '考点']),
      answerTime, correctRate: text(overall.querySelector('.correct-rate')), errorProne: text(overall.querySelector('.error-prone')),
      questionType: /多选题/.test(full) ? '多选题' : '单选题', questionImages, optionImages
    }
  })
  // Restrict aggregate counts to the report header, never match question prose.
  const headerClone = document.body.cloneNode(true) as Element
  headerClone.querySelectorAll('app-materials,app-solution-choice,app-result-common,script,style').forEach(el => el.remove())
  const header = richText(headerClone, false).replace(/\s+/g, ' ')
  const numberAfter = (label: string) => {
    const match = header.match(new RegExp(label + '\\s*(\\d+)\\s*(?:题|道)'))
    return match ? Number(match[1]) : null
  }
  const difficultyMatch = text(document.body).match(/难度(?:系数)?\s*[:：]?\s*(\d(?:\.\d+)?)/)
  return {
    title: document.title || '粉笔练习报告', url: location.href,
    materials: materials.map((node, index) => ({ index: index + 1, text: text(node), images: images(node) })), questions,
    difficulty: difficultyMatch ? Number(difficultyMatch[1]) : null,
    summary: { total: numberAfter('共计'), correct: numberAfter('答对'), wrong: numberAfter('答错'), unanswered: numberAfter('未答') }
  }
}

/** Also called on the main-process boundary, not just in the page. */
export function validateFenbiReport(raw: any): string | null {
  if (!Array.isArray(raw?.questions) || !raw.questions.length || raw.questions.length > 500) return '没有读取到有效题目，请确认已登录并打开已完成练习报告'
  const questions = raw.questions as any[]
  if (questions.some(q => !q || (!q.stem && !q.questionImages?.length) || !Array.isArray(q.options) || !q.options.length || q.options.some((o: any) => !o || (!o.text && !q.optionImages?.[o.key]?.length)))) return '题干或选项尚未完整加载，请等待报告加载完成后重试'
  if (questions.some(q => q.isWrong === null || !q.correctAnswer || !q.userAnswer)) return '报告中有题目尚未取得个人答案或正确答案（可能未答或加载未完成），未计入完成情况'
  if (questions.some(q => typeof q.isWrong !== 'boolean' || !/^[A-H]+$/.test(q.correctAnswer) || !/^[A-H]+$/.test(q.userAnswer) || q.isWrong !== (q.correctAnswer !== q.userAnswer))) return '报告答案字段相互矛盾，暂不导入'
  const summary = raw.summary
  if (summary?.total != null && summary.total !== questions.length) return `报告显示 ${summary.total} 题，实际读取 ${questions.length} 题，暂不导入不完整报告`
  const correct = questions.filter(q => q.isWrong === false).length
  const wrong = questions.filter(q => q.isWrong === true).length
  if ((summary?.correct != null && summary.correct !== correct) || (summary?.wrong != null && summary.wrong !== wrong) || (summary?.unanswered != null && summary.unanswered !== 0)) return '读取的答对、答错或未答数量与粉笔报告不一致，暂不导入'
  return null
}

export function readFenbiPageReadiness() {
  const body = (document.body?.innerText || '').replace(/\s+/g, ' ')
  const history = /\/report\/profile\/.*\/history/.test(location.href)
  const report = /\/ti\/exam\/solution\//.test(location.href)
  const loginRequired = /登录后可以|登录\/注册|请先登录|登录后查看/.test(body)
  return {
    loginRequired,
    ready: !loginRequired && document.readyState !== 'loading' && (
      history ? /共\s*\d+\s*题[，,]?\s*答对\s*\d+\s*题|暂无(?:练习|记录|数据)|没有(?:练习|记录)/.test(body)
        : report ? !!document.querySelector('app-solution-choice .choice-radio,app-solution-choice .choice-checkbox') : false
    )
  }
}
