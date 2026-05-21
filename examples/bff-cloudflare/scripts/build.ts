import { build } from '@jayobado/hono-kit'

await build({
	entry: './client/main.tsx',
	outDir: './dist',
	importMap: './deno.json',
	minify: true,
})