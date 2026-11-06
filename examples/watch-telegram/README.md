# Telegram monitor

Posts new tokens, tokens close to graduation and graduations to a Telegram chat. It only reads: there is no wallet and it never trades.

```bash
npm i -g @gangfun/cli
node watch.mjs --dry        # try it: prints instead of posting

# create a bot with @BotFather and add it to your chat, then:
TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node watch.mjs
```

Flags go to `gang watch`: `--min-pct 80` (near graduation from 80%), `--events graduated`, `--track v3`. It restarts `gang watch` if the stream ends.

Keep the bot token in the environment, never in a file you commit. Token names are written by strangers: this example strips control characters, cuts names short and posts plain text. Telegram can still make a URL, @mention or /command in a name clickable.
