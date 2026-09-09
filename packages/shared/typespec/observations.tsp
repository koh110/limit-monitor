import "@typespec/http";

using Http;

namespace LimitMonitor;

/**
 * observation payload 内の 1 bucket。
 *
 * envelope(Observation)側では `buckets` を `unknown[]` として受け取り、各要素を
 * この形で個別に検証する。bucket 単位の partial acceptance(不正な bucket が 1 件
 * あっても他の正常 bucket を破棄しない)を行うための意図的な分割である。
 */
model ObservationBucket {
  bucketId: BucketId;

  @minLength(1)
  @maxLength(32)
  label: string;

  usedPercent: Percent;
  remainingPercent: Percent;

  @minValue(1)
  @maxValue(31622400)
  windowDurationSeconds?: int32 | null;

  resetsAt?: utcDateTime | null;
  reached?: boolean;
}

model Observation {
  schemaVersion: SchemaVersion;
  provider: Provider;

  /**
   * 省略時は認証 token に紐づく accountAlias が採用される。明示する場合は
   * token 側の accountAlias と一致しなければ 403 で拒否される。
   */
  accountAlias?: AccountAlias;

  sourceId: SourceId;
  observedAt: utcDateTime;

  /** 各要素は ObservationBucket として個別に検証される(partial acceptance) */
  @minItems(1)
  @maxItems(16)
  buckets: unknown[];

  credits?: float64 | null;
}

model IngestSkipped {
  bucketId: BucketId;
  reason: "stale_observation";
}

model IngestRejected {
  /** payload の `buckets` 配列上の位置 */
  @minValue(0)
  index: int32;

  reason: string;
}

model IngestResult {
  schemaVersion: SchemaVersion;
  accepted: BucketId[];
  skipped: IngestSkipped[];
  rejected: IngestRejected[];
}

model IngestOkResponse {
  @statusCode statusCode: 200;
  @body body: IngestResult;
}

@route("/api/v1/observations")
interface ObservationsApi {
  /** Collector からの観測値登録 */
  @tag("Observations")
  @summary("ingestObservation")
  @post
  ingestObservation(
    @header("Authorization") authorization: string,
    @body body: Observation,
  ):
    | IngestOkResponse
    | BadRequestResponse
    | UnauthorizedResponse
    | ForbiddenResponse
    | ContentTooLargeResponse
    | TooManyRequestsResponse
    | InternalServerErrorResponse;
}
