import { Readable } from 'node:stream'
import {
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'

type R2Options = { range?: Headers | { offset?: number; length?: number; suffix?: number }; onlyIf?: { etagDoesNotMatch?: string } }

function requestedRange(range: R2Options['range'], size: number): { offset: number; length: number } | undefined {
  const raw = range instanceof Headers ? range.get('range') : undefined
  if (raw) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw)
    if (!match) return undefined
    const a = match[1], b = match[2]
    if (!a && !b) return undefined
    const offset = a ? Number(a) : Math.max(0, size - Number(b))
    const end = a ? (b ? Math.min(Number(b), size - 1) : size - 1) : size - 1
    if (offset >= size || end < offset) return undefined
    return { offset, length: end - offset + 1 }
  }
  if (range && !(range instanceof Headers)) {
    const offset = range.suffix === undefined ? range.offset ?? 0 : Math.max(0, size - range.suffix)
    if (offset >= size) return undefined
    return { offset, length: Math.min(range.length ?? size - offset, size - offset) }
  }
  return undefined
}

function webBody(body: unknown): ReadableStream<Uint8Array> {
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream()
  }
  return Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>
}

export class S3Bucket {
  readonly client: S3Client
  constructor(readonly bucket: string, config: { endpoint: string; accessKeyId: string; secretAccessKey: string; region: string }) {
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  }

  async head(key: string) {
    try {
      const item = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return this.metadata(item)
    } catch (error) { if (this.isMissing(error)) return null; throw error }
  }

  private metadata(item: { ETag?: string; ContentLength?: number; ContentType?: string; CacheControl?: string; ContentDisposition?: string; ContentEncoding?: string; Metadata?: Record<string, string> }) {
    const etag = (item.ETag ?? '').replace(/^"|"$/g, '')
    const httpMetadata = { contentType: item.ContentType, cacheControl: item.CacheControl, contentDisposition: item.ContentDisposition, contentEncoding: item.ContentEncoding }
    return { size: item.ContentLength ?? 0, etag, httpEtag: `"${etag}"`, httpMetadata, customMetadata: item.Metadata ?? {},
      writeHttpMetadata(headers: Headers) {
        if (httpMetadata.contentType) headers.set('content-type', httpMetadata.contentType)
        if (httpMetadata.cacheControl) headers.set('cache-control', httpMetadata.cacheControl)
        if (httpMetadata.contentDisposition) headers.set('content-disposition', httpMetadata.contentDisposition)
        if (httpMetadata.contentEncoding) headers.set('content-encoding', httpMetadata.contentEncoding)
      } }
  }

  async get(key: string, options: R2Options = {}) {
    const head = await this.head(key)
    if (!head) return null
    if (options.onlyIf?.etagDoesNotMatch?.replace(/^"|"$/g, '') === head.etag) return head
    const range = requestedRange(options.range, head.size)
    const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key,
      ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) }))
    const body = webBody(output.Body)
    return { ...head, range, body,
      arrayBuffer: () => new Response(body).arrayBuffer(),
      text: () => new Response(body).text() }
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, options: { httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string; contentEncoding?: string }; customMetadata?: Record<string, string> } = {}) {
    const body = typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Readable.fromWeb(value as never)
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body,
      ContentType: options.httpMetadata?.contentType, CacheControl: options.httpMetadata?.cacheControl,
      ContentDisposition: options.httpMetadata?.contentDisposition, ContentEncoding: options.httpMetadata?.contentEncoding,
      Metadata: options.customMetadata }))
    return this.head(key)
  }

  async delete(keys: string | string[]) {
    if (Array.isArray(keys)) {
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }))
    } else await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: keys }))
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: options.prefix,
      ContinuationToken: options.cursor, MaxKeys: options.limit }))
    return { objects: (result.Contents ?? []).map(item => ({ key: item.Key, size: item.Size, etag: item.ETag?.replace(/^"|"$/g, '') })),
      truncated: result.IsTruncated ?? false, cursor: result.NextContinuationToken }
  }

  async ping(): Promise<boolean> {
    try { await this.list({ limit: 1 }); return true } catch { return false }
  }

  private isMissing(error: unknown): boolean {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404
  }
}
