#!/usr/bin/env node
'use strict'

const chalk = require('chalk')
const cp = require('child_process')
const createTorrent = require('create-torrent')
const ecstatic = require('ecstatic')
const executable = require('executable')
const fs = require('fs')
const http = require('http')
const mime = require('mime')
const moment = require('moment')
const networkAddress = require('network-address')
const parseTorrent = require('parse-torrent')
const path = require('path')
const MemoryChunkStore = require('memory-chunk-store')
const prettierBytes = require('prettier-bytes')
const stripIndent = require('common-tags/lib/stripIndent')
const vlcCommand = require('vlc-command')
const WebTorrent = require('webtorrent')
const yargs = require('yargs')()
const { hideBin } = require('yargs/helpers')
const open = require('open')

const { version: webTorrentCliVersion } = require('../package.json')
const { version: webTorrentVersion } = require('webtorrent/package.json')

// Group options into sections (used in yargs configuration)
const options = {
  streaming: {
    airplay: { desc: 'Apple TV' },
    chromecast: { desc: 'Google Chromecast', defaultDescription: 'all' },
    dlna: { desc: 'DNLA' },
    mplayer: { desc: 'MPlayer' },
    mpv: { desc: 'MPV' },
    omx: { desc: 'OMX', defaultDescription: 'hdmi' },
    vlc: { desc: 'VLC' },
    iina: { desc: 'IINA' },
    smplayer: { desc: 'SMPlayer' },
    xbmc: { desc: 'XBMC' },
    stdout: { desc: 'Standard out (implies --quiet)' }
  },
  simple: {
    o: { alias: 'out', desc: 'Set download destination', type: 'string', requiresArg: true },
    s: { alias: 'select', desc: 'Select specific file in torrent' },
    t: { alias: 'subtitles', desc: 'Load subtitles file', type: 'string', requiresArg: true }
  },
  advanced: {
    p: { alias: 'port', desc: 'Change the http server port', default: 8000, requiresArg: true },
    b: { alias: 'blocklist', desc: 'Load blocklist file/url', type: 'string', requiresArg: true },
    a: { alias: 'announce', desc: 'Tracker URL to announce to', type: 'string', requiresArg: true },
    q: { alias: 'quiet', desc: 'Don\'t show UI on stdout' },
    pip: { desc: 'Enter Picture-in-Picture if supported by the player' },
    verbose: { desc: 'Show torrent protocol details' },
    'playlist': {desc: 'Open files in a playlist if supported by the player'},
    'player-args': { desc: 'Add player specific arguments (see example)', type: 'string', requiresArg: true },
    'torrent-port': { desc: 'Change the torrent seeding port', defaultDescription: 'random' },
    'dht-port': { desc: 'Change the dht port', defaultDescription: 'random' },
    'not-on-top': { desc: 'Don\'t set "always on top" option in player' },
    'keep-seeding': { desc: 'Don\'t quit when done downloading' },
    'no-quit': { desc: 'Don\'t quit when player exits' },
    quit: { hidden: true, default: true },
    'on-done': { desc: 'Run script after torrent download is done', requiresArg: true },
    'on-exit': { desc: 'Run script before program exit', requiresArg: true }
  }
}

const commands = [
  { command: ['download [torrent-ids...]', '$0'], desc: 'Download a torrent', handler: (args) => { processInputs(args.torrentIds, runDownload) } },
  { command: 'downloadmeta <torrent-ids...>', desc: 'Download metadata of torrent', handler: (args) => { processInputs(args.torrentIds, runDownloadMeta) } },
  { command: 'seed <inputs...>', desc: 'Seed a file or a folder', handler: (args) => { processInputs(args.inputs, runSeed) } },
  { command: 'create <input>', desc: 'Create a .torrent file', handler: (args) => { runCreate(args.input) } },
  { command: 'info <torrent-id>', desc: 'Show torrent information', handler: (args) => { runInfo(args.torrentId) } },
  { command: 'version', desc: 'Show version information', handler: () => yargs.showVersion('log') },
  { command: 'help', desc: 'Show help information' } // Implicitly calls showHelp, as a result middleware is not executed
]

