// Motion vocabulary, shared by every component. CSS mirrors these as
// custom properties in styles/tokens.css — change both together.

export const ease = {
  /** Strong ease-out: entrances, exits, anything responding to the user. */
  out: [0.23, 1, 0.32, 1] as const,
  /** Strong ease-in-out: things already on screen moving A → B. */
  inOut: [0.77, 0, 0.175, 1] as const,
  /** iOS-like sheet curve. */
  drawer: [0.32, 0.72, 0, 1] as const,
}

export const spring = {
  /** Critically damped default — no overshoot (Apple: damping 1.0, response ~0.35). */
  ui: { type: 'spring', bounce: 0, visualDuration: 0.35 } as const,
  /** Repositioning (list reorder, indicator slide). */
  move: { type: 'spring', bounce: 0, visualDuration: 0.42 } as const,
  /** Only after a gesture that carried momentum. */
  momentum: { type: 'spring', bounce: 0.2, visualDuration: 0.4 } as const,
}

export const springValue = {
  digits: { bounce: 0, visualDuration: 0.45 },
  smooth: { bounce: 0, visualDuration: 0.6 },
}

export const duration = {
  press: 0.16,
  small: 0.18,
  ui: 0.24,
  modal: 0.3,
}
