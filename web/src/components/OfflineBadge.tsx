// Shown wherever numbers would be when the engine can't be reached: the screen
// keeps its layout and plan structure, every number reads "—". Reuses the
// dock's label pill (no new styles).
export function OfflineBadge({ title }: { title?: string }) {
  return (
    <span className="review__label" role="status" title={title ?? 'HeatTwin engine unreachable — no estimates shown'}>
      offline fallback
    </span>
  )
}