// All command line arguments in one place. (stuff gets added at runtime, e.g. vlc path and omx jack)
const playerArgs = {
  vlc: ['', '--play-and-exit', '--quiet'],
  iina: ['/Applications/IINA.app/Contents/MacOS/iina-cli', '--keep-running'],
  mpv: ['mpv', '--really-quiet', '--loop=no'],
  mplayer: ['mplayer', '-really-quiet', '-noidx', '-loop', '0'],
  smplayer: ['smplayer', '-close-at-end'],
  omx: [
    'lxterminal', '-e',
    'omxplayer', '-r',
    '--timeout', '60',
    '--no-ghost-box', '--align', 'center', '-o'
  ]
}

let client, href, server, serving, playerName, subtitlesServer, drawInterval, argv
let expectedError = false
let gracefullyExiting = false
let torrentCount = 1

process.title = 'WebTorrent'

process.on('exit', code => {
  if (code === 0 || expectedError) return // normal exit
  if (code === 130) return // intentional exit with Control-C

  console.log(chalk`\n{red UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!`)
  console.log(chalk`{green OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n`)
  console.log(`DEBUG INFO: webtorrent-cli ${webTorrentCliVersion}, webtorrent ${webTorrentVersion}, node ${process.version}, ${process.platform} ${process.arch}, exit ${code}`)
})

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

yargs
  .scriptName('webtorrent')
  .locale('en')
  .fail((msg, err) => { console.log(chalk`\n{red Error:} ${msg || err}`); process.exit(1) })
  .usage(
    fs.readFileSync(path.join(__dirname, 'ascii-logo.txt'), 'utf8')
      .split('\n')
      .map(line => chalk`{bold ${line.substring(0, 20)}}{red ${line.substring(20)}}`)
      .join('\n')
      .concat('\n',
        stripIndent`
          Usage:
            webtorrent [command] <torrent-id> [options]
    
          Examples:
            webtorrent download "magnet:..." --vlc
            webtorrent "magnet:..." --vlc --player-args="--video-on-top --repeat"
    
          Default output location:
            * when streaming: Temp folder
            * when downloading: Current directory
    
          Specify <torrent-id> as one of:
            * magnet uri
            * http url to .torrent file
            * filesystem path to .torrent file
            * info hash (hex string)\n\n
        `)
  )
yargs
  .command(commands)
  .options(options.streaming).group(Object.keys(options.streaming), 'Options (streaming): ')
  .options(options.simple).group(Object.keys(options.simple).concat(['help', 'version']), 'Options (simple): ')
  .options(options.advanced).group(Object.keys(options.advanced), 'Options (advanced)')

// Yargs callback order: middleware(callback) -> command(callback) -> yargs.parse(callback)
yargs.middleware(init)

yargs
  .strict()
  .help('help', 'Show help information')
  .version('version', 'Show version information', `${webTorrentCliVersion} (${webTorrentVersion})`)
  .alias({ help: 'h', version: 'v' })
  .parse(hideBin(process.argv), { startTime: Date.now() })

function init (_argv) {
  argv = _argv
  if ((argv._.length === 0 && !argv.torrentIds) || argv._[0] === 'version') {
    return
  }

  playerArgs.omx.push(typeof argv.omx === 'string' ? argv.omx : 'hdmi')

  if (process.env.DEBUG) {
    playerArgs.vlc.push('--extraintf=http:logger', '--verbose=2', '--file-logging', '--logfile=vlc-log.txt')
  }
  if (process.env.DEBUG || argv.stdout) {
    enableQuiet()
  }

  const selectedPlayers = Object.keys(argv).filter(v => Object.keys(options.streaming).includes(v))
  playerName = selectedPlayers.length === 1 ? selectedPlayers[0] : null

  if (argv.subtitles) {
    const subtitles = JSON.stringify(argv.subtitles)

    playerArgs.vlc.push(`--sub-file=${subtitles}`)
    playerArgs.mplayer.push(`-sub ${subtitles}`)
    playerArgs.mpv.push(`--sub-file=${subtitles}`)
    playerArgs.omx.push(`--subtitles ${subtitles}`)
    playerArgs.smplayer.push(`-sub ${subtitles}`)

    subtitlesServer = http.createServer(ecstatic({
      root: path.dirname(argv.subtitles),
      showDir: false,
      cors: true
    }))
  }

  if (argv.pip) {
    playerArgs.iina.push('--pip')
  }

  if (!argv.notOnTop) {
    playerArgs.vlc.push('--video-on-top')
    playerArgs.mplayer.push('-ontop')
    playerArgs.mpv.push('--ontop')
    playerArgs.smplayer.push('-ontop')
  }

  if (argv.onDone) {
    checkPermission(argv.onDone)
    argv.onDone = argv['on-done'] = fs.realpathSync(argv.onDone)
  }

  if (argv.onExit) {
    checkPermission(argv.onExit)
    argv.onExit = argv['on-exit'] = fs.realpathSync(argv.onExit)
  }

  if (playerName && argv.playerArgs) {
    playerArgs[playerName].push(...argv.playerArgs.split(' '))
  }

  // Trick to keep scrollable history.
  if (!['create', 'info'].includes(argv._[0]) && !argv.quiet) {
    console.log('\n'.repeat(process.stdout.rows))
    console.clear()
  }
}

