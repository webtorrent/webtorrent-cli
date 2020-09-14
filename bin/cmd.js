#!/usr/bin/env node
'use strict'

// #region Variables

const clivas = require('clivas')
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
const yargs = require('yargs')
const open = require('open')

const { version: webTorrentCliVersion } = require('../package.json')
const { version: webTorrentVersion } = require('webtorrent/package.json')

// Group options into sections (used in yargs configuration)
const optionGroups = {
  streaming: ['airplay', 'chromecast', 'dlna', 'mplayer', 'mpv', 'omx', 'vlc', 'iina', 'xbmc', 'stdout'],
  simple: ['out', 'select', 'subtitles', 'help', 'version'],
  advanced: [
    'port', 'blocklist',
    'announce', 'quiet',
    'torrent-port', 'dht-port',
    'pip', 'not-on-top',
    'keep-seeding', 'no-quit',
    'on-done', 'on-exit',
    'verbose', 'player-args'
  ]
}

// All command line arguments in one place. (stuff gets added at runtime, e.g. vlc path and omx jack)
const playerArgs = {
  vlc: ['', '--play-and-exit', '--quiet'],
  iina: ['/Applications/IINA.app/Contents/MacOS/iina-cli', '--keep-running'],
  mpv: ['mpv', '--really-quiet', '--loop=no'],
  mplayer: ['mplayer', '-really-quiet', '-noidx', '-loop', '0'],
  omx: [
    'lxterminal', '-e',
    'omxplayer', '-r',
    '--timeout', '60',
    '--no-ghost-box', '--align', 'center', '-o'
  ]
}

let client, href, server, serving, playerName, subtitlesServer, drawInterval, helpOutput
let expectedError = false
let gracefullyExiting = false
let torrentCount = 1
let argv = {}

process.title = 'WebTorrent'

// #endregion

// #region Event listeners

process.on('exit', code => {
  if (code === 0 || expectedError) return // normal exit
  if (code === 130) return // intentional exit with Control-C

  clivas.line('\n{red:UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!')
  clivas.line('{green:OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n')
  clivas.line(`DEBUG INFO: webtorrent-cli ${webTorrentCliVersion}, webtorrent ${webTorrentVersion}, node ${process.version}, ${process.platform} ${process.arch}, exit ${code}`)
})

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

// #endregion

// #region Yargs configuration

yargs
  .scriptName('webtorrent')
  .usage(
    stripIndent`
    Usage:
      webtorrent [command] <torrent-id> [options]

    Examples:
      webtorrent download "magnet:..." --vlc
      webtorrent "magnet:..." --vlc --player-args="--video-on-top --repeat"

    Specify <torrent-id> as one of:
      * magnet uri
      * http url to .torrent file
      * filesystem path to .torrent file
      * info hash (hex string)
    `)
  .alias('v', 'version')
  .alias('h', 'help')
  .locale('en')
  .version(`${webTorrentCliVersion} (${webTorrentVersion})`)
  .fail((msg, err) => { clivas.line(`\n{red:Error:} ${msg}`); process.exit(1) })

yargs.command('$0 [torrent-ids...]', false, {}, (args) => { if (args.torrentIds) handleMultipleInputs(args.torrentIds, runDownload); else runHelp() })
yargs.command('download <torrent-ids...>', 'Download a torrent', {}, (args) => { handleMultipleInputs(args.torrentIds, runDownload) })
yargs.command('downloadmeta <torrent-ids...>', 'Download metadata of torrent', {}, (args) => { handleMultipleInputs(args.torrentIds, runDownloadMeta) })
yargs.command('seed <inputs...>', 'Seed a file or a folder', {}, (args) => { handleMultipleInputs(args.inputs, runSeed) })
yargs.command('create <input>', 'Create a .torrent file', {}, (args) => { runCreate(args.input) })
yargs.command('info <torrent-id>', 'Show info for .torrent file or magner uri', {}, (args) => { runInfo(args.torrentId) })
yargs.command('version', 'Show version information', {}, () => { process.stdout.write(`${webTorrentCliVersion} (${webTorrentVersion})`) })
yargs.command('help', 'Show help information', {}, () => { runHelp() })

