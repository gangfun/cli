/**
 * What the model may do, decided in code rather than in a prompt: a token's name can try to talk the model into a trade,
 * so a send never depends on what the model says. Nothing to install, so it can be tested on its own.
 */
import { randomInt } from 'node:crypto'


/**
 * The tools this agent offers the model. Add to the list on purpose: gang_cli runs any other command, including creates,
 * and gang_watch can post to a webhook. Before adding one, check it in `gang capabilities`.
 */
export const ALLOWED_TOOLS = new Set([
  'gang_help', 'gang_preflight', 'gang_trending', 'gang_hot', 'gang_new', 'gang_near_grad', 'gang_info', 'gang_status',
  'gang_portfolio', 'gang_notes', 'gang_agents', 'gang_tx', 'gang_buy', 'gang_sell', 'gang_execute',
])

/** MCP's tool list → the model's, without the tools that aren't allowed. */
export const toolsForModel = (tools) => tools
  .filter((t) => ALLOWED_TOOLS.has(t.name))
  .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))

/** Control and direction characters out: what comes from the chain can't rewrite the terminal or reorder what a person reads. */
export const clean = (s) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (c) => (c === '\n' ? c : ' '))

/** An MCP tool result → its JSON body, or null. */
export function bodyOf(result) {
  if (result?.structuredContent) return result.structuredContent
  try { return JSON.parse(result?.content?.find((c) => c.type === 'text')?.text) } catch { return null }
}

/** The tools whose results are previews. A requestId anywhere else isn't one. */
export const PREVIEW_TOOLS = new Set(['gang_buy', 'gang_sell'])

/** The previews seen in this session, and which have been sent. */
export function createGate() {
  const previews = new Map()
  const asked = new Set()
  return {
    /** Keep a tool's preview, so that what the person approves is what the CLI returned, not the model's account of it. */
    remember(tool, result) {
      if (!PREVIEW_TOOLS.has(tool)) return
      const body = bodyOf(result)
      // the first one stays: what the person sees can't be swapped later under the same id
      if (typeof body?.requestId === 'string' && body.requestId && !previews.has(body.requestId)) previews.set(body.requestId, body)
    },
    /** May this go to the person? An error says why not; a preview is shown to them. */
    check(requestId) {
      if (!previews.has(requestId)) return { error: 'no preview with that requestId in this session: build one first' }
      if (asked.has(requestId)) return { error: 'this preview has already been answered. Never send it again: check gang_status or gang_tx' }
      const preview = previews.get(requestId)
      if (preview.update) return { error: `this CLI is old, so don't trade with it. Tell the person to run: ${preview.update.cmd ?? 'npm i -g @gangfun/cli@latest'}` }
      return { preview }
    },
    /** One question per preview. Marked before the send: a timed-out send may still go out, so it's never tried twice. */
    markAsked(requestId) { asked.add(requestId) },
  }
}

/** The fields that say what a trade does, for one line beside the question: a long preview scrolls off a small screen. */
export function summaryOf(preview) {
  const keys = ['step', 'token', 'spend', 'amount', 'payWith', 'quote', 'receive', 'expectTokens', 'minOut', 'minTokensOut']
  return clean(JSON.stringify(Object.fromEntries(keys.filter((k) => preview[k] != null).map((k) => [k, preview[k]])))).replace(/\n/g, ' ')
}

/** A new code for each question. Nothing typed before it's shown can approve a send, and the model never sees it. */
export const newCode = () => String(randomInt(1000, 10000))

/** Only the code itself approves a send. */
export const approves = (answer, code) => String(answer ?? '').trim() === code