function runInfo (torrentId) {
  let parsedTorrent

  try {
    parsedTorrent = parseTorrent(torrentId)
  } catch (err) {
    // If torrent fails to parse, it could be a filesystem path, so don't consider it
    // an error yet.
  }

  if (!parsedTorrent || !parsedTorrent.infoHash) {
    try {
      parsedTorrent = parseTorrent(fs.readFileSync(torrentId))
    } catch (err) {
      return errorAndExit(err)
    }
  }

  delete parsedTorrent.info
  delete parsedTorrent.infoBuffer
  delete parsedTorrent.infoHashBuffer

  const output = JSON.stringify(parsedTorrent, undefined, 2)
  if (argv.out) {
    fs.writeFileSync(argv.out, output)
  } else {
    process.stdout.write(output)
  }
}

function runCreate (input) {
  if (!argv.createdBy) {
    argv.createdBy = 'WebTorrent <https://webtorrent.io>'
  }

  createTorrent(input, argv, (err, torrent) => {
    if (err) {
      return errorAndExit(err)
    }

    if (argv.out) {
      fs.writeFileSync(argv.out, torrent)
    } else {
      process.stdout.write(torrent)
    }
  })
}

function runDownload (torrentId) {
  if (!argv.out && !argv.stdout && !playerName) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    path: argv.out,
    announce: argv.announce
  })

  if (argv.verbose) {
    torrent.on('warning', handleWarning)
  }

  torrent.on('infoHash', () => {
    if ('select' in argv) {
      torrent.so = argv.select.toString()
    }

    if (argv.quiet) return

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      console.clear()
      console.log(chalk`{green fetching torrent metadata from} {bold ${torrent.numPeers}} {green peers}`)
    }

    torrent.on('metadata', () => {
      console.clear()
      torrent.removeListener('wire', updateMetadata)

      console.clear()
      console.log(chalk`{green verifying existing torrent data...}`)
    })
  })

  torrent.on('done', () => {
    torrentCount -= 1
    if (!argv.quiet) {
      const numActiveWires = torrent.wires.reduce((num, wire) => num + (wire.downloaded > 0), 0)

      console.log(chalk`\ntorrent downloaded {green successfully} from {bold ${numActiveWires}/${torrent.numPeers}} {green peers} in {bold ${getRuntime()}s}!`)
    }
    if (argv['on-done']) {
      cp.exec(argv['on-done']).unref()
    }
    if (!playerName && !serving && argv.out && !argv['keep-seeding']) {
      torrent.destroy()

      if (torrentCount === 0) {
        gracefulExit()
      }
    }
  })

  // Start http server
  server = torrent.createServer()

  server.listen(argv.port)
    .on('error', err => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        // If port is taken, pick one a free one automatically
        server.close()
        const serv = server.listen(0)
        argv.port = server.address().port
        return serv
      } else return fatalError(err)
    })

  server.once('listening', initServer)
  server.once('connection', () => (serving = true))

  function initServer () {
    if (torrent.ready) {
      onReady()
    } else {
      torrent.once('ready', onReady)
    }
  }

  function onReady () {
    if (argv.select && typeof argv.select !== 'number') {
      console.log('Select a file to download:')

      torrent.files.forEach((file, i) => console.log(
        chalk`{bold.magenta %s} %s {blue (%s)}`,
        i.toString().padEnd(2), file.name, prettierBytes(file.length)
      ))

      console.log('\nTo select a specific file, re-run `webtorrent` with "--select [index]"')
      console.log('Example: webtorrent download "magnet:..." --select 0')

      return gracefulExit()
    }

    // if no index specified, use largest file
    const index = (typeof argv.select === 'number')
      ? argv.select
      : torrent.files.indexOf(torrent.files.reduce((a, b) => a.length > b.length ? a : b))

    if (!torrent.files[index]) {
      return errorAndExit(`There's no file that maps to index ${index}`)
    }

    onSelection(index)
  }

  function onSelection (index) {
    href = (argv.airplay || argv.chromecast || argv.xbmc || argv.dlna)
      ? `http://${networkAddress()}:${server.address().port}`
      : `http://localhost:${server.address().port}`
    let all_hrefs = []
    if (argv.playlist && (argv.mpv || argv.mplayer || argv.vlc || argv.smplayer)) {
      // set the selected to the first file if not specified
      if (typeof argv.select != 'number') {
        index = 0
      }
      torrent.files.forEach((file, i) => all_hrefs.push(JSON.stringify(`${href}/${i}/${encodeURIComponent(file.name)}`)))
      // set the first file to the selected index
      all_hrefs = all_hrefs.slice(index, all_hrefs.length).concat(all_hrefs.slice(0, index))
    } else {
      href += `/${index}/${encodeURIComponent(torrent.files[index].name)}`
    }

    if (playerName) {
      torrent.files[index].select()
    }

    if (argv.stdout) {
      torrent.files[index].createReadStream().pipe(process.stdout)
    }

    if (argv.vlc) {
      vlcCommand((err, vlcCmd) => {
        if (err) {
          return fatalError(err)
        }
        playerArgs.vlc[0] = vlcCmd
        argv.playlist ? openPlayer(playerArgs.vlc.concat(all_hrefs)) : openPlayer(playerArgs.vlc.concat(JSON.stringify(href)))
      })
    } else if (argv.iina) {
      open(`iina://weblink?url=${href}`, { wait: true }).then(playerExit)
    } else if (argv.mplayer) {
      argv.playlist ? openPlayer(playerArgs.mplayer.concat(all_hrefs)) : openPlayer(playerArgs.mplayer.concat(JSON.stringify(href)))
    } else if (argv.mpv) {
      argv.playlist ? openPlayer(playerArgs.mpv.concat(all_hrefs)) : openPlayer(playerArgs.mpv.concat(JSON.stringify(href)))
    } else if (argv.omx) {
      openPlayer(playerArgs.omx.concat(JSON.stringify(href)))
    } else if (argv.smplayer) {
      argv.playlist ? openPlayer(playerArgs.smplayer.concat(all_hrefs)) : openPlayer(playerArgs.smplayer.concat(JSON.stringify(href)))
    }

    function openPlayer (args) {
      cp.spawn(JSON.stringify(args[0]), args.slice(1), { stdio: 'ignore', shell: true })
        .on('error', (err) => {
          if (err) {
            const isMpvFalseError = playerName === 'mpv' && err.code === 4

            if (!isMpvFalseError) {
              return fatalError(err)
            }
          }
        })
        .on('exit', playerExit)
        .unref()
    }

    function playerExit () {
      if (argv.quit) {
        gracefulExit()
      }
    }

    if (argv.airplay) {
      const airplay = require('airplay-js')

      airplay.createBrowser()
        .on('deviceOn', device => device.play(href, 0, () => { }))
        .start()
    }

    if (argv.chromecast !== false) {
      const chromecasts = require('chromecasts')()

      const opts = {
        title: `WebTorrent - ${torrent.files[index].name}`
      }

      if (argv.subtitles) {
        subtitlesServer.listen(0)
        opts.subtitles = [`http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`]
        opts.autoSubtitles = true
      }

      chromecasts.on('update', player => {
        if (
          // If there are no named chromecasts supplied, play on all devices
          argv.chromecast === true ||
          // If there are named chromecasts, check if this is one of them
          [].concat(argv.chromecast).find(name => player.name.toLowerCase().includes(name.toLowerCase()))
        ) {
          player.play(href, opts)

          player.on('error', err => {
            err.message = `Chromecast: ${err.message}`
            return errorAndExit(err)
          })
        }
      })
    }

    if (argv.xbmc) {
      const xbmc = require('nodebmc')

      new xbmc.Browser()
        .on('deviceOn', device => device.play(href, () => { }))
    }

    if (argv.dlna) {
      const dlnacasts = require('dlnacasts')()

      dlnacasts.on('update', player => {
        const opts = {
          title: `WebTorrent - ${torrent.files[index].name}`,
          type: mime.getType(torrent.files[index].name)
        }

        if (argv.subtitles) {
          subtitlesServer.listen(0, () => {
            opts.subtitles = [
              `http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`
            ]
            play()
          })
        } else {
          play()
        }

        function play () {
          player.play(href, opts)
        }
      })
    }
    drawTorrent(torrent)
  }
}

