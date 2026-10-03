import fs from 'node:fs'
import archiver from 'archiver'

const output = fs.createWriteStream('./criticmarkup-review.zip')
const archive = archiver('zip')

archive.pipe(output)
archive.file('./dist/main.js', { name: 'main.js' })
archive.file('./dist/main.css', { name: 'style.css' })
archive.file('./src/manifest.json', { name: 'manifest.json' })

await archive.finalize()
console.log('packed -> criticmarkup-review.zip')
