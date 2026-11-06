#!/usr/bin/env node
/**
 * Posts market events to a Telegram chat: new tokens, tokens close to graduation, graduations. Read-only: it never trades.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node watch.mjs [--events new_token,near_grad,graduated] [--min-pct 80]
 *   node watch.mjs --dry      # print instead of posting
 *
 * Token names are written by strangers. They go out as plain text (no parse_mode), cut short, and no link in them is used.
 * Telegram may still make a URL, @mention or /command inside a name clickable, so treat what you read as untrusted.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const GANG = process.env.GANG_BIN || 'gang'
const MAX_NAME = 40
const RESTART_MS = [1, 5, 30, 60].map((s) => s * 1000) // a longer wait after each failure in a row

/** Control characters out, length capped: a name can hold anything. */
export const clean = (s) => Array.from(String(s ?? '?').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, ' ').trim()).slice(0, MAX_NAME).join('') || '?'

/** One stream event → the message, or null for the events not meant for people. */
export function messageOf(e) {
  const addr = /^0x[0-9a-fA-F]{40}$/.test(e.token ?? e.address ?? '') ? (e.token ?? e.address) : null
  if (!addr) return null
  const who = e.name ? `${clean(e.symbol)} (${clean(e.name)})` : clean(e.symbol) // only new_token has the name
  const link = `https://gang.fun/token/${addr}`
  if (e.event === 'new_token') return `New token: ${who}\n${link}`
  if (e.event === 'near_grad') return `Near graduation: ${who}, ${Number(e.progressPct).toFixed(1)}%\n${link}`
  if (e.event === 'graduated') return `Graduated: ${who}\n${link}`
  return null
}

async function postTelegram(text, { token, chat }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) return
    if (r.status !== 429) throw new Error(`Telegram answered ${r.status}`) // never print the URL: it holds the token
    const wait = Number((await r.json().catch(() => ({}))).parameters?.retry_after) || 5
    await new Promise((d) => setTimeout(d, wait * 1000))
  }
  throw new Error('Telegram kept answering 429')
}

/** Runs gang watch until it ends; → 'fatal' when running it again can't help. Posts one at a time, so a burst keeps its order. */
function runOnce(args, deliver) {
  return new Promise((resolve) => {
    // gang gets no Telegram settings: it doesn't need them
    const { TELEGRAM_BOT_TOKEN: _t, TELEGRAM_CHAT_ID: _c, ...env } = process.env
    const child = spawn(GANG, ['watch', ...args], { stdio: ['ignore', 'pipe', 'inherit'], env })
    let outcome = 'ended', queue = Promise.resolve()
    createInterface({ input: child.stdout }).on('line', (line) => {
      let e
      try { e = JSON.parse(line) } catch { return }
      if (e.event === 'error') {
        console.error(`gang watch: ${e.error}`)
        if (e.fatal && e.code === 'USAGE') outcome = 'fatal'
      }
      const text = messageOf(e)
      if (text) queue = queue.then(() => deliver(text)).catch((err) => console.error(`post failed: ${err.message}`))
    })
    child.on('error', (err) => { console.error(`can't run ${GANG}: ${err.message}`); outcome = 'fatal'; resolve(outcome) })
    child.on('close', () => queue.then(() => resolve(outcome)))
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const args = argv.filter((a) => a !== '--dry')
  if (!args.includes('--events')) args.push('--events', 'new_token,near_grad,graduated')
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!dry && (!token || !chat)) {
    console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or run with --dry to print instead.')
    process.exit(2)
  }
  const deliver = dry ? async (text) => console.log(`${text}\n`) : (text) => postTelegram(text, { token, chat })
  for (let fails = 0; ;) {
    const started = Date.now()
    if ((await runOnce(args, deliver)) === 'fatal') process.exit(1)
    if (args.includes('--max-events') || args.includes('--timeout')) return // a bounded run ends when gang watch ends
    fails = Date.now() - started > 5 * 60_000 ? 0 : fails + 1
    const wait = RESTART_MS[Math.min(fails, RESTART_MS.length - 1)]
    console.error(`gang watch ended; starting again in ${wait / 1000}s`)
    await new Promise((d) => setTimeout(d, wait))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