function runDownloadMeta (torrentId) {
  if (!argv.out && !argv.stdout) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    store: MemoryChunkStore,
    announce: argv.announce
  })

  torrent.on('infoHash', function () {
    const torrentFilePath = `${argv.out}/${this.infoHash}.torrent`

    if (argv.quiet) {
      return
    }

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      console.clear()
      console.log(chalk`{green fetching torrent metadata from} {bold ${torrent.numPeers}} {green peers}`)
    }

    torrent.on('metadata', function () {
      console.clear()
      torrent.removeListener('wire', updateMetadata)

      console.clear()
      console.log(chalk`{green saving the .torrent file data to ${torrentFilePath} ...}`)
      fs.writeFileSync(torrentFilePath, this.torrentFile)
      gracefulExit()
    })
  })
}

function runSeed (input) {
  if (path.extname(input).toLowerCase() === '.torrent' || /^magnet:/.test(input)) {
    // `webtorrent seed` is meant for creating a new torrent based on a file or folder
    // of content, not a torrent id (.torrent or a magnet uri). If this command is used
    // incorrectly, let's just do the right thing.
    runDownload(input)
    return
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })

  client.on('error', fatalError)

  client.seed(input, {
    announce: argv.announce
  }, torrent => {
    if (argv.quiet) {
      console.log(torrent.magnetURI)
    }

    drawTorrent(torrent)
  })
}

