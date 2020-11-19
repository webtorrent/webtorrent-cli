#!/usr/bin/env node
'use strict'

const clivas = require('clivas')
const cp = require('child_process')
const createTorrent = require('create-torrent')
const ecstatic = require('ecstatic')
const executable = require('executable')
const fs = require('fs')
const http = require('http')
const mime = require('mime')
const minimist = require('minimist')
const moment = require('moment')
const networkAddress = require('network-address')
const open = require('open')
const parseTorrent = require('parse-torrent')
const path = require('path')
const MemoryChunkStore = require('memory-chunk-store')
const prettierBytes = require('prettier-bytes')
const stripIndent = require('common-tags/lib/stripIndent')
const vlcCommand = require('vlc-command')
const WebTorrent = require('webtorrent')

const { version: webTorrentCliVersion } = require('../package.json')
const { version: webTorrentVersion } = require('webtorrent/package.json')

process.title = 'WebTorrent'

let expectedError = false
process.on('exit', code => {
  if (code === 0 || expectedError) return // normal exit
  if (code === 130) return // intentional exit with Control-C

  clivas.line('\n{red:UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!')
  clivas.line('{green:OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n')
  clivas.line(`DEBUG INFO: webtorrent-cli ${webTorrentCliVersion}, webtorrent ${webTorrentVersion}, node ${process.version}, ${process.platform} ${process.arch}, exit ${code}`)
})

let gracefullyExiting = false

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

const argv = minimist(process.argv.slice(2), {
  alias: {
    a: 'announce',
    b: 'blocklist',
    h: 'help',
    o: 'out',
    p: 'port',
    q: 'quiet',
    s: 'select',
    t: 'subtitles',
    v: 'version'
  },
  boolean: [ // Boolean options
    // Options (streaming)
    'airplay',
    'dlna',
    'iina',
    'mplayer',
    'mpv',
    'vlc',
    'xbmc',

    // Options (simple)
    'help',
    'version',

    // Options (advanced)
    'stdout',
    'quiet',
    'pip',
    'not-on-top',
    'keep-seeding',
    'quit',
    'verbose'
  ],
  string: [ // String options
    // Options (streaming)
    'chromecast', // can also be a boolean
    'omx', // can also be a boolean

    // Options (simple)
    'out',
    'subtitles',

    // Options (advanced)
    'announce',
    'blocklist',
    'on-done',
    'on-exit'
  ],
  default: {
    port: 8000,
    quit: true
  }
})

if (argv.chromecast === undefined) {
  argv.chromecast = false
} else if (argv.chromecast === '') {
  argv.chromecast = true
}

if (argv.omx === undefined) {
  argv.omx = false
} else if (argv.omx === '') {
  argv.omx = true
}

if (process.env.DEBUG || argv.stdout) {
  enableQuiet()
}

function enableQuiet () {
  argv.quiet = argv.q = true
}

const started = Date.now()
function getRuntime () {
  return Math.floor((Date.now() - started) / 1000)
}

let VLC_ARGS = '--play-and-exit --quiet'
if (process.env.DEBUG) {
  VLC_ARGS += ' --extraintf=http:logger --verbose=2 --file-logging --logfile=vlc-log.txt'
}

let IINA_EXEC = '/Applications/IINA.app/Contents/MacOS/iina-cli --keep-running'
let MPLAYER_EXEC = 'mplayer -really-quiet -noidx -loop 0'
let MPV_EXEC = 'mpv --really-quiet --loop=no'
let OMX_EXEC = `lxterminal -e omxplayer -r --timeout 60 --no-ghost-box --align center -o ${typeof argv.omx === 'string' ? argv.omx : 'hdmi'}`

let subtitlesServer
if (argv.subtitles) {
  const subtitles = JSON.stringify(argv.subtitles)

  VLC_ARGS += ` --sub-file=${subtitles}`
  MPLAYER_EXEC += ` -sub ${subtitles}`
  MPV_EXEC += ` --sub-file=${subtitles}`
  OMX_EXEC += ` --subtitles ${subtitles}`

  subtitlesServer = http.createServer(ecstatic({
    root: path.dirname(argv.subtitles),
    showDir: false,
    cors: true
  }))
}

if (argv.pip) {
  IINA_EXEC += ' --pip'
}

