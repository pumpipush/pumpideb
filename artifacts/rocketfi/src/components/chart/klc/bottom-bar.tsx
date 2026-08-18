/**
 * bottom-bar.tsx — TradingView-style bottom navigation bar
 *
 * Layout matches TV exactly:
 *   LEFT:  [1D] [5D] [1M] [3M] [6M] [YTD] [1Y] [5Y] [All] [📅]
 *   RIGHT: [%] [log] [auto] | [UTC clock]
 */
import { useEffect, useState } from 'react'

const IconCalendar = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <rect x="0.65" y="1.95" width="11.7" height="10.4" rx="1.3" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="0.65" y1="5" x2="12.35" y2="5" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="3.9" y1="0.65" x2="3.9" y2="3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    <line x1="9.1" y1="0.65" x2="9.1" y2="3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
)

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

export function BottomBar({
  yAxisMode, onYAxisModeChange,
  autoScale, onAutoScaleChange,
  activeRange, onRangeChange,
}: Props) {
  const [utcTime, setUtcTime] = useState('')

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      const h = String(now.getUTCHours()).padStart(2, '0')
      const m = String(now.getUTCMinutes()).padStart(2, '0')
      const s = String(now.getUTCSeconds()).padStart(2, '0')
      setUtcTime(`${h}:${m}:${s} UTC`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bbar-root">
      {/* ── Left: date range pills ── */}
      <div className="bbar-left">
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

      {/* ── Right: scale toggles + UTC clock ── */}
      <div className="bbar-right">
        <button
          className={`bbar-toggle${yAxisMode === 'percentage' ? ' active' : ''}`}
          onClick={() => onYAxisModeChange(yAxisMode === 'percentage' ? 'normal' : 'percentage')}
          title="Percentage scale"
        >
          %
        </button>
        <button
          className={`bbar-toggle${yAxisMode === 'log' ? ' active' : ''}`}
          onClick={() => onYAxisModeChange(yAxisMode === 'log' ? 'normal' : 'log')}
          title="Log scale"
        >
          log
        </button>
        <button
          className={`bbar-toggle${autoScale ? ' active' : ''}`}
          onClick={() => onAutoScaleChange(!autoScale)}
          title="Auto scale"
        >
          auto
        </button>
        <div className="bbar-sep" />
        <span className="bbar-clock">{utcTime}</span>
      </div>
    </div>
  )
}
