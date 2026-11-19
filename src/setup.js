// gang.fun's setup page: every preflight issue code, step by step, for the user to open on their phone
export const SETUP_GUIDE = 'https://gang.fun/start'
// each preflight issue's own step on that page (stable anchors), in page order
export const SETUP_STEP = { NOT_SIGNED_IN: 'sign-in', NO_AGENT_ID: 'agent-id', DEV_MODE_OFF: 'dev-mode', TRADE_ALL_TOKENS_OFF: 'trade-all' }
const ORDER = Object.keys(SETUP_STEP)
const stepUrl = (code) => (SETUP_STEP[code] ? `${SETUP_GUIDE}#${SETUP_STEP[code]}` : SETUP_GUIDE)
// a preflight issue: its code, the fix to relay, and a link to its step (the page root for a code with no step)
export const setupIssue = (code, fix) => ({ code, fix, url: stepUrl(code) })
// where guide.url opens: the earliest step on the page among the issues (issues keep their own order)
export const guideUrl = (issues) => {
  const steps = issues.map((i) => ORDER.indexOf(i.code)).filter((n) => n >= 0)
  return steps.length ? stepUrl(ORDER[Math.min(...steps)]) : SETUP_GUIDE
}