if (!argv['not-on-top']) {
  VLC_ARGS += ' --video-on-top'
  MPLAYER_EXEC += ' -ontop'
  MPV_EXEC += ' --ontop'
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

if (argv['on-done']) {
  checkPermission(argv['on-done'])
  argv['on-done'] = fs.realpathSync(argv['on-done'])
}

if (argv['on-exit']) {
  checkPermission(argv['on-exit'])
  argv['on-exit'] = fs.realpathSync(argv['on-exit'])
}

const playerName = argv.airplay !== false
  ? 'Airplay'
  : argv.chromecast !== false
    ? 'Chromecast'
    : argv.dlna !== false
      ? 'DLNA'
      : argv.iina !== false
        ? 'IINA'
        : argv.mplayer !== false
          ? 'MPlayer'
          : argv.mpv !== false
            ? 'mpv'
            : argv.omx !== false
              ? 'OMXPlayer'
              : argv.vlc !== false
                ? 'VLC'
                : argv.xbmc !== false
                  ? 'XBMC'
                  : null

const command = argv._[0]

let client, href, server, serving, numTorrents

if (['info', 'create', 'download', 'add', 'seed'].includes(command) && argv._.length === 1) {
  runHelp()
} else if (command === 'help' || argv.help) {
  runHelp()
} else if (command === 'version' || argv.version) {
  runVersion()
} else if (command === 'info') {
  if (argv._.length !== 2) {
    runHelp()
  } else {
    const torrentId = argv._[1]
    runInfo(torrentId)
  }
} else if (command === 'create') {
  if (argv._.length !== 2) {
    runHelp()
  } else {
    const input = argv._[1]
    runCreate(input)
  }
} else if (command === 'download' || command === 'add') {
  const torrentIds = argv._.slice(1)
  processInputs(torrentIds)
  torrentIds.forEach(torrentId => runDownload(torrentId))
} else if (command === 'downloadmeta') {
  const torrentIds = argv._.slice(1)
  processInputs(torrentIds)
  torrentIds.forEach(torrentId => runDownloadMeta(torrentId))
} else if (command === 'seed') {
  const inputs = argv._.slice(1)
  processInputs(inputs)
  inputs.forEach(input => runSeed(input))
} else if (command) {
  // assume command is "download" when not specified
  const torrentIds = argv._
  processInputs(torrentIds)
  torrentIds.forEach(torrentId => runDownload(torrentId))
} else {
  runHelp()
}

function processInputs (inputs) {
  numTorrents = inputs.length
  if (inputs.length === 1) return

  // These arguments do not make sense when downloading multiple torrents, or
  // seeding multiple files/folders.
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

  enableQuiet()
}

function runVersion () {
  console.log(`${webTorrentCliVersion} (${webTorrentVersion})`)
}

function runHelp () {
  fs.readFileSync(path.join(__dirname, 'ascii-logo.txt'), 'utf8')
    .split('\n')
    .forEach(line => clivas.line(
      `{bold:${line.substring(0, 20)}}{red:${line.substring(20)}}`))

  console.log(stripIndent`
    Usage:
      webtorrent [command] <torrent-id> <options>

    Example:
      webtorrent download "magnet:..." --vlc

    Commands:
      download <torrent-id...>  Download a torrent
      downloadmeta <torrent-id...> Download torrent metafile and save it usually from magnet link
      seed <file/folder...>     Seed a file or folder
      create <file/folder>      Create a .torrent file
      info <torrent-id>         Show info for a .torrent file or magnet uri

    Specify <torrent-id> as one of:
      * magnet uri
      * http url to .torrent file
      * filesystem path to .torrent file
      * info hash (hex string)

    Options (streaming):
      --airplay                 Apple TV
      --chromecast [name]       Chromecast [default: all]
      --dlna                    DLNA
      --iina                    IINA
      --mplayer                 MPlayer
      --mpv                     MPV
      --omx [jack]              omx [default: hdmi]
      --vlc                     VLC
      --xbmc                    XBMC

      Options (simple):
      -o, --out [path]          set download destination [default: current directory]
      -s, --select [index]      select specific file in torrent (omit index for file list)
      -t, --subtitles [path]    load subtitles file
      -h, --help                print this help text
      -v, --version             print the current version

      Options (advanced):
      --stdout                  standard out (implies --quiet)
      -p, --port [number]       change the http server port [default: 8000]
      -a, --announce [url]      tracker URL to announce to
      -b, --blocklist [path]    load blocklist file/http url
      -q, --quiet               don't show UI on stdout
      --torrent-port [number]   change the torrent seeding port [default: random]
      --dht-port [number]       change the dht port [default: random]
      --pip                     enter Picture-in-Picture if supported by the player
      --not-on-top              don't set "always on top" option in player
      --keep-seeding            don't quit when done downloading
      --no-quit                 don't quit when player exits
      --on-done [script]        run script after torrent download is done
      --on-exit [script]        run script before program exit
      --verbose                 show torrent protocol details
  `)
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
    numTorrents -= 1

    if (!argv.quiet) {
      const numActiveWires = torrent.wires
        .reduce((num, wire) => num + (wire.downloaded > 0), 0)

      clivas.line('')
      clivas.line(
        'torrent downloaded {green:successfully} from {bold:%s/%s} {green:peers} ' +
        'in {bold:%ss}!', numActiveWires, torrent.numPeers, getRuntime()
      )
    }

    if (argv['on-done']) {
      cp.exec(argv['on-done']).unref()
    }

    if (!playerName && !serving && argv.out && !argv['keep-seeding']) {
      torrent.destroy()

      if (numTorrents === 0) {
        gracefulExit()
      }
    }
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

        if (process.platform === 'win32') {
          openVLCWin32(vlcCmd)
        } else {
          openPlayer(`${vlcCmd} "${href}" ${VLC_ARGS}`)
        }
      })
    } else if (argv.iina) {
      openIINA(`${IINA_EXEC} "${href}"`, `iina://weblink?url=${href}`)
    } else if (argv.mplayer) {
      openPlayer(`${MPLAYER_EXEC} "${href}"`)
    } else if (argv.mpv) {
      openPlayer(`${MPV_EXEC} "${href}"`)
    } else if (argv.omx) {
      openPlayer(`${OMX_EXEC} "${href}"`)
    }

    function openPlayer (cmd) {
      cp.exec(cmd, err => {
        if (err) {
          const isMpvFalseError = playerName === 'mpv' && err.code === 4

          if (!isMpvFalseError) {
            return fatalError(err)
          }
        }
      }).on('exit', playerExit).unref()
    }

    function openIINA (cmd, href) {
      cp.exec(cmd, () => {
        open(href, { url: true })
      }).on('exit', playerExit)
        .unref()
    }

    function openVLCWin32 (vlcCommand) {
      const args = [].concat(href, VLC_ARGS.split(' '))

      cp.execFile(vlcCommand, args, err => {
        if (err) {
          return fatalError(err)
        }
      }).on('exit', playerExit).unref()
    }

    function playerExit () {
      if (argv.quit) {
        gracefulExit()
      }
    }

    if (argv.airplay) {
      const airplay = require('airplay-js')

      airplay.createBrowser()
        .on('deviceOn', device => device.play(href, 0, () => {}))
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
        .on('deviceOn', device => device.play(href, () => {}))
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

  const client = new WebTorrent({
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

let drawInterval
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

    if (seeding) line(`{green:Info hash: }${torrent.infoHash}`)

    const portInfo = []
    if (argv['torrent-port']) portInfo.push(`{green:Torrent port: }${argv['torrent-port']}`)
    if (argv['dht-port']) portInfo.push(`{green:DHT port: }${argv['dht-port']}`)
    if (portInfo.length) line(portInfo.join(' '))

    if (playerName) {
      line(`{green:Streaming to: }{bold:${playerName}}  {green:Server running at: }{bold:${href}}`)
    } else if (server) {
      line(`{green:Server running at: }{bold:${href}}`)
    }

    if (argv.out) {
      line(`{green:Downloading to: }{bold:${argv.out}}`)
    }

    line(`{green:Speed: }{bold:${
      prettierBytes(speed)
    }/s} {green:Downloaded:} {bold:${
      prettierBytes(torrent.downloaded)
    }}/{bold:${prettierBytes(torrent.length)}} {green:Uploaded:} {bold:${
      prettierBytes(torrent.uploaded)
    }}`)

    line(`{green:Running time:} {bold:${
      runtime
    }}  {green:Time remaining:} {bold:${
      estimate
    }}  {green:Peers:} {bold:${
      unchoked.length
    }/${
      torrent.numPeers
    }}`)

    if (argv.verbose) {
      line(`{green:Queued peers:} {bold:${
        torrent._numQueued
      }}  {green:Blocked peers:} {bold:${
        blockedPeers
      }}  {green:Hotswaps:} {bold:${
        hotswaps
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

function handleWarning (err) {
  console.warn(`Warning: ${err.message || err}`)
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
