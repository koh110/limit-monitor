import "@typespec/http";
import "@typespec/openapi";
import "./typespec/health.tsp";
import "./typespec/observations.tsp";
import "./typespec/status.tsp";

using Http;

@service(#{ title: "Limit Monitor Hub API" })
@TypeSpec.OpenAPI.info(#{ version: "0.1.0" })
namespace LimitMonitor;

/** 契約のバージョン。互換性を壊す変更で加算する(仕様 6.1) */
alias SchemaVersion = 1;

enum Provider {
  codex,
  claude,
  grok,
}

/** 生のアカウント ID / メールアドレスの混入を防ぐため `@` 等は許可しない */
@pattern("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
scalar AccountAlias extends string;

/** observation を送信したホストの識別子 */
@pattern("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
scalar SourceId extends string;

/** provider 固有の上限枠の識別子(例: `codex:primary`) */
@pattern("^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")
scalar BucketId extends string;

@minValue(0)
@maxValue(100)
scalar Percent extends float64;

/** RFC 9457 Problem Details for HTTP APIs */
@error
model BadRequestError {
  type: string;
  title: string;
  status: 400;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model UnauthorizedError {
  type: string;
  title: string;
  status: 401;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model ForbiddenError {
  type: string;
  title: string;
  status: 403;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model NotFoundError {
  type: string;
  title: string;
  status: 404;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model ContentTooLargeError {
  type: string;
  title: string;
  status: 413;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model TooManyRequestsError {
  type: string;
  title: string;
  status: 429;
  detail?: string;
}

/** RFC 9457 Problem Details for HTTP APIs */
@error
model InternalServerError {
  type: string;
  title: string;
  status: 500;
  detail?: string;
}

// エラーは `application/problem+json` で返す(`lib/wrap.ts` の createHttpException)。
// content type まで含めて契約に含めるため、response 側で contentType header を固定する。
model BadRequestResponse {
  @statusCode statusCode: 400;
  @header contentType: "application/problem+json";
  @body body: BadRequestError;
}

model UnauthorizedResponse {
  @statusCode statusCode: 401;
  @header contentType: "application/problem+json";
  @body body: UnauthorizedError;
}

model ForbiddenResponse {
  @statusCode statusCode: 403;
  @header contentType: "application/problem+json";
  @body body: ForbiddenError;
}

// 404 は個別の operation ではなく app.notFound が返すため response model は持たない。
// NotFoundError は shape を契約として公開するためだけに宣言している。

model ContentTooLargeResponse {
  @statusCode statusCode: 413;
  @header contentType: "application/problem+json";
  @body body: ContentTooLargeError;
}

model TooManyRequestsResponse {
  @statusCode statusCode: 429;
  @header contentType: "application/problem+json";
  @body body: TooManyRequestsError;
}

// 500(handleError の最終 fallback)と 404 は createHttpException を経由せず
// `c.json()` で返すため `application/json` になる。実装の挙動をそのまま契約にする。
model InternalServerErrorResponse {
  @statusCode statusCode: 500;
  @body body: InternalServerError;
}
