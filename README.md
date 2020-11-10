<h1 align="center">
  <br>
  <a href="https://webtorrent.io"><img src="https://webtorrent.io/img/WebTorrent.png" alt="WebTorrent" width="200"></a>
  <br>
  WebTorrent CLI
  <br>
  <br>
</h1>

<h4 align="center">The streaming torrent client. For the command line.</h4>

<p align="center">
    <a href="https://travis-ci.org/webtorrent/webtorrent-cli"><img src="https://img.shields.io/travis/webtorrent/webtorrent-cli/master.svg" alt="travis"></a>
    <a href="https://npmjs.com/package/webtorrent-cli"><img src="https://img.shields.io/npm/v/webtorrent-cli.svg" alt="npm version"></a>
    <a href="https://npmjs.org/package/webtorrent-cli"><img src="https://img.shields.io/npm/dm/webtorrent-cli.svg" alt="npm downloads"></a>
    <a href="https://standardjs.com"><img src="https://img.shields.io/badge/code_style-standard-brightgreen.svg" alt="javascript style guide"></a>
</p>
<br>

**WebTorrent** is the first BitTorrent client that works in the **browser**, but `webtorrent-cli`,
i.e. *THIS PACKAGE*, is for using WebTorrent from the **command line**.

`webtorrent-cli` is a simple torrent client for use in node.js, as a command line app. It
uses TCP and UDP to talk to other torrent clients.

**NOTE**: To connect to "web peers" (browsers) in addition to normal BitTorrent peers, use
[`webtorrent-hybrid`](https://www.npmjs.com/package/webtorrent-hybrid) which includes WebRTC
support for node.

To use WebTorrent in the browser, see [`webtorrent`](https://www.npmjs.com/package/webtorrent).

### Features

- **Use [WebTorrent](https://webtorrent.io) from the command line!**
- **Insanely fast**
- **Pure Javascript** (no native dependencies)
- Streaming
  - Stream to **AirPlay**, **Chromecast**, **VLC player**, **IINA**, and many other devices/players
  - Fetches pieces from the network on-demand so seeking is supported (even before torrent is finished)
  - Seamlessly switches between sequential and rarest-first piece selection strategy
- Supports advanced torrent client features
  - **magnet uri** support via **[ut_metadata](https://www.npmjs.com/package/ut_metadata)**
  - **peer discovery** via **[dht](https://www.npmjs.com/package/bittorrent-dht)**,
    **[tracker](https://www.npmjs.com/package/bittorrent-tracker)**, and
    **[ut_pex](https://www.npmjs.com/package/ut_pex)**
  - **[protocol extension api](https://www.npmjs.com/package/bittorrent-protocol#extension-api)**
    for adding new extensions

### Install

To install a `webtorrent` command line program, run:

```bash
npm install webtorrent-cli -g
```

### Usage

```bash
$ webtorrent --help
               _     _                            _
 __      _____| |__ | |_ ___  _ __ _ __ ___ _ __ | |_
 \ \ /\ / / _ \ '_ \| __/ _ \| '__| '__/ _ \ '_ \| __|
  \ V  V /  __/ |_) | || (_) | |  | | |  __/ | | | |_
   \_/\_/ \___|_.__/ \__\___/|_|  |_|  \___|_| |_|\__|

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
  --pip                     enter Picture-in-Picture if supported by the player
  --not-on-top              don't set "always on top" option in player
  --keep-seeding            don't quit when done downloading
  --no-quit                 don't quit when player exits
  --on-done [script]        run script after torrent download is done
  --on-exit [script]        run script before program exit
  --verbose                 show torrent protocol details
```

To download a torrent:

```bash
$ webtorrent magnet_uri
```

To stream a torrent to a device like **AirPlay** or **Chromecast**, just pass a flag:

```bash
$ webtorrent magnet_uri --airplay
```

In addition to magnet uris, webtorrent supports many ways to specify a torrent:

- magnet uri (string)
- torrent file (buffer)
- info hash (hex string or buffer)
- parsed torrent (from [parse-torrent](https://www.npmjs.com/package/parse-torrent))
- http/https url to a torrent file (string)
- filesystem path to a torrent file (string)

### License

MIT. Copyright (c) [Feross Aboukhadijeh](https://feross.org) and [WebTorrent, LLC](https://webtorrent.io).
