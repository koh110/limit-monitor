import { renderToReadableStream } from 'react-dom/server'
import { type EntryContext, ServerRouter } from 'react-router'

/**
 * ssr: false のため server render は build 時の index.html 生成にのみ使う。
 * 既定 entry は Node stream 変換(@react-router/node)と bot 判定(isbot)を
 * 追加依存として要求するが、本番で配信するのは静的 asset だけなので
 * react-dom/server の Web Stream API だけで構成する。
 *
 * renderToString ではなく stream API を使うのは、`<html>` を root に持つ
 * render で React が `<!DOCTYPE html>` を自動で先頭に出すのがこちらだけの
 * ため(doctype 無しの index.html はブラウザが quirks mode で描画する)。
 * allReady を待つのは prerender された HTML を完全な形で書き出すため。
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext
) {
  let statusCode = responseStatusCode
  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        statusCode = 500
        console.error(error)
      }
    }
  )
  await stream.allReady

  responseHeaders.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(stream, {
    status: statusCode,
    headers: responseHeaders
  })
}