function drawTorrent (torrent) {
  if (!argv.quiet) {
    console.clear()
    drawInterval = setInterval(draw, 1000)
    drawInterval.unref()
  }

  let hotswaps = 0
  torrent.on('hotswap', () => (hotswaps += 1))

  let blockedPeers = 0
  torrent.on('blockedPeer', () => (blockedPeers += 1))

  function draw () {
    const unchoked = torrent.wires
      .filter(wire => !wire.peerChoking)

    let linesRemaining = process.stdout.rows
    let peerslisted = 0

    const speed = torrent.downloadSpeed
    const estimate = torrent.timeRemaining
      ? moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
      : 'N/A'

    const runtimeSeconds = getRuntime()
    const runtime = runtimeSeconds > 300
      ? moment.duration(getRuntime(), 'seconds').humanize()
      : `${runtimeSeconds} seconds`
    const seeding = torrent.done

    console.clear()

    line(chalk`{green ${seeding ? 'Seeding' : 'Downloading'}:} {bold ${torrent.name}}`)

    if (seeding) line(chalk`{green Info hash:} ${torrent.infoHash}`)

    const portInfo = []
    if (argv['torrent-port']) portInfo.push(chalk`{green Torrent port:} ${argv['torrent-port']}`)
    if (argv['dht-port']) portInfo.push(chalk`{green DHT port:} ${argv['dht-port']}`)
    if (portInfo.length) line(portInfo.join(' '))

    if (playerName) {
      line(chalk`{green Streaming to:} {bold ${playerName}}  {green Server running at:} {bold ${href}}`)
    } else if (server) {
      line(chalk`{green Server running at:}{bold ${href}}`)
    }

    if (argv.out) {
      line(chalk`{green Downloading to:} {bold ${argv.out}}`)
    }

    line(chalk`{green Speed:} {bold ${prettierBytes(speed)
      }/s} {green Downloaded:} {bold ${prettierBytes(torrent.downloaded)
      }}/{bold ${prettierBytes(torrent.length)}} {green Uploaded:} {bold ${prettierBytes(torrent.uploaded)
      }}`)

    line(chalk`{green Running time:} {bold ${runtime
      }}  {green Time remaining:} {bold ${estimate
      }}  {green Peers:} {bold ${unchoked.length
      }/${torrent.numPeers
      }}`)

    if (argv.verbose) {
      line(chalk`{green Queued peers:} {bold ${torrent._numQueued
        }}  {green Blocked peers:} {bold ${blockedPeers
        }}  {green Hotswaps:} {bold ${hotswaps
        }}`)
    }

    line('')

    torrent.wires.every(wire => {
      let progress = '?'

      if (torrent.length) {
        let bits = 0

        const piececount = Math.ceil(torrent.length / torrent.pieceLength)

        for (let i = 0; i < piececount; i++) {
          if (wire.peerPieces.get(i)) {
            bits++
          }
        }

        progress = bits === piececount
          ? 'S'
          : `${Math.floor(100 * bits / piececount)}%`
      }

      let str = chalk`%s {magenta %s} %s {cyan %s} {red %s}`

      const args = [
        progress.padEnd(3),
        (wire.remoteAddress
          ? `${wire.remoteAddress}:${wire.remotePort}`
          : 'Unknown').padEnd(25),
        prettierBytes(wire.downloaded).padEnd(10),
        (prettierBytes(wire.downloadSpeed()) + '/s').padEnd(12),
        (prettierBytes(wire.uploadSpeed()) + '/s').padEnd(12)
      ]

      if (argv.verbose) {
        str += chalk` {grey %s} {grey %s}`

        const tags = []

        if (wire.requests.length > 0) {
          tags.push(`${wire.requests.length} reqs`)
        }

        if (wire.peerChoking) {
          tags.push('choked')
        }

        const reqStats = wire.requests
          .map(req => req.piece)

        args.push(tags.join(', ').padEnd(15), reqStats.join(' ').padEnd(10))
      }

      line(...[].concat(str, args))

      peerslisted += 1
      return linesRemaining > 4
    })

    line(''.padEnd(60))

    if (torrent.numPeers > peerslisted) {
      line('... and %s more', torrent.numPeers - peerslisted)
    }

    function line (...args) {
      console.log(...args)
      linesRemaining -= 1
    }
  }
}

