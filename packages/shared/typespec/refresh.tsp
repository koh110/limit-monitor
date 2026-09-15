import "@typespec/http";

using Http;

namespace LimitMonitor;

enum RefreshStatus {
  queued,
  dispatched,
  running,
  completed,
  failed,
}

@format("uuid")
scalar RequestId extends string;

model RefreshRequestBody {
  provider: Provider;
  accountAlias: AccountAlias;
}

model RefreshRequestResponse {
  schemaVersion: SchemaVersion;
  requestId: RequestId;
  status: RefreshStatus;
}

model RefreshAcceptedResponse {
  @statusCode statusCode: 202;
  @body body: RefreshRequestResponse;
}

model RefreshStatusOkResponse {
  @statusCode statusCode: 200;
  @body body: RefreshRequestResponse;
}

@route("/api/v1/refresh-requests")
interface RefreshApi {
  /** provider + accountAlias単位の手動refreshをdurable queueへ登録する */
  @tag("Refresh")
  @summary("createRefreshRequest")
  @post
  createRefreshRequest(@body body: RefreshRequestBody):
    | RefreshAcceptedResponse
    | BadRequestResponse
    | UnauthorizedResponse
    | ContentTooLargeResponse
    | NotFoundResponse
    | InternalServerErrorResponse;

  /** 手動refreshの状態を取得する */
  @tag("Refresh")
  @summary("getRefreshRequest")
  @route("/{requestId}")
  @get
  getRefreshRequest(@path requestId: RequestId):
    | RefreshStatusOkResponse
    | NotFoundResponse
    | InternalServerErrorResponse;
}
