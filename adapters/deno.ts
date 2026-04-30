import type { Hono } from "hono"
import type { RuntimeAdapter } from '../types.ts'
import { Log } from '../logger.ts'

export const denoAdapter: RuntimeAdapter = {
	name: 'deno',

	serve(app: Hono, opts: { host: string; port: number }) {
		const server = Deno.serve(
			{
				port: opts.port,
				hostname: opts.host,
				onListen: () => {
					console.log(`\n  ⬡  http://${opts.host}:${opts.port}\n`)
				},
			},
			app.fetch,
		)

		async function shutdown(): Promise<void> {
			Log.info('Shutting down...')
			await server.shutdown()
			await Log.flush()
			Deno.exit(0)
		}

		Deno.addSignalListener('SIGINT', shutdown)
		Deno.addSignalListener('SIGTERM', shutdown)
	},

	async readFile(path: string): Promise<string> {
		return await Deno.readTextFile(path)
	},

	async *readDir(path: string) {
		for await (const entry of Deno.readDir(path)) {
			yield {
				name: entry.name,
				isFile: entry.isFile,
				isDirectory: entry.isDirectory,
			}
		}
	},

	async writeFile(path: string, content: string): Promise<void> {
		await Deno.writeTextFile(path, content)
	},

	async mkdir(path: string): Promise<void> {
		await Deno.mkdir(path, { recursive: true })
	},

	async readBinary(path: string): Promise<Uint8Array> {
		return await Deno.readFile(path)
	},
}