function handleWarning (err) {
  console.warn(`Warning: ${err.message || err}`)
}

function fatalError (err) {
  console.log(chalk`{red Error:} ${err.message || err}`)
  process.exit(1)
}

function errorAndExit (err) {
  console.log(chalk`{red Error:} ${err.message || err}`)
  expectedError = true
  process.exit(1)
}

function gracefulExit () {
  if (gracefullyExiting) {
    return
  }

  gracefullyExiting = true

  console.log(chalk`\n{green webtorrent is exiting...}`)

  process.removeListener('SIGINT', gracefulExit)
  process.removeListener('SIGTERM', gracefulExit)

  if (!client) {
    return
  }

  if (subtitlesServer) {
    subtitlesServer.close()
  }

  clearInterval(drawInterval)

  if (argv['on-exit']) {
    cp.exec(argv['on-exit']).unref()
  }

  client.destroy(err => {
    if (err) {
      return fatalError(err)
    }

    // Quit after 1 second. This is only necessary for `webtorrent-hybrid` since
    // the `electron-webrtc` keeps the node process alive quit.
    setTimeout(() => process.exit(0), 1000)
      .unref()
  })
}

function checkPermission (filename) {
  try {
    if (!executable.sync(filename)) {
      return errorAndExit(`Script "${filename}" is not executable`)
    }
  } catch (err) {
    return errorAndExit(`Script "${filename}" does not exist`)
  }
}

function enableQuiet () {
  argv.quiet = argv.q = true
}

function getRuntime () {
  return Math.floor((Date.now() - argv.startTime) / 1000)
}

function processInputs (inputs, fn) {
  // These arguments do not make sense when downloading multiple torrents, or
  // seeding multiple files/folders.
  if (inputs) {
    if (inputs.length > 1) {
      const invalidArguments = [
        'airplay', 'chromecast', 'dlna', 'mplayer', 'mpv', 'omx', 'vlc', 'iina', 'xbmc',
        'stdout', 'select', 'subtitles', 'smplayer'
      ]

      invalidArguments.forEach(arg => {
        if (argv[arg]) {
          return errorAndExit(new Error(
            `The --${arg} argument cannot be used with multiple files/folders.`
          ))
        }
      })
      torrentCount = inputs.length
      enableQuiet()
    } else if (inputs.length === 1) {
      fn(inputs[0])
    }
  } else {
    yargs.showHelp('log')
  }
}
