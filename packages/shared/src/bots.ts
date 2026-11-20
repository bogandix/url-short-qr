const BOT_RE =
  /(bot|crawl|spider|preview|facebookexternalhit|WhatsApp|Slack|TelegramBot|Discord|Twitterbot|LinkedInBot|SkypeUriPreview|curl|wget|python-requests|HeadlessChrome)/i

export type BotResult = { isBot: boolean; botName: string | null }

export function detectBot(method: string, ua: string | null): BotResult {
  if (method.toUpperCase() === 'HEAD') {
    return { isBot: true, botName: 'HEAD' }
  }
  if (!ua) return { isBot: false, botName: null }
  const m = ua.match(BOT_RE)
  if (m) return { isBot: true, botName: m[1] ?? 'bot' }
  return { isBot: false, botName: null }
}
