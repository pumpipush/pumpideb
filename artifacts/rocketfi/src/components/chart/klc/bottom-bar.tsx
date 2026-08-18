/**
 * bottom-bar.tsx — TradingView-style bottom navigation bar
 *
 * Desktop: inline range pills  [1D] [5D] [1M] … [All] [📅]  |  [%] [log] [auto]  |  15:21:59 UTC
 * Mobile:  [Date Range ▾]  |  [%] [log] [auto]  |  UTC clock
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconCalendar = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <rect x="0.65" y="1.95" width="11.7" height="10.4" rx="1.3" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="0.65" y1="5" x2="12.35" y2="5" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="3.9" y1="0.65" x2="3.9" y2="3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    <line x1="9.1" y1="0.65" x2="9.1" y2="3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
)

const IconChevronDown = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 3L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ── Types ─────────────────────────────────────────────────────────────────────

export type YAxisMode = 'normal' | 'percentage' | 'log'

const RANGES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All'] as const
export type RangeKey = typeof RANGES[number]

interface Props {
  yAxisMode: YAxisMode
  onYAxisModeChange: (m: YAxisMode) => void
  autoScale: boolean
  onAutoScaleChange: (v: boolean) => void
  activeRange: RangeKey | null
  onRangeChange: (r: RangeKey) => void
}

// ── Mobile dropdown portal ────────────────────────────────────────────────────

function RangeDropdown({
  triggerRef,
  open,
  onClose,
  activeRange,
  onRangeChange,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  open: boolean
  onClose: () => void
  activeRange: RangeKey | null
  onRangeChange: (r: RangeKey) => void
}) {
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setStyle({
      position: 'fixed',
      bottom: window.innerHeight - r.top + 4,
      left: r.left,
      zIndex: 99999,
    })
  }, [open])

  if (!open) return null
  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onPointerDown={onClose} />
      <div className="bbar-range-dropdown" style={style}>
        {RANGES.map(r => (
          <button
            key={r}
            className={`bbar-range-dd-item${activeRange === r ? ' active' : ''}`}
            onClick={() => { onRangeChange(r); onClose() }}
          >
            {r}
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BottomBar({
  yAxisMode, onYAxisModeChange,
  autoScale, onAutoScaleChange,
  activeRange, onRangeChange,
}: Props) {
  const [utcTime, setUtcTime] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: tz, timeZoneName: 'short',
    })
    const tick = () => setUtcTime(fmt.format(new Date()).replace('GMT', 'UTC'))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bbar-root">
      {/* ── Left: desktop = pills, mobile = dropdown ── */}
      <div className="bbar-left">

        {/* Desktop pills */}
        <div className="bbar-pills-desktop">
          {RANGES.map(r => (
            <button
              key={r}
              className={`bbar-range${activeRange === r ? ' active' : ''}`}
              onClick={() => onRangeChange(r)}
            >
              {r}
            </button>
          ))}
          <button className="bbar-icon" title="Go to date">
            <IconCalendar />
          </button>
        </div>

        {/* Mobile dropdown trigger */}
        <button
          ref={dropdownTriggerRef}
          className={`bbar-range-btn${dropdownOpen ? ' open' : ''}${activeRange ? ' has-selection' : ''}`}
          onClick={() => setDropdownOpen(o => !o)}
        >
          <IconCalendar />
          <span>{activeRange ?? 'Date Range'}</span>
          <IconChevronDown />
        </button>

        <RangeDropdown
          triggerRef={dropdownTriggerRef}
          open={dropdownOpen}
          onClose={() => setDropdownOpen(false)}
          activeRange={activeRange}
          onRangeChange={onRangeChange}
        />
      </div>

      {/* ── Right: UTC clock → scale toggles ── */}
      <div className="bbar-right">
        <span className="bbar-clock">{utcTime}</span>
        <div className="bbar-sep" />
        <button
          className={`bbar-toggle${yAxisMode === 'percentage' ? ' active' : ''}`}
          onClick={() => onYAxisModeChange(yAxisMode === 'percentage' ? 'normal' : 'percentage')}
          title="Percentage scale"
        >%</button>
        <button
          className={`bbar-toggle${yAxisMode === 'log' ? ' active' : ''}`}
          onClick={() => onYAxisModeChange(yAxisMode === 'log' ? 'normal' : 'log')}
          title="Log scale"
        >log</button>
        <button
          className={`bbar-toggle${autoScale ? ' active' : ''}`}
          onClick={() => onAutoScaleChange(!autoScale)}
          title="Auto scale"
        >auto</button>
      </div>
    </div>
  )
}
