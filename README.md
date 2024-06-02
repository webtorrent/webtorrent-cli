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
    <a href="https://github.com/webtorrent/webtorrent-cli/actions/workflows/ci.yml"><img src="https://github.com/webtorrent/webtorrent-cli/actions/workflows/ci.yml/badge.svg?branch=master" alt="ci"></a>
    <a href="https://npmjs.com/package/webtorrent-cli"><img src="https://img.shields.io/npm/v/webtorrent-cli.svg" alt="npm version"></a>
    <a href="https://npmjs.org/package/webtorrent-cli"><img src="https://img.shields.io/npm/dm/webtorrent-cli.svg" alt="npm downloads"></a>
    <a href="https://standardjs.com"><img src="https://img.shields.io/badge/code_style-standard-brightgreen.svg" alt="javascript style guide"></a>
</p>
<br>

**WebTorrent** is the first BitTorrent client that works in the **browser**, but `webtorrent-cli`,
i.e. *THIS PACKAGE*, is for using WebTorrent from the **command line**.

`webtorrent-cli` is a simple torrent client for use in node.js, as a command line app. It
uses TCP, UDP and WebRTC to talk to other torrent clients.

To use WebTorrent in the browser, see [`webtorrent`](https://www.npmjs.com/package/webtorrent).

### Features

- **Use [WebTorrent](https://webtorrent.io) from the command line!**
- **Insanely fast**
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
  - Check all the **[supported BEPs here](https://github.com/webtorrent/webtorrent/blob/master/docs/bep_support.md)**

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
  * info hash (hex string)

Commands:
  webtorrent download [torrent-ids...]      Download a torrent                             [default]
  webtorrent downloadmeta <torrent-ids...>  Download metadata of torrent
  webtorrent seed <inputs...>               Seed a file or a folder
  webtorrent create <input>                 Create a .torrent file
  webtorrent info <torrent-id>              Show torrent information
  webtorrent version                        Show version information
  webtorrent help                           Show help information

Options (streaming):
      --airplay     Apple TV                                                               [boolean]
      --chromecast  Google Chromecast                                                 [default: all]
      --dlna        DLNA                                                                   [boolean]
      --mplayer     MPlayer                                                                [boolean]
      --mpv         MPV                                                                    [boolean]
      --omx         OMX                                                              [default: hdmi]
      --vlc         VLC                                                                    [boolean]
      --iina        IINA                                                                   [boolean]
      --smplayer    SMPlayer                                                               [boolean]
      --xbmc        XBMC                                                                   [boolean]
      --stdout      Standard out (implies --quiet)                                         [boolean]

Options (simple):
  -o, --out                 Set download destination                                        [string]
  -s, --select              Select specific file in torrent                    [default: List files]
  -i, --interactive-select  Interactively select specific file in torrent                  [boolean]
  -t, --subtitles           Load subtitles file                                             [string]
  -h, --help                Show help information                                          [boolean]
  -v, --version             Show version information                                       [boolean]

Options (advanced)
  -p, --port            Change the http server port                         [number] [default: 8000]
  -b, --blocklist       Load blocklist file/url                                             [string]
  -a, --announce        Tracker URL to announce to                                          [string]
  -q, --quiet           Don't show UI on stdout                                            [boolean]
  -d, --download-limit  Maximum download speed in kb/s                 [number] [default: unlimited]
  -u, --upload-limit    Maximum upload speed in kb/s                   [number] [default: unlimited]
      --pip             Enter Picture-in-Picture if supported by the player                [boolean]
      --verbose         Show torrent protocol details                                      [boolean]
      --playlist        Open files in a playlist if supported by the player                [boolean]
      --player-args     Add player specific arguments (see example)                         [string]
      --torrent-port    Change the torrent seeding port                   [number] [default: random]
      --dht-port        Change the dht port                               [number] [default: random]
      --not-on-top      Don't set "always on top" option in player                         [boolean]
      --keep-seeding    Don't quit when done downloading                                   [boolean]
      --no-quit         Don't quit when player exits                                       [boolean]
      --on-done         Run script after torrent download is done                           [string]
      --on-exit         Run script before program exit                                      [string]
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
