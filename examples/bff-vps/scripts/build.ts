import { build } from '@jayobado/hono-kit'

await build({
	entry: './client/main.ts',
	outDir: './dist',
	importMap: './deno.json',
	minify: true,
})