import * as fs from 'node:fs/promises'
import * as esbuild from 'esbuild'
import typoraPlugin from 'esbuild-plugin-typora'
import { sassPlugin } from 'esbuild-sass-plugin'

const isProduction = process.argv.slice(2).includes('--prod')

await fs.rm('./dist', { recursive: true, force: true })

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outdir: 'dist',
  format: 'esm',
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  plugins: [
    typoraPlugin({ mode: isProduction ? 'production' : 'development' }),
    sassPlugin(),
  ],
})

// dist/main.css is the raw sass output; `pack.js` renames it to style.css
// (and adds manifest.json) when composing the 3-file plugin package.
console.log('build done -> dist/main.js, dist/main.css')
