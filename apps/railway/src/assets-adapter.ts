import { readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
}

export class FileAssets {
  private readonly base: string
  constructor(directory: string, private readonly spa = false) { this.base = resolve(directory) }

  async fetch(input: Request | URL | string): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input)
    const pathname = new URL(request.url).pathname
    let decoded: string
    try { decoded = decodeURIComponent(pathname) } catch { return new Response(null, { status: 400 }) }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return new Response(null, { status: 404 })
    const file = resolve(this.base, `.${decoded}`)
    const rel = relative(this.base, file)
    if (rel.startsWith('..') || rel.includes(':') || rel.split(/[\\/]/).some(part => part.startsWith('.'))) return new Response(null, { status: 404 })
    const selected = await this.isFile(file) ? file : this.spa ? resolve(this.base, 'index.html') : undefined
    if (!selected || !await this.isFile(selected)) return new Response(null, { status: 404 })
    const info = await stat(selected)
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers = new Headers({ 'content-type': CONTENT_TYPES[extname(selected).toLowerCase()] ?? 'application/octet-stream', etag })
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(await readFile(selected), { headers })
  }

  private async isFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile() } catch { return false } }
}
