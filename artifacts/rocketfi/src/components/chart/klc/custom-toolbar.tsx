import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

// ── Portable dropdown panel ───────────────────────────────────────────────────

function DropdownPortal({
  triggerRef,
  open,
  onClose,
  children,
}: {
  triggerRef: React.RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const isMobile = window.innerWidth <= 640
    if (isMobile) {
      setPanelStyle({ position: 'fixed', top: 49, left: 4, right: 4, zIndex: 99999 })
    } else {
      setPanelStyle({
        position: 'fixed',
        top: Math.round(r.bottom) + 4,
        left: Math.round(r.left),
        minWidth: r.width,
        zIndex: 99999,
      })
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onPointerDown={onClose} />
      <div style={panelStyle}>{children}</div>
    </>,
    document.body,
  )
}

// ── Candle type definitions ───────────────────────────────────────────────────

export type CandleType =
  | 'candle_solid'
  | 'candle_stroke'
  | 'candle_up_stroke'
  | 'candle_down_stroke'
  | 'ohlc'
  | 'area'

export const CANDLE_TYPES: { type: CandleType; label: string; icon: React.FC }[] = [
  {
    type: 'candle_solid',
    label: 'Candles',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <line x1="5"  y1="1.5" x2="5"  y2="4"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="2.5" y="4"   width="5" height="7" fill="currentColor" rx="0.5"/>
        <line x1="5"  y1="11" x2="5"  y2="14"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="3"  x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="10.5" y="5.5" width="5" height="9" fill="currentColor" rx="0.5"/>
        <line x1="13" y1="14.5" x2="13" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'candle_stroke',
    label: 'Hollow candles',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <line x1="5"  y1="1.5" x2="5"  y2="4"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="2.5" y="4"   width="5" height="7" stroke="currentColor" strokeWidth="1.3" fill="none" rx="0.5"/>
        <line x1="5"  y1="11" x2="5"  y2="14"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="3"  x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="10.5" y="5.5" width="5" height="9" stroke="currentColor" strokeWidth="1.3" fill="none" rx="0.5"/>
        <line x1="13" y1="14.5" x2="13" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'candle_up_stroke',
    label: 'Hollow up / Filled down',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <line x1="5"  y1="1.5" x2="5"  y2="4"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="2.5" y="4"   width="5" height="7" stroke="currentColor" strokeWidth="1.3" fill="none" rx="0.5"/>
        <line x1="5"  y1="11" x2="5"  y2="14"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="3"  x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="10.5" y="5.5" width="5" height="9" fill="currentColor" rx="0.5"/>
        <line x1="13" y1="14.5" x2="13" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'candle_down_stroke',
    label: 'Filled up / Hollow down',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <line x1="5"  y1="1.5" x2="5"  y2="4"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="2.5" y="4"   width="5" height="7" fill="currentColor" rx="0.5"/>
        <line x1="5"  y1="11" x2="5"  y2="14"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="3"  x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <rect x="10.5" y="5.5" width="5" height="9" stroke="currentColor" strokeWidth="1.3" fill="none" rx="0.5"/>
        <line x1="13" y1="14.5" x2="13" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'ohlc',
    label: 'Bars',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <line x1="5"  y1="3"  x2="5"  y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="2.5" y1="9"  x2="5"  y2="9"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="5"  y1="6"  x2="7.5" y2="6"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="2"  x2="13" y2="15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="10.5" y1="8" x2="13" y2="8"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="13" y1="11" x2="15.5" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'area',
    label: 'Area',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M1 13 L4 8 L7 10 L11 5 L15 9 L17 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
        <path d="M1 13 L4 8 L7 10 L11 5 L15 9 L17 7 L17 15 L1 15Z" fill="currentColor" opacity="0.2"/>
      </svg>
    ),
  },
]

// ── SVG Icons ────────────────────────────────────────────────────────────────

