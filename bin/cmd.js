#!/usr/bin/env node
'use strict'

var clivas = require('clivas')
var cp = require('child_process')
var createTorrent = require('create-torrent')
var ecstatic = require('ecstatic')
var executable = require('executable')
var fs = require('fs')
var http = require('http')
var mime = require('mime')
var minimist = require('minimist')
var moment = require('moment')
var networkAddress = require('network-address')
var open = require('open')
var parseTorrent = require('parse-torrent')
var path = require('path')
var prettierBytes = require('prettier-bytes')
var vlcCommand = require('vlc-command')
var WebTorrent = require('webtorrent')

process.title = 'WebTorrent'

var expectedError = false
process.on('exit', function (code) {
  if (code === 0 || expectedError) return // normal exit
  if (code === 130) return // intentional exit with Control-C

  clivas.line('\n{red:UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!')
  clivas.line('{green:OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n')
  clivas.line(
    'DEBUG INFO: ' +
    'webtorrent-cli ' + require('../package.json').version + ', ' +
    'webtorrent ' + require('webtorrent/package.json').version + ', ' +
    'node ' + process.version + ', ' +
    process.platform + ' ' + process.arch + ', ' +
    'exit ' + code
  )
})

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

var argv = minimist(process.argv.slice(2), {
  alias: {
    p: 'port',
    b: 'blocklist',
    t: 'subtitles',
    s: 'select',
    o: 'out',
    a: 'announce',
    q: 'quiet',
    h: 'help',
    v: 'version'
  },
  boolean: [ // options that are always boolean
    'airplay',
    'chromecast',
    'mplayer',
    'mpv',
    'not-on-top',
    'vlc',
    'iina',
    'xbmc',
    'stdout',
    'quiet',
    'keep-seeding',
    'quit',
    'help',
    'version',
    'verbose'
  ],
  string: [ // options that are always strings
    'out',
    'announce',
    'blocklist',
    'subtitles',
    'on-done',
    'on-exit'
  ],
  default: {
    port: 8000,
    quit: true
  }
})

if (process.env.DEBUG || argv.stdout) {
  enableQuiet()
}
function enableQuiet () {
  argv.quiet = argv.q = true
}

var started = Date.now()
function getRuntime () {
  return Math.floor((Date.now() - started) / 1000)
}

var VLC_ARGS = '--play-and-exit --quiet'
if (process.env.DEBUG) {
  VLC_ARGS += ' --extraintf=http:logger --verbose=2 --file-logging --logfile=vlc-log.txt'
}
var MPLAYER_EXEC = 'mplayer -really-quiet -noidx -loop 0'
var MPV_EXEC = 'mpv --really-quiet --loop=no'
var OMX_EXEC = 'lxterminal -e omxplayer -r --timeout 60 --no-ghost-box --align center -o ' + (typeof argv.omx === 'string' ? argv.omx : 'hdmi')

var subtitlesServer
if (argv.subtitles) {
  VLC_ARGS += ' --sub-file=' + JSON.stringify(argv.subtitles)
  MPLAYER_EXEC += ' -sub ' + JSON.stringify(argv.subtitles)
  MPV_EXEC += ' --sub-file=' + JSON.stringify(argv.subtitles)
  OMX_EXEC += ' --subtitles ' + JSON.stringify(argv.subtitles)

  subtitlesServer = http.createServer(
    ecstatic({
      root: path.dirname(argv.subtitles),
      showDir: false
    })
  )
}

if (!argv['not-on-top']) {
  VLC_ARGS += ' --video-on-top'
  MPLAYER_EXEC += ' -ontop'
  MPV_EXEC += ' --ontop'
}

