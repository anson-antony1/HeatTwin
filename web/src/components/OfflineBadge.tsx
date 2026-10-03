import { OFFLINE_LABEL } from '../offline/standIn'
import './OfflineBadge.css'

// Red badge on every number drawn from the in-browser stand-in (src/offline/).
// Shown only when the engine is unreachable.
export function OfflineBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`offline-badge ${compact ? 'offline-badge--compact' : ''}`} title={OFFLINE_LABEL} role="note">
      {compact ? 'OFFLINE FALLBACK' : OFFLINE_LABEL}
    </span>
  )
}

/** Banner across a view whose numbers come from the stand-in. */
export function OfflineBanner() {
  return (
    <div className="offline-banner" role="alert">
      <OfflineBadge />
      <span>
        The HeatTwin engine can’t be reached. The numbers on this screen come from an in-browser stand-in, not the
        validated model. Start the engine (<code>make dev</code>) and reload.
      </span>
    </div>
  )
}
