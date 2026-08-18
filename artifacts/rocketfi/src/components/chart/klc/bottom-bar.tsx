import { useEffect, useState } from 'react'

const IconCalendar = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="1" y="2.5" width="12" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
    <line x1="1" y1="5.5" x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.3"/>
    <line x1="4.5" y1="1" x2="4.5" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <line x1="9.5" y1="1" x2="9.5" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
)

export type YAxisMode = 'normal' | 'percentage' | 'log'

const RANGES = ['1D', '5D', '1M', '3M', '1Y'] as const
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
        <button className="bbar-icon" title="Custom range">
          <IconCalendar />
        </button>
      </div>

      <div className="bbar-right">
        <span className="bbar-clock">{utcTime}</span>
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
      </div>
    </div>
  )
}