yargs.options({
  airplay: { describe: 'Apple TV' },
  chromecast: { describe: 'Google Chromecast' },
  dlna: { describe: 'DNLA' },
  mplayer: { describe: 'MPlayer' },
  mpv: { describe: 'MPV' },
  omx: { describe: 'OMX', type: 'string|boolean', defaultDescription: 'hdmi' },
  vlc: { describe: 'VLC' },
  iina: { describe: 'IINA' },
  xbmc: { describe: 'XBMC' },
  stdout: { describe: 'Standard out (implies --quiet)' }
}).group(optionGroups.streaming, 'Options (streaming): ')

yargs.options({
  o: { describe: 'Set download destination', alias: 'out', defaultDescription: 'current directory', requiresArg: true },
  s: { describe: 'Select specific file in torrent (omit index for file list)', alias: 'select', type: 'number', requiresArg: true },
  t: { describe: 'Load subtitles file', alias: 'subtitles', type: 'string', requiresArg: true }
}).group(optionGroups.simple, 'Options (simple): ')

yargs.options({
  port: { describe: 'Change the http server port', alias: 'p', default: 8000, requiresArg: true },
  blocklist: { describe: 'Load blocklist file/url', alias: 'b', type: 'string', requiresArg: true },
  announce: { describe: 'Tracker URL to announce to', alias: 'a', type: 'string', requiresArg: true },
  quiet: { describe: 'Don\'t show UI on stdout', alias: 'q' },
  pip: { describe: 'Enter Picture-in-Picture if supported by the player' },
  verbose: { describe: 'Show torrent protocol details' },
  'player-args': { describe: 'Add player specific arguments (see example)', type: 'string', requiresArg: true },
  'torrent-port': { describe: 'Change the torrent seeding port', defaultDescription: 'random' },
  'dht-port': { describe: 'Change the dht port', defaultDescription: 'random' },
  'not-on-top': { describe: 'Don\'t set "always on top" option in player' },
  'keep-seeding': { describe: 'Don\'t quit when done downloading' },
  'no-quit': { describe: 'Don\'t quit when player exits' },
  'on-done': { describe: 'Run script after torrent download is done', requiresArg: true },
  'on-exit': { describe: 'Run script before program exit', requiresArg: true }
}).group(optionGroups.advanced, 'Options (advanced)')

yargs.options({
  quit: { hidden: true, default: true }
})

// Very important to save help output.
// Otherwise, when run from yargs.command() callback it will be incomplete (missing all commands)
yargs.parse(['--help'], (_err, _argv, _output) => { helpOutput = _output })

// Yargs pipeline: middleware(callback) -> [process.argv gets parsed] -> command(callback) -> yargs.parse(callback)
// Note: built-in help command does not trigger callback from parser
yargs.middleware(init)

yargs
  .help(false)
  .strict()
  .parse(process.argv.slice(2), { startTime: Date.now() })

// #endregion

// #region Core functions

