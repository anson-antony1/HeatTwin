import { overLineNow } from './data/selectors'
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { engine, useSession } from './data/engine'
import { useRoster } from './data/roster'
import { liveStore } from './data/liveStore'
import { Background, type Tone } from './components/Background'
import { Sidebar, type View } from './components/Sidebar'
import { DemoBar } from './components/DemoBar'
import { VoiceDock } from './components/VoiceDock'
import { planStore } from './data/planStore'
import { CoachDashboard } from './views/CoachDashboard'
import { AthleteView } from './views/AthleteView'
import { PlanView } from './views/PlanView'
import { ResponseView } from './views/ResponseView'
import { CollapseMode } from './views/CollapseMode'
import { SettingsView } from './views/SettingsView'
import { weatherStore } from './data/weather'
import { ease } from './lib/motion'
import './App.css'

export default function App() {
  const s = useSession()
  const roster = useRoster()
  const reduce = useReducedMotion()
  const [view, setView] = useState<View>('live')
  const [picked, setAthleteId] = useState<string | null>(null)
  const athleteId = picked ?? roster.athletes[0]?.id ?? ''
  // Acknowledgements belong to one replay run; a reset starts clean.
  const [ackState, setAckState] = useState<{ session: number; ids: Set<string> }>({ session: 0, ids: new Set() })
  const [collapseFor, setCollapseFor] = useState<string | null>(null)

  useEffect(() => {
    void planStore.boot()
    weatherStore.restore()
    const stopLive = liveStore.start()
    engine.play()
    return () => {
      stopLive()
      engine.pause()
    }
  }, [])

  const acked = ackState.session === s.session ? ackState.ids : new Set<string>()

  // Red alerts: an athlete's engine estimate is at or over the line (the engine's early warning shows amber).
  const alertIds = roster.athletes.filter((a) => s.athletes[a.id] && overLineNow(s.athletes[a.id], s.limitC)).map((a) => a.id)
  const unacked = alertIds.filter((id) => !acked.has(id))
  // Hottest by the engine's estimate at this minute (first athlete when there are no numbers).
  const hottest = [...roster.athletes].sort((a, b) => (s.athletes[b.id]?.coreC ?? -Infinity) - (s.athletes[a.id]?.coreC ?? -Infinity))[0]?.id ?? athleteId

  const tone: Tone = unacked.length && view === 'live' ? 'alert' : view === 'athlete' ? 'athlete' : 'coach'

  const openAthlete = useCallback((id: string) => {
    setAthleteId(id)
    setView('athlete')
  }, [])

  const ack = useCallback(
    (id: string) =>
      setAckState((prev) => ({
        session: s.session,
        ids: new Set(prev.session === s.session ? prev.ids : []).add(id),
      })),
    [s.session],
  )

  return (
    <>
      <Background tone={tone} />
      <div className="shell">
        <Sidebar view={view} onNavigate={setView} alertCount={alertIds.length} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            key={view}
            className="page"
            // Page swap: new view resolves out of a light blur (masks the
            // crossfade), old view leaves fast — the system is responding.
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(10px)', filter: 'blur(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12, ease: ease.out } }}
            transition={{ duration: 0.32, ease: ease.out }}
          >
            {view === 'live' && (
              <CoachDashboard acked={acked} onAck={ack} onOpenAthlete={openAthlete} onCollapse={setCollapseFor} />
            )}
            {view === 'plan' && <PlanView />}
            {view === 'athlete' && <AthleteView athleteId={athleteId} onSelect={setAthleteId} onCollapse={setCollapseFor} />}
            {view === 'response' && <ResponseView onStart={() => setCollapseFor(unacked[0] ?? alertIds[0] ?? hottest)} />}
            {view === 'settings' && <SettingsView />}
          </motion.main>
        </AnimatePresence>
      </div>
      <VoiceDock onSeePlayers={() => setView('athlete')} />
      <DemoBar />
      <AnimatePresence>
        {collapseFor && (
          <CollapseMode key="collapse" athleteId={collapseFor} onClose={() => setCollapseFor(null)} />
        )}
      </AnimatePresence>
    </>
  )
}
