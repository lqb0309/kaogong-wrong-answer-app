interface AnswerSummaryProps {
  answer?: Record<string, any> | null
}

/** Compact facts beneath the options; no inferred answer when source is missing. */
export function AnswerSummary({ answer }: AnswerSummaryProps) {
  if (!answer || (!answer.correct && !answer.user && !answer.answerTime)) return null
  const wrong = !!answer.correct && !!answer.user && answer.correct !== answer.user
  return <dl className="answer-summary">
    <div><dt>正确答案</dt><dd className="answer-correct">{answer.correct || '未取得'}</dd></div>
    <div><dt>你的答案</dt><dd className={wrong ? 'answer-wrong' : ''}>{answer.user || '未取得'}</dd></div>
    {answer.answerTime && <div><dt>原答题用时</dt><dd>{answer.answerTime}</dd></div>}
  </dl>
}
