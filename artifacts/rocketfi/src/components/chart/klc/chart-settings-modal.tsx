/**
 * chart-settings-modal.tsx
 *
 * Custom professional settings panel — replaces KLC's built-in raw dialog.
 * Desktop: centered modal with backdrop.
 * Mobile:  bottom-sheet sliding up from the bottom edge.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChartSettings {
  lastPriceShow:        boolean
  highPriceShow:        boolean
  lowPriceShow:         boolean
  gridShow:             boolean
  reverseCoordinate:    boolean
  priceAxisType:        'normal' | 'percentage' | 'log'
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  lastPriceShow:        true,
  highPriceShow:        false,
  lowPriceShow:         false,
  gridShow:             true,
  reverseCoordinate:    false,
  priceAxisType:        'normal',
}

interface Props {
  open: boolean
  onClose: () => void
  settings: ChartSettings
  onChange: (s: ChartSettings) => void
  onRestoreDefaults: () => void
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      className={`cs-toggle${value ? ' on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="cs-toggle-thumb" />
    </button>
  )
}

function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="cs-row">
      <div className="cs-row-label">
        <span className="cs-label">{label}</span>
        {description && <span className="cs-desc">{description}</span>}
      </div>
      <div className="cs-row-control">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="cs-section">
      <div className="cs-section-title">{title}</div>
      {children}
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function ChartSettingsModal({ open, onClose, settings, onChange, onRestoreDefaults }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const set = <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) =>
    onChange({ ...settings, [key]: value })

  if (!open) return null

  return createPortal(
    <div className="cs-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cs-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Chart Settings">

        {/* Header */}
        <div className="cs-header">
          <span className="cs-title">Chart Settings</span>
          <button className="cs-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="cs-body">

          <Section title="Price Marks">
            <Row label="Last price line" description="Show a dashed line at the latest close price">
              <Toggle value={settings.lastPriceShow} onChange={v => set('lastPriceShow', v)} />
            </Row>
            <Row label="High price mark" description="Show the highest price label on the Y-axis">
              <Toggle value={settings.highPriceShow} onChange={v => set('highPriceShow', v)} />
            </Row>
            <Row label="Low price mark" description="Show the lowest price label on the Y-axis">
              <Toggle value={settings.lowPriceShow} onChange={v => set('lowPriceShow', v)} />
            </Row>
          </Section>

          <Section title="Grid">
            <Row label="Show grid lines" description="Horizontal and vertical reference lines">
              <Toggle value={settings.gridShow} onChange={v => set('gridShow', v)} />
            </Row>
          </Section>

          <Section title="Y-Axis">
            <Row label="Scale type" description="How prices are distributed on the Y-axis">
              <div className="cs-segmented">
                {(['normal', 'percentage', 'log'] as const).map(opt => (
                  <button
                    key={opt}
                    className={`cs-seg-btn${settings.priceAxisType === opt ? ' active' : ''}`}
                    onClick={() => set('priceAxisType', opt)}
                  >
                    {opt === 'normal' ? 'Normal' : opt === 'percentage' ? 'Percent' : 'Log'}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Reverse Y-axis" description="Flip the Y-axis so higher prices appear at the bottom">
              <Toggle value={settings.reverseCoordinate} onChange={v => set('reverseCoordinate', v)} />
            </Row>
          </Section>
        </div>

        {/* Footer */}
        <div className="cs-footer">
          <button className="cs-btn-ghost" onClick={onRestoreDefaults}>
            Restore defaults
          </button>
          <button className="cs-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
