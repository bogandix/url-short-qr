import { p } from './lib/ui.js'
import { runDomainAdd, runSetup } from './setup.js'

const [cmd, ...args] = process.argv.slice(2)

async function main() {
  switch (cmd) {
    case 'setup':
      return runSetup()
    case 'domain-add':
      return runDomainAdd(args.find((a) => !a.startsWith('-')))
    default:
      console.log('usage: tsx setup/cli.ts setup | domain-add [apex]')
      process.exit(2)
  }
}

main().catch((err: Error) => {
  p.log.error(err.message)
  if (process.env.DEBUG) console.error(err)
  process.exit(1)
})
