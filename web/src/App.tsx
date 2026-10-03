import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { engine, useSession } from './data/engine'
import { ROSTER } from './data/fixtures'
import { Background, type Tone } from './components/Background'
import { Sidebar, type View } from './components/Sidebar'
import { DemoBar } from './components/DemoBar'
import { VoiceDock } from './components/VoiceDock'
import { planStore } from './data/planStore'
import { settingsStore } from './data/settingsStore'
import { weatherStore } from './data/weatherStore'
import { SettingsView } from './views/SettingsView'
import { CoachDashboard } from './views/CoachDashboard'
import { AthleteView } from './views/AthleteView'
import { PlanView } from './views/PlanView'
import { ResponseView } from './views/ResponseView'
import { CollapseMode } from './views/CollapseMode'
import { ease } from './lib/motion'
import './App.css'

export default function App() {
  const s = useSession()
  const reduce = useReducedMotion()
  const [view, setView] = useState<View>('live')
  const [athleteId, setAthleteId] = useState(ROSTER[0].id)
  // Acknowledgements belong to one replay run; a reset starts clean.
  const [ackState, setAckState] = useState<{ session: number; ids: Set<string> }>({ session: 0, ids: new Set() })
  const [collapseFor, setCollapseFor] = useState<string | null>(null)

  // Live weather + location: the chosen site is where plans are modeled, and
  // the plan day's live forecast drives the replay's WBGT and zones.
  useEffect(() => {
    const applySite = () => {
      const l = settingsStore.get().location
      const site = planStore.get().plan.site
      planStore.setSite({ ...site, name: l.name, lat: l.lat, lon: l.lon })
    }
    const offDay = weatherStore.onDayForecast((hours) => engine.setForecast(hours))
    const offPlan = planStore.subscribe(() => weatherStore.setPlanDate(planStore.get().plan.start.slice(0, 10)))
    const offSettings = settingsStore.subscribe(applySite)
    // Once live weather tells us the site's UTC offset, keep practice at the same local clock time there.
    const offTz = weatherStore.subscribe(() => {
      const w = weatherStore.get()
      if (w.source !== 'nws_forecast' || !w.now) return
      const l = settingsStore.get().location
      if (w.location.lat !== l.lat || w.location.lon !== l.lon) return
      planStore.setSite({ ...planStore.get().plan.site, name: l.name, lat: l.lat, lon: l.lon }, w.now.time.slice(19))
    })
    const stopWeather = weatherStore.start()
    return () => {
      offDay()
      offPlan()
      offSettings()
      offTz()
      stopWeather()
    }
  }, [])

  useEffect(() => {
    planStore.restore()
    const l = settingsStore.get().location
    planStore.setSite({ ...planStore.get().plan.site, name: l.name, lat: l.lat, lon: l.lon })
    engine.play()
    return () => engine.pause()
  }, [])

  const acked = ackState.session === s.session ? ackState.ids : new Set<string>()

  const alertIds = ROSTER.filter((a) => s.athletes[a.id].status === 'alert').map((a) => a.id)
  const unacked = alertIds.filter((id) => !acked.has(id))
  const hottest = [...ROSTER].sort((a, b) => s.athletes[b.id].coreC - s.athletes[a.id].coreC)[0].id

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
            {view === 'settings' && <SettingsView />}
            {view === 'response' && <ResponseView onStart={() => setCollapseFor(unacked[0] ?? alertIds[0] ?? hottest)} />}
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