function checkPermission (filename) {
  try {
    if (!executable.sync(filename)) {
      errorAndExit('Script "' + filename + '" is not executable')
    }
  } catch (err) {
    errorAndExit('Script "' + filename + '" does not exist')
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

var playerName = argv.airplay ? 'Airplay'
  : argv.chromecast ? 'Chromecast'
  : argv.dlna ? 'DLNA'
  : argv.mplayer ? 'MPlayer'
  : argv.mpv ? 'mpv'
  : argv.omx ? 'OMXPlayer'
  : argv.vlc ? 'VLC'
  : argv.iina ? 'IINA'
  : argv.xbmc ? 'XBMC'
  : null

var command = argv._[0]

if (['info', 'create', 'download', 'add', 'seed'].indexOf(command) !== -1 && argv._.length === 1) {
  runHelp()
} else if (command === 'help' || argv.help) {
  runHelp()
} else if (command === 'version' || argv.version) {
  runVersion()
} else if (command === 'info') {
  if (argv._.length !== 2) {
    runHelp()
  } else {
    let torrentId = argv._[1]
    runInfo(torrentId)
  }
} else if (command === 'create') {
  if (argv._.length !== 2) {
    runHelp()
  } else {
    let input = argv._[1]
    runCreate(input)
  }
} else if (command === 'download' || command === 'add') {
  let torrentIds = argv._.slice(1)
  if (torrentIds.length > 1) handleMultipleInputs(torrentIds)
  torrentIds.forEach(function (torrentId) {
    runDownload(torrentId)
  })
} else if (command === 'seed') {
  let inputs = argv._.slice(1)
  if (inputs.length > 1) handleMultipleInputs(inputs)
  inputs.forEach(function (input) {
    runSeed(input)
  })
} else if (command) {
  // assume command is "download" when not specified
  let torrentIds = argv._
  if (torrentIds.length > 1) handleMultipleInputs(torrentIds)
  torrentIds.forEach(function (torrentId) {
    runDownload(torrentId)
  })
} else {
  runHelp()
}

function handleMultipleInputs (inputs) {
  // These arguments do not make sense when downloading multiple torrents, or
  // seeding multiple files/folders.
  let invalidArguments = [
    'airplay', 'chromecast', 'dlna', 'mplayer', 'mpv', 'omx', 'vlc', 'iina', 'xbmc',
    'stdout', 'select', 'subtitles'
  ]

  invalidArguments.forEach(function (arg) {
    if (argv[arg]) {
      errorAndExit(new Error(
        'The --' + arg + ' argument cannot be used with multiple files/folders.'
      ))
    }
  })

  enableQuiet()
}

function runVersion () {
  console.log(
    require('../package.json').version +
    ' (' + require('webtorrent/package.json').version + ')'
  )
}

function runHelp () {
  fs.readFileSync(path.join(__dirname, 'ascii-logo.txt'), 'utf8')
    .split('\n')
    .forEach(function (line) {
      clivas.line('{bold:' + line.substring(0, 20) + '}{red:' + line.substring(20) + '}')
    })

  console.log(function () {
  /*
Usage:
    webtorrent [command] <torrent-id> <options>

Example:
    webtorrent download "magnet:..." --vlc

Commands:
    download <torrent-id...>  Download a torrent
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
    --chromecast              Chromecast
    --dlna                    DLNA
    --mplayer                 MPlayer
    --mpv                     MPV
    --omx [jack]              omx [default: hdmi]
    --vlc                     VLC
    --iina                    IINA
    --xbmc                    XBMC
    --stdout                  standard out (implies --quiet)

Options (simple):
    -o, --out [path]          set download destination [default: current directory]
    -s, --select [index]      select specific file in torrent (omit index for file list)
    -t, --subtitles [path]    load subtitles file
    -v, --version             print the current version

Options (advanced):
    -p, --port [number]       change the http server port [default: 8000]
    -b, --blocklist [path]    load blocklist file/http url
    -a, --announce [url]      tracker URL to announce to
    -q, --quiet               don't show UI on stdout
    --not-on-top              don't set "always on top" option in player
    --keep-seeding            don't quit when done downloading
    --no-quit                 don't quit when player exits
    --on-done [script]        run script after torrent download is done
    --on-exit [script]        run script before program exit
    --verbose                 show torrent protocol details

  */
  }.toString().split(/\n/).slice(2, -2).join('\n'))
}

function runInfo (torrentId) {
  var parsedTorrent
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

  var output = JSON.stringify(parsedTorrent, undefined, 2)
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
  createTorrent(input, argv, function (err, torrent) {
    if (err) return errorAndExit(err)
    if (argv.out) {
      fs.writeFileSync(argv.out, torrent)
    } else {
      process.stdout.write(torrent)
    }
  })
}

var client, href, server, serving

function runDownload (torrentId) {
  if (!argv.out && !argv.stdout && !playerName) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({ blocklist: argv.blocklist })
  client.on('error', fatalError)

  var torrent = client.add(torrentId, { path: argv.out, announce: argv.announce })

  torrent.on('infoHash', function () {
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

    torrent.on('metadata', function () {
      clivas.clear()
      torrent.removeListener('wire', updateMetadata)

      clivas.clear()
      clivas.line('{green:verifying existing torrent data...}')
    })
  })

  torrent.on('done', function () {
    if (!argv.quiet) {
      var numActiveWires = torrent.wires.reduce(function (num, wire) {
        return num + (wire.downloaded > 0)
      }, 0)
      clivas.line('')
      clivas.line(
        'torrent downloaded {green:successfully} from {bold:%s/%s} {green:peers} ' +
        'in {bold:%ss}!',
        numActiveWires,
        torrent.numPeers,
        getRuntime()
      )
    }
    torrentDone()
  })

  // Start http server
  server = torrent.createServer()

  function initServer () {
    if (torrent.ready) onReady()
    else torrent.once('ready', onReady)
  }

  server.listen(argv.port, initServer)
    .on('error', function (err) {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        // If port is taken, pick one a free one automatically
        return server.listen(0, initServer)
      }
      fatalError(err)
    })

  server.once('connection', function () {
    serving = true
  })

  function onReady () {
    if (typeof argv.select === 'boolean') {
      clivas.line('Select a file to download:')
      torrent.files.forEach(function (file, i) {
        clivas.line(
          '{2+bold+magenta:%s} %s {blue:(%s)}',
          i, file.name, prettierBytes(file.length)
        )
      })
      clivas.line('\nTo select a specific file, re-run `webtorrent` with "--select [index]"')
      clivas.line('Example: webtorrent download "magnet:..." --select 0')
      return gracefulExit()
    }

    // if no index specified, use largest file
    var index = (typeof argv.select === 'number')
      ? argv.select
      : torrent.files.indexOf(torrent.files.reduce(function (a, b) {
        return a.length > b.length ? a : b
      }))
    onSelection(index)
  }

  function onSelection (index) {
    href = (argv.airplay || argv.chromecast || argv.xbmc || argv.dlna)
      ? 'http://' + networkAddress() + ':' + server.address().port + '/' + index
      : 'http://localhost:' + server.address().port + '/' + index

    if (playerName) torrent.files[index].select()
    if (argv.stdout) torrent.files[index].createReadStream().pipe(process.stdout)

    if (argv.vlc) {
      vlcCommand(function (err, vlcCmd) {
        if (err) return fatalError(err)
        if (process.platform === 'win32') {
          openVLCWin32(vlcCmd)
        } else {
          openPlayer(vlcCmd + ' ' + href + ' ' + VLC_ARGS)
        }
      })
    } else if (argv.iina) {
      open('iina://weblink?url=' + href)
    } else if (argv.mplayer) {
      openPlayer(MPLAYER_EXEC + ' ' + href)
    } else if (argv.mpv) {
      openPlayer(MPV_EXEC + ' ' + href)
    } else if (argv.omx) {
      openPlayer(OMX_EXEC + ' ' + href)
    }

    function openPlayer (cmd) {
      unref(cp.exec(cmd, function (err) {
        if (err) return fatalError(err)
      }).on('exit', playerExit))
    }

    function openVLCWin32 (vlcCommand) {
      var args = [].concat(href, VLC_ARGS.split(' '))
      unref(cp.execFile(vlcCommand, args, function (err) {
        if (err) return fatalError(err)
      }).on('exit', playerExit))
    }

    function playerExit () {
      if (argv['quit']) {
        gracefulExit()
      }
    }

    if (argv.airplay) {
      var airplay = require('airplay-js')
      airplay.createBrowser()
        .on('deviceOn', function (device) {
          device.play(href, 0, function () {})
        })
        .start()
    }

    if (argv.chromecast) {
      var chromecasts = require('chromecasts')()
      chromecasts.on('update', function (player) {
        player.play(href, {
          title: 'WebTorrent - ' + torrent.files[index].name
        })
        player.on('error', function (err) {
          err.message = 'Chromecast: ' + err.message
          errorAndExit(err)
        })
      })
    }

    if (argv.xbmc) {
      var xbmc = require('nodebmc')
      new xbmc.Browser()
        .on('deviceOn', function (device) {
          device.play(href, function () {})
        })
    }

    if (argv.dlna) {
      var dlnacasts = require('dlnacasts')()
      dlnacasts.on('update', function (player) {
        var opts = {
          title: 'WebTorrent - ' + torrent.files[index].name,
          type: mime.lookup(torrent.files[index].name)
        }

        if (argv.subtitles) {
          subtitlesServer.listen(0, function () {
            opts.subtitles = [
              'http://' + networkAddress() + ':' +
              subtitlesServer.address().port + '/' +
              encodeURIComponent(path.basename(argv.subtitles))
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

function runSeed (input) {
  if (path.extname(input).toLowerCase() === '.torrent' || /^magnet:/.test(input)) {
    // `webtorrent seed` is meant for creating a new torrent based on a file or folder
    // of content, not a torrent id (.torrent or a magnet uri). If this command is used
    // incorrectly, let's just do the right thing.
    runDownload(input)
    return
  }

  client = new WebTorrent({ blocklist: argv.blocklist })
  client.on('error', fatalError)

  client.seed(input, { announce: argv.announce }, function (torrent) {
    if (argv.quiet) console.log(torrent.magnetURI)
    drawTorrent(torrent)
  })
}

var drawInterval
function drawTorrent (torrent) {
  if (!argv.quiet) {
    process.stdout.write(Buffer.from('G1tIG1sySg==', 'base64')) // clear for drawing
    drawInterval = setInterval(draw, 1000)
    unref(drawInterval)
  }

  var hotswaps = 0
  torrent.on('hotswap', function () {
    hotswaps += 1
  })

  var blockedPeers = 0
  torrent.on('blockedPeer', function () {
    blockedPeers += 1
  })

  function draw () {
    var unchoked = torrent.wires.filter(function (wire) {
      return !wire.peerChoking
    })
    var linesRemaining = clivas.height
    var peerslisted = 0
    var speed = torrent.downloadSpeed
    var estimate = torrent.timeRemaining ? moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize() : 'N/A'
    var runtimeSeconds = getRuntime()
    var runtime = runtimeSeconds > 300 ? moment.duration(getRuntime(), 'seconds').humanize() : runtimeSeconds + ' seconds'
    var seeding = torrent.done

    clivas.clear()

    line(
      '{green:' + (seeding ? 'Seeding' : 'Downloading') + ': }' +
      '{bold:' + torrent.name + '}'
    )
    if (seeding) line('{green:Info hash: }' + torrent.infoHash)
    if (playerName) {
      line(
        '{green:Streaming to: }{bold:' + playerName + '}  ' +
        '{green:Server running at: }{bold:' + href + '}'
      )
    } else if (server) {
      line('{green:Server running at: }{bold:' + href + '}')
    }
    if (argv.out) line('{green:Downloading to: }{bold:' + argv.out + '}')
    line(
      '{green:Speed: }{bold:' + prettierBytes(speed) + '/s}  ' +
      '{green:Downloaded:} {bold:' + prettierBytes(torrent.downloaded) + '}' +
      '/{bold:' + prettierBytes(torrent.length) + '}  ' +
      '{green:Uploaded:} {bold:' + prettierBytes(torrent.uploaded) + '}'
    )
    line(
      '{green:Running time:} {bold:' + runtime + '}  ' +
      '{green:Time remaining:} {bold:' + estimate + '}  ' +
      '{green:Peers:} {bold:' + unchoked.length + '/' + torrent.numPeers + '}'
    )
    if (argv.verbose) {
      line(
        '{green:Queued peers:} {bold:' + torrent._numQueued + '}  ' +
        '{green:Blocked peers:} {bold:' + blockedPeers + '}  ' +
        '{green:Hotswaps:} {bold:' + hotswaps + '}'
      )
    }
    line('')

    torrent.wires.every(function (wire) {
      var progress = '?'
      if (torrent.length) {
        var bits = 0
        var piececount = Math.ceil(torrent.length / torrent.pieceLength)
        for (var i = 0; i < piececount; i++) {
          if (wire.peerPieces.get(i)) {
            bits++
          }
        }
        progress = bits === piececount ? 'S' : Math.floor(100 * bits / piececount) + '%'
      }

      var str = '{3:%s} {25+magenta:%s} {10:%s} {12+cyan:%s/s} {12+red:%s/s}'
      var args = [
        progress,
        wire.remoteAddress
          ? (wire.remoteAddress + ':' + wire.remotePort)
          : 'Unknown',
        prettierBytes(wire.downloaded),
        prettierBytes(wire.downloadSpeed()),
        prettierBytes(wire.uploadSpeed())
      ]
      if (argv.verbose) {
        str += ' {15+grey:%s} {10+grey:%s}'
        var tags = []
        if (wire.requests.length > 0) tags.push(wire.requests.length + ' reqs')
        if (wire.peerChoking) tags.push('choked')
        var reqStats = wire.requests.map(function (req) { return req.piece })
        args.push(tags.join(', '), reqStats.join(' '))
      }
      line.apply(undefined, [].concat(str, args))

      peerslisted += 1
      return linesRemaining > 4
    })

    line('{60:}')
    if (torrent.numPeers > peerslisted) {
      line('... and %s more', torrent.numPeers - peerslisted)
    }

    clivas.flush(true)

    function line () {
      clivas.line.apply(clivas, arguments)
      linesRemaining -= 1
    }
  }
}

function torrentDone () {
  if (argv['on-done']) unref(cp.exec(argv['on-done']))
  if (!playerName && !serving && argv.out && !argv['keep-seeding']) gracefulExit()
}

function fatalError (err) {
  clivas.line('{red:Error:} ' + (err.message || err))
  process.exit(1)
}

function errorAndExit (err) {
  clivas.line('{red:Error:} ' + (err.message || err))
  expectedError = true
  process.exit(1)
}

function gracefulExit () {
  process.removeListener('SIGINT', gracefulExit)
  process.removeListener('SIGTERM', gracefulExit)

  if (!client) return

  if (subtitlesServer) {
    subtitlesServer.close()
  }

  clivas.line('\n{green:webtorrent is exiting...}')

  clearInterval(drawInterval)

  if (argv['on-exit']) unref(cp.exec(argv['on-exit']))

  client.destroy(function (err) {
    if (err) return fatalError(err)

    // Quit after 1 second. This is only necessary for `webtorrent-hybrid` since
    // the `electron-webrtc` keeps the node process alive quit.
    unref(setTimeout(function () { process.exit(0) }, 1000))
  })
}

function unref (iv) {
  if (iv && typeof iv.unref === 'function') iv.unref()
}
