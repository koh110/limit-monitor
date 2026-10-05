import "@typespec/http";

using Http;

namespace LimitMonitor;

model BucketOrderRequest {
  provider: Provider;
  accountAlias: AccountAlias;

  @minItems(1)
  @maxItems(16)
  bucketOrder: BucketId[];
}

model BucketOrderResponse {
  schemaVersion: SchemaVersion;
  provider: Provider;
  accountAlias: AccountAlias;
  bucketOrder: BucketId[];
}

model BucketOrderOkResponse {
  @statusCode statusCode: 200;
  @body body: BucketOrderResponse;
}

@route("/api/v1/preferences/bucket-order")
interface PreferencesApi {
  /** アカウント内の bucket 表示順を SQLite に保存する */
  @tag("Preferences")
  @summary("saveBucketOrder")
  @put
  saveBucketOrder(@body body: BucketOrderRequest):
    | BucketOrderOkResponse
    | BadRequestResponse
    | UnauthorizedResponse
    | NotFoundResponse
    | ContentTooLargeResponse
    | InternalServerErrorResponse;
}