function init (_argv) {
  if (_argv.help || _argv._.includes('help')) runHelp()
  else if (_argv.version) return

  argv = _argv
  playerArgs.omx.push(typeof argv.omx === 'string' ? argv.omx : 'hdmi')

  if (process.env.DEBUG) {
    playerArgs.vlc.push('--extraintf=http:logger', '--verbose=2', '--file-logging', '--logfile=vlc-log.txt')
  }
  if (process.env.DEBUG || argv.stdout) {
    enableQuiet()
  }

  const selectedPlayers = Object.keys(argv).filter(v => optionGroups.streaming.includes(v))
  playerName = selectedPlayers.length === 1 ? selectedPlayers[0] : null

  if (argv.subtitles) {
    const subtitles = JSON.stringify(argv.subtitles)

    playerArgs.vlc.push(`--sub-file=${subtitles}`)
    playerArgs.mplayer.push(`-sub ${subtitles}`)
    playerArgs.mpv.push(`--sub-file=${subtitles}`)
    playerArgs.omx.push(`--subtitles ${subtitles}`)

    subtitlesServer = http.createServer(ecstatic({
      root: path.dirname(argv.subtitles),
      showDir: false
    }))
  }

  if (argv.pip) {
    playerArgs.iina.push('--pip')
  }

  if (!argv.notOnTop) {
    playerArgs.vlc.push('--video-on-top')
    playerArgs.mplayer.push('-ontop')
    playerArgs.mpv.push('--ontop')
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
}

function runHelp (shouldExit = true) {
  printLogo()
  process.stdout.write(helpOutput)
  if (shouldExit) process.exit(0)
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

  client = new WebTorrent({ blocklist: argv.blocklist })
  client.on('error', fatalError)

  const { out: path, announce } = argv
  const torrent = client.add(torrentId, { path, announce })

  torrent.on('infoHash', () => {
    if ('select' in argv) {
      torrent.so = argv.select.toString()
    }

    if (argv.quiet) return

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      clivas.clear()

      clivas.line(
        '{green:fetching torrent metadata from} {bold:%s} {green:peers}',
        torrent.numPeers
      )
    }

    torrent.on('metadata', () => {
      clivas.clear()
      torrent.removeListener('wire', updateMetadata)

      clivas.clear()
      clivas.line('{green:verifying existing torrent data...}')
    })
  })

  torrent.on('done', () => {
    torrentCount -= 1
    if (!argv.quiet) {
      const numActiveWires = torrent.wires
        .reduce((num, wire) => num + (wire.downloaded > 0), 0)

      clivas.line('')
      clivas.line(
        'torrent downloaded {green:successfully} from {bold:%s/%s} {green:peers} ' +
        'in {bold:%ss}!', numActiveWires, torrent.numPeers, getRuntime()
      )
    }

    torrentDone(torrent)
  })

  // Start http server
  server = torrent.createServer()

  function initServer () {
    if (torrent.ready) {
      onReady()
    } else {
      torrent.once('ready', onReady)
    }
  }

  server.listen(argv.port, initServer)
    .on('error', err => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        // If port is taken, pick one a free one automatically
        return server.listen(0, initServer)
      }

      return fatalError(err)
    })

  server.once('connection', () => (serving = true))

  function onReady () {
    if (typeof argv.select === 'boolean') {
      clivas.line('Select a file to download:')

      torrent.files.forEach((file, i) => clivas.line(
        '{2+bold+magenta:%s} %s {blue:(%s)}',
        i, file.name, prettierBytes(file.length)
      ))

      clivas.line('\nTo select a specific file, re-run `webtorrent` with "--select [index]"')
      clivas.line('Example: webtorrent download "magnet:..." --select 0')

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

    href += `/${index}/${encodeURIComponent(torrent.files[index].name)}`

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
        openPlayer(playerArgs.vlc.concat(JSON.stringify(href)))
      })
    } else if (argv.iina) {
      open(`iina://weblink?url=${href}`, { wait: true }).then(playerExit)
    } else if (argv.mplayer) {
      openPlayer(playerArgs.mplayer.concat(JSON.stringify(href)))
    } else if (argv.mpv) {
      openPlayer(playerArgs.mpv.concat(JSON.stringify(href)))
    } else if (argv.omx) {
      openPlayer(playerArgs.omx.concat(JSON.stringify(href)))
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

    if (argv.chromecast) {
      const chromecasts = require('chromecasts')()

      chromecasts.on('update', player => {
        player.play(href, {
          title: `WebTorrent - ${torrent.files[index].name}`
        })

        player.on('error', err => {
          err.message = `Chromecast: ${err.message}`
          return errorAndExit(err)
        })
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

  client = new WebTorrent({ blocklist: argv.blocklist })
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
      clivas.clear()
      clivas.line(
        '{green:fetching torrent metadata from} {bold:%s} {green:peers}',
        torrent.numPeers
      )
    }

    torrent.on('metadata', function () {
      clivas.clear()
      torrent.removeListener('wire', updateMetadata)

      clivas.clear()
      clivas.line(`{green:saving the .torrent file data to ${torrentFilePath} ..}`)
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

  const client = new WebTorrent({ blocklist: argv.blocklist })
  client.on('error', fatalError)

  client.seed(input, {
    announce: argv.announce,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  }, torrent => {
    if (argv.quiet) {
      process.stdout.write(torrent.magnetURI)
    }

    drawTorrent(torrent)
  })
}

function drawTorrent (torrent) {
  if (!argv.quiet) {
    process.stdout.write(Buffer.from('G1tIG1sySg==', 'base64')) // clear for drawing
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

    let linesRemaining = clivas.height
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

    clivas.clear()

    line(`{green:${seeding ? 'Seeding' : 'Downloading'}: }{bold:${torrent.name}}`)

    if (seeding) {
      line(`{green:Info hash: }${torrent.infoHash}`)
      const seedingInfo = []
      if (argv['torrent-port']) {
        seedingInfo.push(`{green:Torrent port: }${argv['torrent-port']}`)
      }
      if (argv['dht-port']) {
        seedingInfo.push(`{green:DHT port: }${argv['dht-port']}`)
      }
      if (seedingInfo.length) {
        line(seedingInfo.join(' '))
      }
    }

    if (playerName) {
      line(`{green:Streaming to: }{bold:${playerName}}  {green:Server running at: }{bold:${href}}`)
    } else if (server) {
      line(`{green:Server running at: }{bold:${href}}`)
    }

    if (argv.out) {
      line(`{green:Downloading to: }{bold:${argv.out}}`)
    }

    line(`{green:Speed: }{bold:${prettierBytes(speed)
      }/s} {green:Downloaded:} {bold:${prettierBytes(torrent.downloaded)
      }}/{bold:${prettierBytes(torrent.length)}} {green:Uploaded:} {bold:${prettierBytes(torrent.uploaded)
      }}`)

    line(`{green:Running time:} {bold:${runtime
      }}  {green:Time remaining:} {bold:${estimate
      }}  {green:Peers:} {bold:${unchoked.length
      }/${torrent.numPeers
      }}`)

    if (argv.verbose) {
      line(`{green:Queued peers:} {bold:${torrent._numQueued
        }}  {green:Blocked peers:} {bold:${blockedPeers
        }}  {green:Hotswaps:} {bold:${hotswaps
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

      let str = '{3:%s} {25+magenta:%s} {10:%s} {12+cyan:%s/s} {12+red:%s/s}'

      const args = [
        progress,
        wire.remoteAddress
          ? `${wire.remoteAddress}:${wire.remotePort}`
          : 'Unknown',
        prettierBytes(wire.downloaded),
        prettierBytes(wire.downloadSpeed()),
        prettierBytes(wire.uploadSpeed())
      ]

      if (argv.verbose) {
        str += ' {15+grey:%s} {10+grey:%s}'

        const tags = []

        if (wire.requests.length > 0) {
          tags.push(`${wire.requests.length} reqs`)
        }

        if (wire.peerChoking) {
          tags.push('choked')
        }

        const reqStats = wire.requests
          .map(req => req.piece)

        args.push(tags.join(', '), reqStats.join(' '))
      }

      line(...[].concat(str, args))

      peerslisted += 1
      return linesRemaining > 4
    })

    line('{60:}')

    if (torrent.numPeers > peerslisted) {
      line('... and %s more', torrent.numPeers - peerslisted)
    }

    clivas.flush(true)

    function line (...args) {
      clivas.line(...args)
      linesRemaining -= 1
    }
  }
}

function torrentDone (torrent) {
  if (argv['on-done']) {
    cp.exec(argv['on-done']).unref()
  }
  if (!playerName && !serving && argv.out && !argv['keep-seeding'] && torrentCount === 0) {
    gracefulExit()
  } else if (!argv.keepSeeding) {
    torrent.destroy()
  }
}

function fatalError (err) {
  clivas.line(`{red:Error:} ${err.message || err}`)
  process.exit(1)
}

function errorAndExit (err) {
  clivas.line(`{red:Error:} ${err.message || err}`)
  expectedError = true
  process.exit(1)
}

function gracefulExit () {
  if (gracefullyExiting) {
    return
  }

  gracefullyExiting = true

  clivas.line('\n{green:webtorrent is exiting...}')

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

function handleMultipleInputs (inputs, fn) {
  // These arguments do not make sense when downloading multiple torrents, or
  // seeding multiple files/folders.
  if (inputs.length > 1) {
    const invalidArguments = [
      'airplay', 'chromecast', 'dlna', 'mplayer', 'mpv', 'omx', 'vlc', 'iina', 'xbmc',
      'stdout', 'select', 'subtitles'
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
  }

  inputs.forEach(input => {
    fn(input)
  })
}

function printLogo () {
  fs.readFileSync(path.join(__dirname, 'ascii-logo.txt'), 'utf8')
    .split('\n')
    .forEach(line => clivas.line(
      `{bold:${line.substring(0, 20)}}{red:${line.substring(20)}}`))
}

// #endregion