const IconChevronDown = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IconChevronUp = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IconIndicators = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <rect x="2" y="10" width="2.5" height="6" rx="0.5" fill="currentColor"/>
    <rect x="6" y="6" width="2.5" height="10" rx="0.5" fill="currentColor"/>
    <rect x="10" y="3" width="2.5" height="13" rx="0.5" fill="currentColor"/>
    <rect x="14" y="7" width="2.5" height="9" rx="0.5" fill="currentColor"/>
    <line x1="1" y1="9" x2="17" y2="9" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/>
  </svg>
)
const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M9 1.5V3M9 15V16.5M16.5 9H15M3 9H1.5M14.7 3.3L13.6 4.4M4.4 13.6L3.3 14.7M14.7 14.7L13.6 13.6M4.4 4.4L3.3 3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)
const IconScreenshot = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <rect x="2" y="4" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
    <circle cx="9" cy="9.5" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M6.5 4L7.5 2.5H10.5L11.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="13" y="6" width="1.5" height="1" rx="0.5" fill="currentColor"/>
  </svg>
)
const IconFullscreen = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M2.5 6.5V3H6M12 3H15.5V6.5M15.5 11.5V15H12M6 15H2.5V11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ── Types ─────────────────────────────────────────────────────────────────────

export type PriceMode = 'price' | 'mcap'

export interface Period {
  multiplier: number
  timespan: string
  text: string
  label: string
}

const PERIOD_GROUPS = [
  {
    key: 'seconds', label: 'SECONDS',
    periods: [
      { multiplier: 1,  timespan: 'second', text: '1s',  label: '1 second'   },
      { multiplier: 15, timespan: 'second', text: '15s', label: '15 seconds' },
      { multiplier: 30, timespan: 'second', text: '30s', label: '30 seconds' },
    ],
  },
  {
    key: 'minutes', label: 'MINUTES',
    periods: [
      { multiplier: 1,  timespan: 'minute', text: '1m',  label: '1 minute'   },
      { multiplier: 5,  timespan: 'minute', text: '5m',  label: '5 minutes'  },
      { multiplier: 15, timespan: 'minute', text: '15m', label: '15 minutes' },
      { multiplier: 30, timespan: 'minute', text: '30m', label: '30 minutes' },
    ],
  },
  {
    key: 'hours', label: 'HOURS',
    periods: [
      { multiplier: 1,  timespan: 'hour', text: '1H',  label: '1 hour'   },
      { multiplier: 4,  timespan: 'hour', text: '4H',  label: '4 hours'  },
      { multiplier: 6,  timespan: 'hour', text: '6H',  label: '6 hours'  },
      { multiplier: 12, timespan: 'hour', text: '12H', label: '12 hours' },
    ],
  },
  {
    key: 'days', label: 'DAYS',
    periods: [
      { multiplier: 1, timespan: 'day',   text: 'D', label: '1 day'   },
      { multiplier: 1, timespan: 'week',  text: 'W', label: '1 week'  },
      { multiplier: 1, timespan: 'month', text: 'M', label: '1 month' },
    ],
  },
]

export const DEFAULT_PERIOD: Period = PERIOD_GROUPS[1].periods[0]  // 1 minute
export const ALL_PERIODS: Period[]  = PERIOD_GROUPS.flatMap(g => g.periods)

// ── Grouped Dropdown ──────────────────────────────────────────────────────────

