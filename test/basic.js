const cp = require('child_process')
const extend = require('xtend')
const fixtures = require('webtorrent-fixtures')
const parseTorrent = require('parse-torrent')
const path = require('path')
const spawn = require('cross-spawn')
const test = require('tape')
// const fs = require('fs')

const CMD_PATH = path.resolve(__dirname, '..', 'bin', 'cmd.js')
const CMD = `node ${CMD_PATH}`

test('Command line: webtorrent help', t => {
  t.plan(6)

  cp.exec(`${CMD} help`, (err, data) => {
    t.error(err) // no error, exit code 0
    t.ok(data.toLowerCase().includes('usage'))
  })

  cp.exec(`${CMD} --help`, (err, data) => {
    t.error(err) // no error, exit code 0
    t.ok(data.toLowerCase().includes('usage'))
  })

  cp.exec(CMD, (err, data) => {
    t.error(err) // no error, exit code 0
    t.ok(data.toLowerCase().includes('usage'))
  })
})

test('Command line: webtorrent version', t => {
  t.plan(6)
  const expectedVersion = `${require('../package.json').version}\n`

  cp.exec(`${CMD} version`, (err, data) => {
    t.error(err)
    t.ok(data.indexOf(expectedVersion))
  })

  cp.exec(`${CMD} --version`, (err, data) => {
    t.error(err)
    t.ok(data.indexOf(expectedVersion))
  })

  cp.exec(`${CMD} -v`, (err, data) => {
    t.error(err)
    t.ok(data.indexOf(expectedVersion))
  })
})

test('Command line: webtorrent info /path/to/file.torrent', t => {
  t.plan(3)

  cp.exec(`${CMD} info ${fixtures.leaves.torrentPath}`, (err, data) => {
    t.error(err)
    data = JSON.parse(data)
    const parsedTorrent = extend(fixtures.leaves.parsedTorrent)
    delete parsedTorrent.info
    delete parsedTorrent.infoBuffer
    delete parsedTorrent.infoHashBuffer
    t.deepEqual(data, JSON.parse(JSON.stringify(parsedTorrent, undefined, 2)))
  })

  cp.exec(`${CMD} info /bad/path`, err => {
    t.ok(err instanceof Error)
  })
})

test('Command line: webtorrent info magnet_uri', t => {
  t.plan(2)

  const leavesMagnetURI = 'magnet:?xt=urn:btih:d2474e86c95b19b8bcfdb92bc12c9d44667cfa36&dn=Leaves+of+Grass+by+Walt+Whitman.epub&tr=http%3A%2F%2Ftracker.example.com%2Fannounce&tr=http%3A%2F%2Ftracker.example2.com%2Fannounce&tr=udp%3A%2F%2Ftracker.example3.com%3A3310%2Fannounce&tr=udp%3A%2F%2Ftracker.example4.com%3A80&tr=udp%3A%2F%2Ftracker.example5.com%3A80&tr=udp%3A%2F%2Ftracker.example6.com%3A80'

  cp.exec(`${CMD} info "${leavesMagnetURI}"`, (err, data) => {
    t.error(err)
    data = JSON.parse(data)
    const parsedTorrent = parseTorrent(leavesMagnetURI)
    delete parsedTorrent.infoHashBuffer
    t.deepEqual(data, JSON.parse(JSON.stringify(parsedTorrent, undefined, 2)))
  })
})

test('Command line: webtorrent create /path/to/file', t => {
  t.plan(1)

  const child = spawn('node', [CMD_PATH, 'create', fixtures.leaves.contentPath])
  child.on('error', err => { t.fail(err) })

  const chunks = []
  child.stdout.on('data', chunk => {
    chunks.push(chunk)
  })
  child.stdout.on('end', () => {
    const buf = Buffer.concat(chunks)
    const parsedTorrent = parseTorrent(Buffer.from(buf, 'binary'))
    t.deepEqual(parsedTorrent.infoHash, 'd2474e86c95b19b8bcfdb92bc12c9d44667cfa36')
  })
})

test('Command line: webtorrent download <torrent file> (with local content)', t => {
  t.plan(2)

  const fixturesPath = path.join(path.dirname(require.resolve('webtorrent-fixtures')), 'fixtures')

  cp.exec(`${CMD} download ${fixtures.leaves.torrentPath} --out ${fixturesPath}`, (err, data) => {
    t.error(err)
    t.ok(data.includes('successfully'))
  })
})

// TODO: re-enable flaky test once we make it work more reliably
// test('Command line: webtorrent downloadmeta <torrent-id>', t => {
//   t.plan(2)

//   const fixturesPath = path.join(path.dirname(require.resolve('webtorrent-fixtures')), 'fixtures')

//   cp.exec(`${CMD} downloadmeta '${fixtures.sintel.magnetURI}' --out ${fixturesPath}`, (err, data) => {
//     t.error(err)
//     const parsedTorrent = parseTorrent(fs.readFileSync(`${fixturesPath}/${fixtures.sintel.parsedTorrent.infoHash}.torrent`))
//     // Sintel torrent file contain two fields not availaible from the DHT
//     const expectedTorrent = fixtures.sintel.parsedTorrent
//     delete expectedTorrent.created
//     delete expectedTorrent.createdBy
//     t.deepEqual(parsedTorrent, expectedTorrent)
//   })
// })
