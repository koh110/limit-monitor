/**
 * newline 区切りの stream を行へ分解する decoder。
 * app-server のような長時間 stream から JSON-RPC message を取り出すために使う。
 * 1 行が maxBufferBytes を超えたら失敗として扱い、無制限のメモリ確保を防ぐ。
 */
export type LineDecoderResult =
  | { ok: true; lines: string[] }
  | { ok: false; reason: 'buffer_limit_exceeded'; detail: string }

export type LineDecoder = {
  push: (chunk: Buffer) => LineDecoderResult
}

export function createLineDecoder({ maxBufferBytes }: { maxBufferBytes: number }): LineDecoder {
  let buffered = Buffer.alloc(0)

  return {
    push: (chunk: Buffer): LineDecoderResult => {
      buffered = Buffer.concat([buffered, chunk])
      const lines: string[] = []
      let newlineIndex = buffered.indexOf(0x0a)
      while (newlineIndex >= 0) {
        const line = buffered.subarray(0, newlineIndex).toString('utf8')
        buffered = buffered.subarray(newlineIndex + 1)
        // CRLF を許容する
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (trimmed.length > 0) {
          lines.push(trimmed)
        }
        newlineIndex = buffered.indexOf(0x0a)
      }
      if (buffered.byteLength > maxBufferBytes) {
        return {
          ok: false,
          reason: 'buffer_limit_exceeded',
          detail: `pending line exceeded ${maxBufferBytes} bytes`
        }
      }
      return { ok: true, lines }
    }
  }
}
