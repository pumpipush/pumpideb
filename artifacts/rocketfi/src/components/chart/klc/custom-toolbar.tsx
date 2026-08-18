/**
 * custom-toolbar.tsx — TradingView Advanced Charts style top toolbar
 *
 * Layout (matches TV exactly):
 *   LEFT:  [TF pills: 1m 5m 15m 1H 4H D W  ▾more] | [candle▾] | [Price|MCap]
 *   RIGHT: [Indicators] [Settings] [Camera] [Fullscreen]
 */
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
      setPanelStyle({ position: 'fixed', top: 46, left: 4, right: 4, zIndex: 99999 })
    } else {
      setPanelStyle({
        position: 'fixed',
        top: Math.round(r.bottom) + 4,
        left: Math.round(r.left),
        minWidth: 140,
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

const CANDLE_TYPES: { type: CandleType; label: string; icon: React.FC }[] = [
  {
    type: 'candle_solid',
    label: 'Candles',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <line x1="4"  y1="1" x2="4"  y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="2" y="3.5" width="4" height="6" fill="currentColor" rx="0.4"/>
        <line x1="4"  y1="9.5" x2="4"  y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="2"  x2="12" y2="5"   stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="10" y="5"   width="4" height="7" fill="currentColor" rx="0.4"/>
        <line x1="12" y1="12" x2="12" y2="15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'candle_stroke',
    label: 'Hollow candles',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <line x1="4"  y1="1" x2="4"  y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="2" y="3.5" width="4" height="6" stroke="currentColor" strokeWidth="1.2" fill="none" rx="0.4"/>
        <line x1="4"  y1="9.5" x2="4"  y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="2"  x2="12" y2="5"   stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="10" y="5"   width="4" height="7" stroke="currentColor" strokeWidth="1.2" fill="none" rx="0.4"/>
        <line x1="12" y1="12" x2="12" y2="15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'ohlc',
    label: 'Bars',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <line x1="4"  y1="2"  x2="4"  y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="1.5" y1="8" x2="4"  y2="8"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="4"   y1="5" x2="6.5" y2="5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="1"  x2="12" y2="14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="9.5"  y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="10" x2="14.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'area',
    label: 'Area',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <path d="M1 12 L3.5 7 L6.5 9.5 L10 4.5 L14 7.5 L15.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
        <path d="M1 12 L3.5 7 L6.5 9.5 L10 4.5 L14 7.5 L15.5 6 L15.5 14 L1 14Z" fill="currentColor" opacity="0.18"/>
      </svg>
    ),
  },
  {
    type: 'candle_up_stroke',
    label: 'Hollow up / Filled down',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <line x1="4"  y1="1" x2="4"  y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="2" y="3.5" width="4" height="6" stroke="currentColor" strokeWidth="1.2" fill="none" rx="0.4"/>
        <line x1="4"  y1="9.5" x2="4"  y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="2"  x2="12" y2="5"   stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="10" y="5"   width="4" height="7" fill="currentColor" rx="0.4"/>
        <line x1="12" y1="12" x2="12" y2="15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'candle_down_stroke',
    label: 'Filled up / Hollow down',
    icon: () => (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <line x1="4"  y1="1" x2="4"  y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="2" y="3.5" width="4" height="6" fill="currentColor" rx="0.4"/>
        <line x1="4"  y1="9.5" x2="4"  y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="12" y1="2"  x2="12" y2="5"   stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <rect x="10" y="5"   width="4" height="7" stroke="currentColor" strokeWidth="1.2" fill="none" rx="0.4"/>
        <line x1="12" y1="12" x2="12" y2="15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
]

// ── Period definitions ────────────────────────────────────────────────────────

export type PriceMode = 'price' | 'mcap'

export interface Period {
  multiplier: number
  timespan: string
  text: string
  label: string
}

// Periods shown as inline pills in the toolbar
const INLINE_PERIODS: Period[] = [
  { multiplier: 1,  timespan: 'minute', text: '1m',  label: '1 minute'   },
  { multiplier: 5,  timespan: 'minute', text: '5m',  label: '5 minutes'  },
  { multiplier: 15, timespan: 'minute', text: '15m', label: '15 minutes' },
]

// All other periods live in the dropdown
const MORE_PERIOD_GROUPS = [
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
    key: 'days', label: 'DAYS / WEEKS / MONTHS',
    periods: [
      { multiplier: 1, timespan: 'day',   text: 'D', label: '1 day'   },
      { multiplier: 1, timespan: 'week',  text: 'W', label: '1 week'  },
      { multiplier: 1, timespan: 'month', text: 'M', label: '1 month' },
    ],
  },
]

export const ALL_PERIODS: Period[] = [
  ...INLINE_PERIODS,
  ...MORE_PERIOD_GROUPS.flatMap(g => g.periods),
]

export const DEFAULT_PERIOD: Period = INLINE_PERIODS[0]   // 1m

// ── SVG icons ─────────────────────────────────────────────────────────────────

const IconChevronDown = () => (
  <svg width="11" height="11" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 3L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const IconIndicators = () => (
  <svg width="26" height="16" viewBox="0 0 26 16" fill="none">
    <text
      x="1" y="13"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontSize="14"
      fontStyle="italic"
      fontWeight="700"
      fill="currentColor"
      letterSpacing="-0.5"
    >f</text>
    <text
      x="10" y="13"
      fontFamily="'Trebuchet MS', Arial, sans-serif"
      fontSize="13"
      fontWeight="700"
      fill="currentColor"
    >x</text>
  </svg>
)
const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
    <path
      d="M6.5 1.8L6.1 3.3A5 5 0 0 0 4.8 4L3.3 3.4L1.8 6L2.9 7.1A5.1 5.1 0 0 0 2.9 8.9L1.8 10L3.3 12.6L4.8 12A5 5 0 0 0 6.1 12.7L6.5 14.2H9.5L9.9 12.7A5 5 0 0 0 11.2 12L12.7 12.6L14.2 10L13.1 8.9A5.1 5.1 0 0 0 13.1 7.1L14.2 6L12.7 3.4L11.2 4A5 5 0 0 0 9.9 3.3L9.5 1.8Z"
      stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"
    />
    <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.25"/>
  </svg>
)
const IconScreenshot = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="3.5" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
    <circle cx="8" cy="8.5" r="2.3" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M5.5 3.5L6.3 2H9.7L10.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="11.5" y="5.5" width="1.2" height="0.9" rx="0.4" fill="currentColor"/>
  </svg>
)
const IconFullscreen = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
    <path d="M2 5.5V2.5H5M11 2.5H14V5.5M14 10.5V13.5H11M5 13.5H2V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ── Candle type selector ──────────────────────────────────────────────────────

function CandleTypeSelector({
  candleType, onCandleTypeChange,
}: { candleType: CandleType; onCandleTypeChange: (t: CandleType) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = CANDLE_TYPES.find(c => c.type === candleType) ?? CANDLE_TYPES[0]

  return (
    <>
      <button
        ref={btnRef}
        className="ctb-icon-btn"
        style={{ width: 'auto', padding: '0 4px', gap: 3, display: 'flex', alignItems: 'center' }}
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

// ── "More periods" dropdown ───────────────────────────────────────────────────

function MorePeriodsDropdown({
  period, onPeriodChange,
}: { period: Period; onPeriodChange: (p: Period) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const isActivePeriodInMore = !INLINE_PERIODS.some(p => p.text === period.text)

  return (
    <>
      <button
        ref={btnRef}
        className={`ctb-tf-pill${open ? ' open' : ''}${isActivePeriodInMore ? ' active-period' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="More timeframes"
      >
        {isActivePeriodInMore ? period.text : '···'}
        <IconChevronDown />
      </button>
      <DropdownPortal triggerRef={btnRef} open={open} onClose={() => setOpen(false)}>
        <div className="ctb-dd-panel" style={{ position: 'static' }}>
          {MORE_PERIOD_GROUPS.map(group => (
            <div key={group.key}>
              <div className="ctb-dd-group-hdr" style={{ cursor: 'default' }}>
                {group.label}
              </div>
              {group.periods.map(p => (
                <button
                  key={p.text}
                  className={`ctb-dd-row${p.text === period.text ? ' active' : ''}`}
                  onClick={() => { onPeriodChange(p); setOpen(false) }}
                >
                  {p.label}
                </button>
              ))}
            </div>
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

// ── Main component ────────────────────────────────────────────────────────────

export function CustomToolbar({
  period, onPeriodChange,
  priceMode, onPriceModeChange,
  candleType, onCandleTypeChange,
  onIndicatorClick, onSettingsClick, onScreenshotClick, onFullscreenClick,
}: Props) {

  return (
    <div className="ctb-root">
      {/* ── Left: inline TF pills + candle type ── */}
      <div className="ctb-left">

        {/* Inline timeframe pills */}
        <div className="ctb-tf-group">
          {INLINE_PERIODS.map(p => (
            <button
              key={p.text}
              className={`ctb-tf-pill${p.text === period.text ? ' active-period' : ''}`}
              onClick={() => onPeriodChange(p)}
              title={p.label}
            >
              {p.text}
            </button>
          ))}
          <MorePeriodsDropdown period={period} onPeriodChange={onPeriodChange} />
        </div>

        <div className="ctb-sep" />

        {/* Candle type */}
        <CandleTypeSelector candleType={candleType} onCandleTypeChange={onCandleTypeChange} />

        <div className="ctb-sep" />

        {/* Indicators — moved to left side (TV style) */}
        <button className="ctb-icon-btn" onClick={onIndicatorClick} title="Indicators">
          <IconIndicators />
          <span className="ctb-icon-label">Indicators</span>
        </button>

        <div className="ctb-sep" />

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

      {/* ── Right: icon actions ── */}
      <div className="ctb-right">
        <button className="ctb-icon-btn" onClick={onSettingsClick} title="Settings">
          <IconSettings />
        </button>
        <button className="ctb-icon-btn" onClick={onScreenshotClick} title="Screenshot">
          <IconScreenshot />
        </button>
        <button className="ctb-icon-btn" onClick={onFullscreenClick} title="Full screen">
          <IconFullscreen />
        </button>
      </div>
    </div>
  )
}