function TimeframeDropdown({
  triggerRef, period, onPeriodChange, open, onClose,
}: {
  triggerRef: React.RefObject<HTMLElement | null>
  period: Period
  onPeriodChange: (p: Period) => void
  open: boolean
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggleGroup = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <DropdownPortal triggerRef={triggerRef} open={open} onClose={onClose}>
      <div className="ctb-dd-panel" style={{ position: 'static', boxShadow: '0 6px 24px rgba(0,0,0,0.7)' }}>
        {PERIOD_GROUPS.map(group => (
          <div key={group.key} className="ctb-dd-group">
            <button className="ctb-dd-group-hdr" onClick={() => toggleGroup(group.key)}>
              <span>{group.label}</span>
              {collapsed[group.key] ? <IconChevronDown /> : <IconChevronUp />}
            </button>
            {!collapsed[group.key] && group.periods.map(p => (
              <button
                key={p.text}
                className={`ctb-dd-row${p.text === period.text ? ' active' : ''}`}
                onClick={() => { onPeriodChange(p); onClose() }}
              >
                {p.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </DropdownPortal>
  )
}

// ── Candle Type Selector ──────────────────────────────────────────────────────

function CandleTypeSelector({
  candleType, onCandleTypeChange,
}: {
  candleType: CandleType
  onCandleTypeChange: (t: CandleType) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = CANDLE_TYPES.find(c => c.type === candleType) ?? CANDLE_TYPES[0]

  return (
    <>
      <button
        ref={btnRef}
        className={`ctb-ct-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Chart type"
      >
        <current.icon />
        <IconChevronDown />
      </button>
      <DropdownPortal triggerRef={btnRef} open={open} onClose={() => setOpen(false)}>
        <div className="ctb-ct-panel" style={{ position: 'static' }}>
          {CANDLE_TYPES.map(c => (
            <button
              key={c.type}
              className={`ctb-ct-item${c.type === candleType ? ' active' : ''}`}
              onClick={() => { onCandleTypeChange(c.type); setOpen(false) }}
            >
              <c.icon />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </DropdownPortal>
    </>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  period: Period
  onPeriodChange: (p: Period) => void
  priceMode: PriceMode
  onPriceModeChange: (m: PriceMode) => void
  candleType: CandleType
  onCandleTypeChange: (t: CandleType) => void
  onIndicatorClick: () => void
  onSettingsClick: () => void
  onScreenshotClick: () => void
  onFullscreenClick: () => void
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CustomToolbar({
  period, onPeriodChange,
  priceMode, onPriceModeChange,
  candleType, onCandleTypeChange,
  onIndicatorClick, onSettingsClick, onScreenshotClick, onFullscreenClick,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const tfBtnRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="ctb-root">
      {/* ── Left ── */}
      <div className="ctb-left">
        <button
          ref={tfBtnRef}
          className={`ctb-tf-btn${dropdownOpen ? ' open' : ''}`}
          onClick={() => setDropdownOpen(o => !o)}
        >
          <span className="ctb-tf-label">{period.text}</span>
        </button>

        <TimeframeDropdown
          triggerRef={tfBtnRef}
          period={period}
          onPeriodChange={onPeriodChange}
          open={dropdownOpen}
          onClose={() => setDropdownOpen(false)}
        />

        <CandleTypeSelector candleType={candleType} onCandleTypeChange={onCandleTypeChange} />

        <div className="ctb-divider" />

        {/* Price / MCap toggle */}
        <div className="ctb-toggle">
          <button
            className={`ctb-toggle-side${priceMode === 'price' ? ' active' : ''}`}
            onClick={() => onPriceModeChange('price')}
          >
            Price
          </button>
          <span className="ctb-toggle-sep">/</span>
          <button
            className={`ctb-toggle-side${priceMode === 'mcap' ? ' active' : ''}`}
            onClick={() => onPriceModeChange('mcap')}
          >
            MCap
          </button>
        </div>
      </div>

      {/* ── Right (icons) ── */}
      <div className="ctb-right">
        <button className="ctb-icon-btn" onClick={onIndicatorClick} title="Indicators">
          <IconIndicators />
        </button>
        <button className="ctb-icon-btn" onClick={onSettingsClick} title="Settings">
          <IconSettings />
        </button>
        <button className="ctb-icon-btn" onClick={onScreenshotClick} title="Screenshot">
          <IconScreenshot />
        </button>
        <button className="ctb-icon-btn" onClick={onFullscreenClick} title="Full Screen">
          <IconFullscreen />
        </button>
      </div>
    </div>
  )
}
