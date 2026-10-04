import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import archiver from 'archiver'

/**
 * Package the built plugin.
 *
 * Every build leaves its artefacts in `out/` (git-ignored, see .gitignore):
 *   out/criticmarkup-review-<version>/    main.js + style.css + manifest.json
 *   out/criticmarkup-review-<version>.zip the installable archive
 *   out/latest/                           same three files, always current
 *   out/criticmarkup-review.zip           always-current archive
 *
 * The legacy root `criticmarkup-review.zip` is still refreshed.
 *
 * `--deliver` additionally copies `out/latest` into the local Typora plugin
 * folder (override with `TYPORA_PLUGIN_DIR`).
 */
const BASE = 'criticmarkup-review'
const DELIVERY_NAME = 'criticmarkup-review-delivery'
const DELIVERY_DIR = process.env.TYPORA_PLUGIN_DIR
  ?? 'C:\\Users\\xiehui\\.typora\\community-plugins\\plugins\\' + DELIVERY_NAME

const files = [
  { src: 'dist/main.js', name: 'main.js' },
  { src: 'dist/main.css', name: 'style.css' },
  { src: 'src/manifest.json', name: 'manifest.json' },
]

const manifest = JSON.parse(await fsp.readFile('src/manifest.json', 'utf8'))
const version = manifest.version ?? '0.0.0'

async function writeFlat(dir) {
  await fsp.mkdir(dir, { recursive: true })
  for (const f of files) {
    await fsp.copyFile(f.src, path.join(dir, f.name))
  }
}

async function writeZip(zipPath) {
  await fsp.mkdir(path.dirname(zipPath) || '.', { recursive: true })
  const output = fs.createWriteStream(zipPath)
  const archive = archiver('zip')
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve)
    archive.on('error', reject)
  })
  archive.pipe(output)
  for (const f of files) archive.file(f.src, { name: f.name })
  await archive.finalize()
  await done
}

await writeFlat(`out/${BASE}-${version}`)
await writeZip(`out/${BASE}-${version}.zip`)
await writeFlat('out/latest')
await writeZip(`out/${BASE}.zip`)
await writeZip(`./${BASE}.zip`)

if (process.argv.slice(2).includes('--deliver')) {
  await writeFlat(path.join(DELIVERY_DIR))
  console.log(`delivered -> ${path.join(DELIVERY_DIR)}`)
}

console.log(`packed v${version} -> out/${BASE}-${version}.zip, out/latest/, ./${BASE}.zip`)
