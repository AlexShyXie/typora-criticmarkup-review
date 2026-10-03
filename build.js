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

console.log('build done -> dist/main.js, dist/style.css')
