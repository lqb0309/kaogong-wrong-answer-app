import dayjs from 'dayjs'

/** Business-day key in the user's local timezone. */
export function localDateKey(date: Date | dayjs.Dayjs = dayjs()): string {
  return dayjs(date).format('YYYY-MM-DD')
}

export function localDateTime(date: Date | dayjs.Dayjs = dayjs()): string {
  return dayjs(date).format('YYYY-MM-DDTHH:mm:ss.SSSZ')
}
