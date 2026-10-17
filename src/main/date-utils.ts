import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
dayjs.extend(utc)

/** Business-day key in the user's local timezone. */
export function localDateKey(date: Date | dayjs.Dayjs = dayjs()): string {
  return dayjs(date).utcOffset(8).format('YYYY-MM-DD')
}

export function localDateTime(date: Date | dayjs.Dayjs = dayjs()): string {
  return dayjs(date).utcOffset(8).format('YYYY-MM-DDTHH:mm:ss.SSSZ')
}
