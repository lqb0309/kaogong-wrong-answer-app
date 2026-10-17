import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

/** Local, dependency-free icons: one 24px grid and one rounded stroke weight. */
const shapes = {
  calendar: <><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17M7.5 14h3M7.5 17.5h6M16 14h.5" /></>,
  import: <><path d="M4 13.5 2.5 18v2a1 1 0 0 0 1 1h17a1 1 0 0 0 1-1v-2L20 13.5M3 17h5l1.5 2h5l1.5-2h5M12 3v10M8.5 9.5 12 13l3.5-3.5" /></>,
  review: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9M14 3v7h6L14 3M8 15l2.5 2.5L16 12" /></>,
  library: <><path d="M3 21h18M4 4h4v15H4zM8 6h4v13H8zM14 5l4-1 3.5 14-4 1zM5.5 8h1M9.5 10h1M15.5 9l2-.5" /></>,
  timer: <><circle cx="12" cy="14" r="7.5" /><path d="M9 2.5h6M12 2.5v4M18.5 6l1.5-1.5M12 14l3-4" /></>,
  chart: <><path d="M3.5 3.5v17h17M7.5 16v-5M12.5 16V7M17.5 16v-8" /></>,
  notebook: <><path d="M5.5 3.5h13a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM8 3.5v17M11.5 8h4.5M11.5 12H16M11.5 16h2.5M3 7h3M3 12h3M3 17h3" /></>,
  paper: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9M14 3v7h6L14 3M8 14h8M8 17.5h5" /></>,
  tag: <><path d="m3 12 9 9a1.5 1.5 0 0 0 2 0l7-7a1.5 1.5 0 0 0 0-2l-9-9H4a1 1 0 0 0-1 1v8Z" /><circle cx="7.5" cy="7.5" r="1" /></>,
  log: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h4M8 15l2 2 4-4" /></>,
  settings: <><path d="m9.5 3-.5 2-2 .9-1.8-.6-2 3.4 1.5 1.5v2.5L3.2 14l2 3.4 1.8-.5 2 .9.5 2.2h4.7l.5-2.2 2-.9 1.8.5 2-3.4-1.5-1.3v-2.5l1.5-1.5-2-3.4-1.8.6-2-.9-.5-2h-4.7Z" /><circle cx="12" cy="11.5" r="3" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  ai: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM19 3v4M17 5h4" /></>,
  wallet: <><path d="M20 8V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6M21 12h-5v5h5" /><circle cx="17.5" cy="14.5" r=".5" /></>,
  cloud: <><path d="M7 19H6a4.5 4.5 0 1 1 .5-9A6 6 0 0 1 18 8.5a5.3 5.3 0 0 1 1 10.5h-2M12 20v-8M9 15l3-3 3 3" /></>,
  learning: <><path d="m2.5 8 9.5-5 9.5 5L12 13l-9.5-5ZM6 10v7c4 3 8 3 12 0v-7M21.5 8v8" /></>,
  backup: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM8.5 12l2.5 2.5 4.5-5" /></>,
  sliders: <><path d="M4 6h4M12 6h8M4 12h10M18 12h2M4 18h3M11 18h9" /><circle cx="10" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6.5V12l3.5 2" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 17 4.5-4.5 3 3L15.5 11 21 17" /></>,
  book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15" /></>,
  refresh: <><path d="M20.5 9a8.7 8.7 0 0 0-15-3L3 9M3 4v5h5M3.5 15a8.7 8.7 0 0 0 15 3l2.5-3M21 20v-5h-5" /></>,
  edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L5 15l-1 5ZM13 21h8" /></>,
  external: <><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5M14 3h7v7M21 3 10 14" /></>,
  folder: <><path d="M3 9V5a1 1 0 0 1 1-1h5l2 3h8a1 1 0 0 1 1 1v2M3 20l-1-9h20l-2 9H3Z" /></>,
  delete: <><path d="M3 6h18M9 6V3h6v3M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  check: <path d="m4 12 5 5L20 6" />,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  left: <path d="m15 5-7 7 7 7" />,
  right: <path d="m9 5 7 7-7 7" />,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  forward: <path d="m14 5 7 7-7 7M21 12H3" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  bulb: <><path d="M8 17v-2a6 6 0 1 1 8 0v2H8ZM9 21h6M8 17h8" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  bolt: <path d="m13.5 2-10 12h7L9.5 22l11-13h-7l1-7Z" />
} satisfies Record<string, ReactNode>

export type StudyIconName = keyof typeof shapes
export interface StudyIconProps extends HTMLAttributes<HTMLSpanElement> {
  name: StudyIconName
  spin?: boolean
  rotate?: number
}

export const StudyIcon = forwardRef<HTMLSpanElement, StudyIconProps>(function StudyIcon(
  { name, spin = false, rotate = 0, className = '', style, ...props }, ref
) {
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby'])
  return (
    <span {...props} ref={ref} className={`anticon study-icon${spin ? ' study-icon-spin' : ''} ${className}`}
      style={style} role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} data-study-icon={name}>
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.75"
        strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true"
        style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}>{shapes[name]}</svg>
    </span>
  )
})

// Named aliases let existing pages keep their behavior while sharing the new artwork.
type IconProps = Omit<StudyIconProps, 'name'>
function icon(name: StudyIconName) {
  const Component = forwardRef<HTMLSpanElement, IconProps>((props, ref) => <StudyIcon {...props} ref={ref} name={name} />)
  Component.displayName = `StudyIcon(${name})`
  return Component
}
export const ScheduleOutlined = icon('calendar')
export const CalendarOutlined = icon('calendar')
export const HomeOutlined = icon('import')
export const InboxOutlined = icon('import')
export const ReviewInboxOutlined = icon('review')
export const DatabaseOutlined = icon('library')
export const ThunderboltOutlined = icon('bolt')
export const TimerOutlined = icon('timer')
export const BarChartOutlined = icon('chart')
export const BookOutlined = icon('notebook')
export const FileTextOutlined = icon('paper')
export const FilePdfOutlined = icon('paper')
export const TagsOutlined = icon('tag')
export const LogOutlined = icon('log')
export const SettingOutlined = icon('settings')
export const AppstoreOutlined = icon('grid')
export const ApiOutlined = icon('ai')
export const AiSparkOutlined = icon('ai')
export const WalletOutlined = icon('wallet')
export const CloudOutlined = icon('cloud')
export const ExperimentOutlined = icon('learning')
export const SafetyCertificateOutlined = icon('backup')
export const SlidersOutlined = icon('sliders')
export const ClockCircleOutlined = icon('clock')
export const PictureOutlined = icon('image')
export const FileImageOutlined = icon('image')
export const ReadOutlined = icon('book')
export const ReloadOutlined = icon('refresh')
export const SyncOutlined = icon('refresh')
export const EditOutlined = icon('edit')
export const ExportOutlined = icon('external')
export const FolderOpenOutlined = icon('folder')
export const DeleteOutlined = icon('delete')
export const PlusOutlined = icon('plus')
export const CheckOutlined = icon('check')
export const CloseOutlined = icon('close')
export const LeftOutlined = icon('left')
export const RightOutlined = icon('right')
export const ArrowLeftOutlined = icon('back')
export const ArrowRightOutlined = icon('forward')
export const SearchOutlined = icon('search')
export const BulbOutlined = icon('bulb')
export const AimOutlined = icon('target')
