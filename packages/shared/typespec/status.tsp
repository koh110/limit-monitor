import "@typespec/http";

using Http;

namespace LimitMonitor;

/** 最終観測からの経過で決まる鮮度(仕様 6.2)。`never` は行が存在しないため API には現れない */
enum Freshness {
  fresh,
  stale,
  expired,
}

model StatusBucket {
  bucketId: BucketId;
  label: string;
  usedPercent: Percent;
  remainingPercent: Percent;
  windowDurationSeconds: int32 | null;
  resetsAt: utcDateTime | null;
  observedAt: utcDateTime;

  /** ベンダーが返す「limit 到達」フラグ */
  reached: boolean;

  freshness: Freshness;
}

model StatusAccount {
  provider: Provider;
  accountAlias: AccountAlias;
  buckets: StatusBucket[];
}

model StatusResponse {
  schemaVersion: SchemaVersion;
  generatedAt: utcDateTime;
  accounts: StatusAccount[];
}

model StatusOkResponse {
  @statusCode statusCode: 200;
  @body body: StatusResponse;
}

@route("/api/v1/status")
interface StatusApi {
  /** 全 provider / 全アカウントの最新状態 */
  @tag("Status")
  @summary("getStatus")
  @get
  getStatus(): StatusOkResponse | InternalServerErrorResponse;

  /** provider を絞り込んだ最新状態 */
  @tag("Status")
  @summary("getStatusByProvider")
  @route("/{provider}")
  @get
  getStatusByProvider(@path provider: Provider):
    | StatusOkResponse
    | BadRequestResponse
    | InternalServerErrorResponse;
}
